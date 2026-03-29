const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  UNSAFE_EXTS,
  RESERVED_NAMES,
  MAX_PATH_DEPTH,
  MAX_ASSETS_BYTES,
  MAX_ASSETS_FILES,
  isSafePathSegment,
  safePath,
  scanDir,
  getAssetsStats,
  registerAssets,
} = require("../nodes/lib/assets");

// ── Helpers ───────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "assets-test-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── A. Pure function tests ────────────────────────────────────

describe("isSafePathSegment", () => {
  it("accepts valid filenames", () => {
    expect(isSafePathSegment("image.png")).toBe(true);
    expect(isSafePathSegment("my-file_2.txt")).toBe(true);
    expect(isSafePathSegment("a")).toBe(true);
    expect(isSafePathSegment("a".repeat(255))).toBe(true);
  });

  it("rejects empty and non-string", () => {
    expect(isSafePathSegment("")).toBe(false);
    expect(isSafePathSegment(null)).toBe(false);
    expect(isSafePathSegment(undefined)).toBe(false);
    expect(isSafePathSegment(123)).toBe(false);
  });

  it("rejects segments longer than 255 chars", () => {
    expect(isSafePathSegment("a".repeat(256))).toBe(false);
  });

  it("rejects forbidden characters", () => {
    for (const ch of ["\\", ":", "*", "?", '"', "<", ">", "|", "\0"]) {
      expect(isSafePathSegment("file" + ch + "name")).toBe(false);
    }
  });

  it("rejects dotfiles", () => {
    expect(isSafePathSegment(".hidden")).toBe(false);
    expect(isSafePathSegment(".gitignore")).toBe(false);
  });

  it("rejects trailing dot and trailing space", () => {
    expect(isSafePathSegment("file.")).toBe(false);
    expect(isSafePathSegment("file ")).toBe(false);
  });

  it("rejects double-dot traversal", () => {
    expect(isSafePathSegment("..")).toBe(false);
  });

  it("rejects Windows reserved names", () => {
    expect(isSafePathSegment("CON")).toBe(false);
    expect(isSafePathSegment("CON.txt")).toBe(false);
    expect(isSafePathSegment("con")).toBe(false);
    expect(isSafePathSegment("NUL")).toBe(false);
    expect(isSafePathSegment("COM1")).toBe(false);
    expect(isSafePathSegment("LPT3")).toBe(false);
    expect(isSafePathSegment("LPT3.log")).toBe(false);
  });

  it("accepts near-miss reserved names", () => {
    expect(isSafePathSegment("CONX")).toBe(true);
    expect(isSafePathSegment("contest")).toBe(true);
    expect(isSafePathSegment("null-ish")).toBe(true);
  });
});

describe("constants", () => {
  it("UNSAFE_EXTS contains dangerous extensions", () => {
    expect(UNSAFE_EXTS.has(".html")).toBe(true);
    expect(UNSAFE_EXTS.has(".svg")).toBe(true);
    expect(UNSAFE_EXTS.has(".js")).toBe(true);
  });

  it("UNSAFE_EXTS does not contain safe extensions", () => {
    expect(UNSAFE_EXTS.has(".png")).toBe(false);
    expect(UNSAFE_EXTS.has(".jpg")).toBe(false);
    expect(UNSAFE_EXTS.has(".css")).toBe(false);
  });

  it("has correct limits", () => {
    expect(MAX_PATH_DEPTH).toBe(10);
    expect(MAX_ASSETS_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_ASSETS_FILES).toBe(1000);
  });
});

// ── B. Filesystem tests ──────────────────────────────────────

describe("safePath", () => {
  it("resolves valid relative path", () => {
    const result = safePath("images/photo.png", tmpDir);
    expect(result).toBe(path.join(tmpDir, "images", "photo.png"));
  });

  it("rejects null/empty/non-string", () => {
    expect(safePath(null, tmpDir)).toBeNull();
    expect(safePath("", tmpDir)).toBeNull();
    expect(safePath(123, tmpDir)).toBeNull();
  });

  it("rejects path with .. traversal", () => {
    expect(safePath("../etc/passwd", tmpDir)).toBeNull();
  });

  it("rejects path exceeding MAX_PATH_DEPTH", () => {
    const deep = Array(11).fill("d").join("/");
    expect(safePath(deep, tmpDir)).toBeNull();
  });

  it("accepts path at MAX_PATH_DEPTH", () => {
    const deep = Array(10).fill("d").join("/");
    expect(safePath(deep, tmpDir)).not.toBeNull();
  });

  it("rejects path with invalid segment", () => {
    expect(safePath("valid/CON/file.txt", tmpDir)).toBeNull();
    expect(safePath("valid/.hidden/file.txt", tmpDir)).toBeNull();
  });

  it("rejects symlink escape", () => {
    const linkDir = path.join(tmpDir, "escape");
    fs.symlinkSync("/tmp", linkDir);
    expect(safePath("escape", tmpDir)).toBeNull();
  });

  it("allows non-existent path (for mkdir/upload)", () => {
    const result = safePath("new-folder/new-file.txt", tmpDir);
    expect(result).toBe(path.join(tmpDir, "new-folder", "new-file.txt"));
  });
});

describe("scanDir", () => {
  it("returns empty array for empty directory", () => {
    expect(scanDir(tmpDir, "")).toEqual([]);
  });

  it("lists files with metadata", () => {
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello");
    const result = scanDir(tmpDir, "");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test.txt");
    expect(result[0].type).toBe("file");
    expect(result[0].size).toBe(5);
    expect(result[0].mtime).toBeGreaterThan(0);
  });

  it("lists nested directories and files", () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "sub", "inner.txt"), "data");
    fs.writeFileSync(path.join(tmpDir, "root.txt"), "root");
    const result = scanDir(tmpDir, "");
    const names = result.map((r) => r.name);
    expect(names).toContain("sub");
    expect(names).toContain("sub/inner.txt");
    expect(names).toContain("root.txt");
    expect(result.find((r) => r.name === "sub").type).toBe("dir");
  });

  it("skips symlinks", () => {
    fs.writeFileSync(path.join(tmpDir, "real.txt"), "real");
    fs.symlinkSync(path.join(tmpDir, "real.txt"), path.join(tmpDir, "link.txt"));
    const result = scanDir(tmpDir, "");
    const names = result.map((r) => r.name);
    expect(names).toContain("real.txt");
    expect(names).not.toContain("link.txt");
  });
});

describe("getAssetsStats", () => {
  it("returns zeros for empty directory", () => {
    expect(getAssetsStats(tmpDir)).toEqual({ size: 0, count: 0 });
  });

  it("counts files and sums sizes", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello"); // 5 bytes
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "world!"); // 6 bytes
    expect(getAssetsStats(tmpDir)).toEqual({ size: 11, count: 2 });
  });

  it("counts nested files", () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "sub", "deep.txt"), "abc");
    fs.writeFileSync(path.join(tmpDir, "top.txt"), "xy");
    const stats = getAssetsStats(tmpDir);
    expect(stats.count).toBe(2);
    expect(stats.size).toBe(5);
  });

  it("skips symlinks", () => {
    fs.writeFileSync(path.join(tmpDir, "real.txt"), "data");
    fs.symlinkSync(path.join(tmpDir, "real.txt"), path.join(tmpDir, "link.txt"));
    const stats = getAssetsStats(tmpDir);
    expect(stats.count).toBe(1);
    expect(stats.size).toBe(4);
  });
});

// ── C. HTTP route tests ──────────────────────────────────────

describe("HTTP endpoints", () => {
  let app;

  beforeEach(() => {
    const mockRED = {
      httpAdmin: express.Router(),
      httpNode: express.Router(),
      log: { error: vi.fn() },
    };
    registerAssets(mockRED, express, tmpDir);
    app = express();
    app.use(mockRED.httpNode);
    app.use(mockRED.httpAdmin);
  });

  describe("GET /portal-react/assets", () => {
    it("returns empty array for empty dir", async () => {
      const res = await request(app).get("/portal-react/assets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns file listing", async () => {
      fs.writeFileSync(path.join(tmpDir, "test.txt"), "hi");
      const res = await request(app).get("/portal-react/assets");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("test.txt");
    });
  });

  describe("POST /portal-react/assets/mkdir", () => {
    it("creates directory", async () => {
      const res = await request(app)
        .post("/portal-react/assets/mkdir")
        .send({ path: "new-dir" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(path.join(tmpDir, "new-dir"))).toBe(true);
    });

    it("returns 400 for invalid path", async () => {
      const res = await request(app)
        .post("/portal-react/assets/mkdir")
        .send({ path: "../escape" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /portal-react/assets/move", () => {
    it("renames file", async () => {
      fs.writeFileSync(path.join(tmpDir, "old.txt"), "data");
      const res = await request(app)
        .post("/portal-react/assets/move")
        .send({ from: "old.txt", to: "new.txt" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(path.join(tmpDir, "new.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "old.txt"))).toBe(false);
    });

    it("returns 400 for invalid from path", async () => {
      const res = await request(app)
        .post("/portal-react/assets/move")
        .send({ from: "../bad", to: "ok.txt" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /portal-react/assets/upload/*", () => {
    it("uploads file", async () => {
      const res = await request(app)
        .post("/portal-react/assets/upload/photo.png")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("fake-png-data"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(tmpDir, "photo.png"), "utf8")).toBe("fake-png-data");
    });

    it("returns 400 for invalid path", async () => {
      const res = await request(app)
        .post("/portal-react/assets/upload/.hidden")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("bad"));
      expect(res.status).toBe(400);
    });

    it("uploads into nested directory", async () => {
      const res = await request(app)
        .post("/portal-react/assets/upload/sub/dir/file.bin")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("nested"));
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(tmpDir, "sub", "dir", "file.bin"))).toBe(true);
    });
  });

  describe("DELETE /portal-react/assets/*", () => {
    it("deletes existing file", async () => {
      fs.writeFileSync(path.join(tmpDir, "del.txt"), "bye");
      const res = await request(app).delete("/portal-react/assets/del.txt");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(path.join(tmpDir, "del.txt"))).toBe(false);
    });

    it("returns 400 for invalid path", async () => {
      const res = await request(app).delete("/portal-react/assets/..%2Fetc");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /portal-react/assets/download/*", () => {
    it("downloads file with correct headers", async () => {
      fs.writeFileSync(path.join(tmpDir, "dl.txt"), "content");
      const res = await request(app).get("/portal-react/assets/download/dl.txt");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("dl.txt");
      expect(res.text).toBe("content");
    });

    it("returns 400 for directory download", async () => {
      fs.mkdirSync(path.join(tmpDir, "adir"));
      const res = await request(app).get("/portal-react/assets/download/adir");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("is a directory");
    });

    it("returns 404 for non-existent file", async () => {
      const res = await request(app).get("/portal-react/assets/download/nope.txt");
      expect(res.status).toBe(404);
    });
  });

  describe("security middleware /fromcubes/public", () => {
    it("serves static file with security headers", async () => {
      fs.writeFileSync(path.join(tmpDir, "image.png"), "PNG");
      const res = await request(app).get("/fromcubes/public/image.png");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
      expect(res.headers["content-disposition"]).toBeUndefined();
    });

    it("forces attachment for unsafe extensions", async () => {
      fs.writeFileSync(path.join(tmpDir, "page.html"), "<h1>hi</h1>");
      const res = await request(app).get("/fromcubes/public/page.html");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe("attachment");
    });

    it("forces attachment for .svg", async () => {
      fs.writeFileSync(path.join(tmpDir, "icon.svg"), "<svg></svg>");
      const res = await request(app).get("/fromcubes/public/icon.svg");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe("attachment");
    });
  });
});

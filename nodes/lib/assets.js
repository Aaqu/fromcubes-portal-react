/**
 * Portal Assets — static file serving with security validation.
 *
 * Exports pure validation functions (for testing) and a registerAssets factory
 * that mounts Express routes on RED.httpAdmin / RED.httpNode.
 */

const fs = require("fs");
const path = require("path");

// ── Constants ─────────────────────────────────────────────────

const UNSAFE_EXTS = new Set([".html", ".htm", ".svg", ".js", ".mjs", ".xml", ".xhtml"]);
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;
const MAX_PATH_DEPTH = 10;
const MAX_ASSETS_BYTES = 500 * 1024 * 1024; // 500 MB total
const MAX_ASSETS_FILES = 1000;

// ── Pure validators ───────────────────────────────────────────

function isSafePathSegment(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 255 &&
    !/[\\:*?"<>|\0]/.test(s) &&
    !s.startsWith(".") &&
    !s.endsWith(".") &&
    !s.endsWith(" ") &&
    s !== ".." &&
    !RESERVED_NAMES.test(s)
  );
}

function safePath(rel, assetsDir) {
  if (!rel || typeof rel !== "string") return null;
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_PATH_DEPTH) return null;
  if (!segments.every(isSafePathSegment)) return null;
  const resolved = path.resolve(assetsDir, ...segments);
  if (!resolved.startsWith(assetsDir + path.sep) && resolved !== assetsDir)
    return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(assetsDir + path.sep) && real !== assetsDir)
      return null;
  } catch (_e) { /* path doesn't exist yet — OK for mkdir/upload */ }
  return resolved;
}

// ── Filesystem helpers ────────────────────────────────────────

function scanDir(dir, prefix) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      results.push({ name: rel, type: "dir" });
      results.push(...scanDir(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      const stat = fs.statSync(path.join(dir, entry.name));
      results.push({ name: rel, type: "file", size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return results;
}

function getAssetsStats(assetsDir) {
  let size = 0, count = 0;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { size += fs.statSync(p).size; count++; }
    }
  }
  try { walk(assetsDir); } catch (_e) { /* ignore */ }
  return { size, count };
}

// ── Route registration ────────────────────────────────────────

function registerAssets(RED, express, assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });

  // Security middleware for public serving
  RED.httpNode.use(
    "/fromcubes/public",
    (req, res, next) => {
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "default-src 'none'");
      const ext = path.extname(req.path).toLowerCase();
      if (UNSAFE_EXTS.has(ext)) {
        res.set("Content-Disposition", "attachment");
      }
      next();
    },
    express.static(assetsDir, { maxAge: "1d" }),
  );

  // List assets
  RED.httpAdmin.get("/portal-react/assets", (_req, res) => {
    try {
      res.json(scanDir(assetsDir, ""));
    } catch (e) {
      res.json([]);
    }
  });

  // Create directory
  RED.httpAdmin.post("/portal-react/assets/mkdir", express.json(), (req, res) => {
    const target = safePath(req.body && req.body.path, assetsDir);
    if (!target) return res.status(400).json({ error: "invalid path" });
    try {
      fs.mkdirSync(target, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      RED.log.error("portal-react assets mkdir: " + e.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  // Move / rename
  RED.httpAdmin.post("/portal-react/assets/move", express.json(), (req, res) => {
    const from = safePath(req.body && req.body.from, assetsDir);
    const to = safePath(req.body && req.body.to, assetsDir);
    if (!from || !to) return res.status(400).json({ error: "invalid path" });
    const toName = path.basename(to);
    if (!toName || !toName.trim()) return res.status(400).json({ error: "name cannot be empty" });
    try {
      const toDir = path.dirname(to);
      fs.mkdirSync(toDir, { recursive: true });
      fs.renameSync(from, to);
      res.json({ ok: true });
    } catch (e) {
      RED.log.error("portal-react assets move: " + e.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  // Upload
  RED.httpAdmin.post(
    "/portal-react/assets/upload/*",
    express.raw({ type: "*/*", limit: "100mb" }),
    (req, res) => {
      const rel = req.params[0];
      const target = safePath(rel, assetsDir);
      if (!target) return res.status(400).json({ error: "invalid path" });
      const stats = getAssetsStats(assetsDir);
      if (stats.size + req.body.length > MAX_ASSETS_BYTES)
        return res.status(413).json({ error: "storage limit exceeded (500MB)" });
      if (stats.count >= MAX_ASSETS_FILES)
        return res.status(413).json({ error: "file count limit exceeded (1000)" });
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, req.body);
        res.json({ ok: true });
      } catch (e) {
        RED.log.error("portal-react assets upload: " + e.message);
        res.status(500).json({ error: "internal error" });
      }
    },
  );

  // Delete
  RED.httpAdmin.delete("/portal-react/assets/*", (req, res) => {
    const rel = req.params[0];
    const target = safePath(rel, assetsDir);
    if (!target) return res.status(400).json({ error: "invalid path" });
    try {
      fs.rmSync(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      RED.log.error("portal-react assets delete: " + e.message);
      res.status(404).json({ error: "not found" });
    }
  });

  // Download
  RED.httpAdmin.get("/portal-react/assets/download/*", (req, res) => {
    const rel = req.params[0];
    const target = safePath(rel, assetsDir);
    if (!target) return res.status(400).json({ error: "invalid path" });
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) return res.status(400).json({ error: "is a directory" });
      const filename = path.basename(target);
      res.set({
        "Content-Disposition": 'attachment; filename="' + filename.replace(/"/g, '\\"') + '"',
        "Content-Length": stat.size,
      });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      res.status(404).json({ error: "not found" });
    }
  });
}

module.exports = {
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
};

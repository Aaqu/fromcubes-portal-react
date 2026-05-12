/**
 * @module nodes/lib/assets
 *
 * Portal Assets — static file serving with security validation.
 *
 * Exports pure validators (for unit-testing without RED) and a
 * `registerAssets` factory that mounts Express routes on `RED.httpAdmin`
 * (admin CRUD, auth-gated) and `RED.httpNode` (public read-only serving).
 *
 * @typedef {Object} AssetEntry
 * @property {string} name             Relative path (POSIX, forward slashes).
 * @property {"file"|"dir"} type
 * @property {number} [size]           Bytes — file only.
 * @property {number} [mtime]          fs.statSync.mtimeMs — file only.
 *
 * @typedef {Object} AssetsStats
 * @property {number} size             Total bytes across all files (excluding symlinks).
 * @property {number} count            Total file count.
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

// Combined relative-path cap. MAX_PATH_DEPTH=10 segments already constrains
// fan-out; this bounds total characters so an attacker can't craft a 10-segment
// path of 255-char names (~2.5 KB) that defeats higher-level URL length checks.
const MAX_REL_PATH_LEN = 1024;

/**
 * Resolve a user-supplied relative path against `assetsDir`, applying every
 * layer of path-traversal protection:
 *
 *  1. Non-empty string input.
 *  2. Total length ≤ MAX_REL_PATH_LEN bytes.
 *  3. Split on "/" and reject empty segments — `..`, `.`, `\0`, Windows
 *     reserved names (CON/PRN/AUX/NUL/COM1-9/LPT1-9), invalid characters,
 *     dotfiles, names ending in space/dot, length > 255 — see
 *     `isSafePathSegment`.
 *  4. Segment count ≤ MAX_PATH_DEPTH.
 *  5. After `path.resolve`, the resulting absolute path must stay inside
 *     `assetsDir + path.sep`.
 *  6. If the path already exists on disk, `fs.realpathSync` must also stay
 *     inside `assetsDir` — blocks symlink-escape attacks.
 *
 * @param {string} rel
 * @param {string} assetsDir
 * @returns {string|null}  Absolute resolved path, or null if any check fails.
 */
function safePath(rel, assetsDir) {
  if (!rel || typeof rel !== "string") return null;
  if (rel.length > MAX_REL_PATH_LEN) return null;
  if (rel.indexOf("\0") !== -1) return null;
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

/**
 * Resolve a `RED.auth.needsPermission(scope)` middleware, with a no-op fallback
 * for runtimes (older Node-RED versions / test harnesses) where `RED.auth` is
 * absent. Admin endpoints would otherwise be unprotected when an editor
 * `adminAuth` is configured.
 *
 * @param {Object} RED
 * @param {string} scope  Permission name, e.g. `"portal-react.write"`.
 * @returns {Function}    Express middleware.
 */
function authMiddleware(RED, scope) {
  if (RED.auth && typeof RED.auth.needsPermission === "function") {
    return RED.auth.needsPermission(scope);
  }
  return function (_req, _res, next) { next(); };
}

/**
 * Mount the Assets HTTP API on Node-RED's admin (write paths, auth-gated) and
 * node (public read-only static) HTTP routers.
 *
 * @param {Object} RED                 Node-RED runtime object.
 * @param {import('express')} express  Express factory (for json/raw/static).
 * @param {string} assetsDir           Absolute filesystem path of the assets root.
 * @param {Object} [opts]              Optional middleware hooks supplied by the
 *                                     host module (CSRF, rate-limit) so the
 *                                     same protections apply to assets POSTs.
 * @param {Function} [opts.csrfGuard]
 * @param {Function} [opts.rateLimit]
 * @param {string}   [opts.jsonLimit]  Body-parser limit (default "1mb").
 * @returns {void}
 *
 * @fires RED.log#info on first-time directory creation
 *
 * @example
 *   const { registerAssets } = require("./lib/assets");
 *   registerAssets(RED, require("express"), path.join(userDir, "fromcubes", "public"));
 */
function registerAssets(RED, express, assetsDir, opts) {
  fs.mkdirSync(assetsDir, { recursive: true });

  const READ = authMiddleware(RED, "portal-react.read");
  const WRITE = authMiddleware(RED, "portal-react.write");
  const passthrough = (_req, _res, next) => next();
  const csrfGuard = (opts && opts.csrfGuard) || passthrough;
  const rateLimit = (opts && opts.rateLimit) || passthrough;
  const jsonLimit = (opts && opts.jsonLimit) || "1mb";

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
    // dotfiles: 'deny' → never serve .git/, .htaccess, .env, etc. that may
    // have been written into assetsDir by mistake. fallthrough: false makes
    // express.static return 404 directly instead of leaking to the next mw.
    express.static(assetsDir, { maxAge: "1d", dotfiles: "deny", fallthrough: false }),
  );

  // List assets
  RED.httpAdmin.get("/portal-react/assets", READ, (_req, res) => {
    try {
      res.json(scanDir(assetsDir, ""));
    } catch (e) {
      RED.log.error("portal-react assets list: " + e.message);
      res.json([]);
    }
  });

  // Create directory
  RED.httpAdmin.post("/portal-react/assets/mkdir", WRITE, csrfGuard, rateLimit, express.json({ limit: jsonLimit }), (req, res) => {
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
  RED.httpAdmin.post("/portal-react/assets/move", WRITE, csrfGuard, rateLimit, express.json({ limit: jsonLimit }), (req, res) => {
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

  // Upload — 100mb cap is intentionally higher than json/text endpoints.
  RED.httpAdmin.post(
    "/portal-react/assets/upload/*",
    WRITE,
    csrfGuard,
    rateLimit,
    express.raw({ type: "*/*", limit: "100mb" }),
    (req, res) => {
      const rel = req.params[0];
      const target = safePath(rel, assetsDir);
      if (!target) return res.status(400).json({ error: "invalid path" });
      // Guard: when nothing was uploaded (Content-Length 0 or wrong type),
      // express.raw yields an empty {} object instead of a Buffer.
      const bodyLen = Buffer.isBuffer(req.body) ? req.body.length : 0;
      if (bodyLen === 0) {
        return res.status(400).json({ error: "empty upload" });
      }
      const stats = getAssetsStats(assetsDir);
      if (stats.size + bodyLen > MAX_ASSETS_BYTES)
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
  RED.httpAdmin.delete("/portal-react/assets/*", WRITE, csrfGuard, rateLimit, (req, res) => {
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
  RED.httpAdmin.get("/portal-react/assets/download/*", READ, (req, res) => {
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
  MAX_REL_PATH_LEN,
  MAX_ASSETS_BYTES,
  MAX_ASSETS_FILES,
  isSafePathSegment,
  safePath,
  scanDir,
  getAssetsStats,
  registerAssets,
};

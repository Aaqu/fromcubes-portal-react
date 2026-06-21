const path = require("path");

/**
 * Register editor/admin/public support routes for portal-react.
 *
 * This module intentionally owns only HTTP route registration. Runtime page
 * state and registries remain owned by portal-react.js and are passed in so
 * deploy/rebuild lifecycle stays in one place.
 *
 * @param {Object} RED
 * @param {Object} deps
 * @param {import("express")} deps.express
 * @param {Function} deps.permRead
 * @param {Function} deps.permWrite
 * @param {Function} deps.csrfGuard
 * @param {Function} deps.rateLimit
 * @param {string} deps.jsonBodyLimit
 * @param {string} deps.userDir
 * @param {Object<string, Object>} deps.pageState
 * @param {Object<string, Object>} deps.registry
 * @param {Object<string, Object>} deps.utilities
 * @param {(code: string) => Set<string>} deps.extractUtilitySymbols
 * @returns {void}
 */
function registerAdminApi(RED, deps) {
  const {
    express,
    permRead,
    permWrite,
    csrfGuard,
    rateLimit,
    jsonBodyLimit,
    userDir,
    pageState,
    registry,
    utilities,
    extractUtilitySymbols,
  } = deps;

  const monacoPath = path.dirname(
    require.resolve("monaco-editor/package.json"),
  );
  RED.httpAdmin.use(
    "/portal-react/vs",
    permRead,
    express.static(path.join(monacoPath, "min", "vs")),
  );

  const { generateCandidates } = require("../tw-candidates");
  let twClassesCache = null;
  RED.httpAdmin.get("/portal-react/tw-classes", permRead, (_req, res) => {
    if (!twClassesCache) {
      twClassesCache = generateCandidates();
    }
    res.json(twClassesCache);
  });

  const CSS_HASH_RE = /^[a-f0-9]{1,64}$/;
  function findCssByHash(reqHash) {
    for (const ep in pageState) {
      if (pageState[ep]?.cssHash === reqHash) return pageState[ep].css;
    }
    return null;
  }
  function serveCss(req, res) {
    const reqHash = req.params.hash;
    if (!CSS_HASH_RE.test(reqHash)) {
      res.status(400).send("Bad request");
      return;
    }
    const css = findCssByHash(reqHash);
    if (!css) {
      res.status(404).send("Not found");
      return;
    }
    res.set({
      "Content-Type": "text/css",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(css);
  }

  RED.httpNode.get("/fromcubes/css/:hash.css", serveCss);
  RED.httpAdmin.get("/portal-react/css/:hash.css", serveCss);

  const { registerAssets } = require("./assets");
  registerAssets(RED, express, path.join(userDir, "fromcubes", "public"), {
    csrfGuard,
    rateLimit,
    jsonLimit: jsonBodyLimit,
  });

  RED.httpAdmin.get("/portal-react/registry", permRead, (_req, res) => {
    res.json(registry);
  });

  RED.httpAdmin.post(
    "/portal-react/registry",
    permWrite,
    csrfGuard,
    rateLimit,
    express.json({ limit: jsonBodyLimit }),
    (_req, res) => {
      res.status(410).json({
        error: "registry writes are deprecated; use fc-portal-component nodes",
      });
    },
  );

  RED.httpAdmin.delete(
    "/portal-react/registry/:name",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "registry writes are deprecated; use fc-portal-component nodes",
      });
    },
  );

  RED.httpAdmin.get("/portal-react/utilities", permRead, (_req, res) => {
    const out = {};
    for (const [name, u] of Object.entries(utilities)) {
      out[name] = {
        code: u.code,
        error: u.error || null,
        symbols: [...extractUtilitySymbols(u.code || "")],
      };
    }
    res.json(out);
  });

  RED.httpAdmin.post(
    "/portal-react/utilities",
    permWrite,
    csrfGuard,
    rateLimit,
    express.json({ limit: jsonBodyLimit }),
    (_req, res) => {
      res.status(410).json({
        error: "utility writes are deprecated; use fc-portal-utility nodes",
      });
    },
  );

  RED.httpAdmin.delete(
    "/portal-react/utilities/:name",
    permWrite,
    csrfGuard,
    rateLimit,
    (_req, res) => {
      res.status(410).json({
        error: "utility writes are deprecated; use fc-portal-utility nodes",
      });
    },
  );
}

module.exports = { registerAdminApi };

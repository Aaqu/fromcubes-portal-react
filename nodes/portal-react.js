/**
 * @aaqu/fromcubes-portal-react
 *
 * Node-RED node that serves React apps from configurable HTTP endpoints
 * with live WebSocket data binding. JSX is transpiled server-side via esbuild
 * at deploy time — browsers receive pre-compiled JS.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

module.exports = function (RED) {
  // ── Admin root prefix (for correct URLs when httpAdminRoot is set) ──
  const adminRoot = (RED.settings.httpAdminRoot || "/").replace(/\/$/, "");
  const nodeRoot = (RED.settings.httpNodeRoot || "/").replace(/\/$/, "");

  // ── Shared state ──────────────────────────────────────────────
  // Component registry: populated by fc-portal-component canvas nodes at deploy time
  if (!RED.settings.fcPortalRegistry) {
    RED.settings.fcPortalRegistry = {};
  }
  const registry = RED.settings.fcPortalRegistry;

  // Active upgrade handlers per node id (for cleanup on redeploy)
  if (!RED.settings.fcUpgradeHandlers) {
    RED.settings.fcUpgradeHandlers = {};
  }
  const upgradeHandlers = RED.settings.fcUpgradeHandlers;

  // Live page state per endpoint — route handlers read from this on each request
  if (!RED.settings.fcPageState) {
    RED.settings.fcPageState = {};
  }
  const pageState = RED.settings.fcPageState;

  // Track which endpoints already have a registered Express route
  if (!RED.settings.fcRegisteredRoutes) {
    RED.settings.fcRegisteredRoutes = {};
  }
  const registeredRoutes = RED.settings.fcRegisteredRoutes;

  // Rebuild callbacks: portal-react nodes register here so components can trigger re-transpile
  if (!RED.settings.fcRebuildCallbacks) {
    RED.settings.fcRebuildCallbacks = {};
  }
  const rebuildCallbacks = RED.settings.fcRebuildCallbacks;

  // ── Helpers ───────────────────────────────────────────────────

  function hash(str) {
    return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
  }

  const twCompile = require("tailwindcss").compile;
  const CANDIDATE_RE = /[a-zA-Z0-9_\-:.\/\[\]#%]+/g;

  let twCompiled = null;
  async function getTwCompiled() {
    if (twCompiled) return twCompiled;
    twCompiled = await twCompile(`@import 'tailwindcss';`, {
      loadStylesheet: async (id, base) => {
        let resolved;
        if (id === "tailwindcss") {
          resolved = require.resolve("tailwindcss/index.css");
        } else {
          resolved = require.resolve(id, { paths: [base || __dirname] });
        }
        return {
          content: fs.readFileSync(resolved, "utf8"),
          base: path.dirname(resolved),
        };
      },
    });
    return twCompiled;
  }

  // Package root — where react/react-dom live (this package's own node_modules)
  const pkgRoot = path.join(__dirname, "..");
  // userDir — where dynamicModuleList installs user packages
  const userDir = RED.settings.userDir || path.join(__dirname, "../../..");


  function transpile(jsx) {
    try {
      const buildResult = esbuild.buildSync({
        stdin: {
          contents: jsx,
          resolveDir: pkgRoot,
          loader: "jsx",
        },
        bundle: true,
        format: "iife",
        minify: true,
        write: false,
        target: ["es2020"],
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        define: { "process.env.NODE_ENV": '"production"' },
        logOverride: { "import-is-undefined": "silent" },
        nodePaths: [path.join(userDir, "node_modules")],
        alias: {
          "react": path.dirname(require.resolve("react/package.json", { paths: [pkgRoot] })),
          "react-dom": path.dirname(require.resolve("react-dom/package.json", { paths: [pkgRoot] })),
        },
      });
      return { js: buildResult.outputFiles[0].text, error: null };
    } catch (e) {
      return { js: null, error: e.message };
    }
  }

  async function generateCSS(source) {
    const cssHash = hash(source);
    const compiled = await getTwCompiled();
    const candidates = [...new Set(source.match(CANDIDATE_RE) || [])];
    const css = compiled.build(candidates);
    return { css, cssHash };
  }

  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function isSafeName(name) {
    return (
      typeof name === "string" && name.length > 0 && !FORBIDDEN_KEYS.has(name)
    );
  }

  function extractPortalUser(headers) {
    const user = {};
    if (headers["x-portal-user-id"]) user.userId = headers["x-portal-user-id"];
    if (headers["x-portal-user-name"])
      user.userName = headers["x-portal-user-name"];
    if (headers["x-portal-user-username"])
      user.username = headers["x-portal-user-username"];
    if (headers["x-portal-user-email"])
      user.email = headers["x-portal-user-email"];
    if (headers["x-portal-user-role"])
      user.role = headers["x-portal-user-role"];
    if (headers["x-portal-user-groups"]) {
      try {
        user.groups = JSON.parse(headers["x-portal-user-groups"]);
      } catch (_) {
        user.groups = headers["x-portal-user-groups"];
      }
    }
    return Object.keys(user).length > 0 ? user : null;
  }

  function removeRoute(router, path) {
    if (!router || !router.stack) return;
    router.stack = router.stack.filter(
      (layer) => !(layer.route && layer.route.path === path),
    );
  }

  // ── Canvas node: shared component ─────────────────────────────

  function PortalComponentNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const compName = (config.compName || "").trim();

    if (!isSafeName(compName)) {
      node.error("Invalid component name: " + compName);
      node.status({ fill: "red", shape: "dot", text: "invalid name" });
      return;
    }

    registry[compName] = {
      code: config.compCode || "",
      inputs: config.compInputs
        ? config.compInputs
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      outputs: config.compOutputs
        ? config.compOutputs
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };

    node.status({ fill: "green", shape: "dot", text: compName });

    // Trigger re-transpile on all portal-react nodes (after all nodes init)
    setImmediate(() => {
      Object.values(rebuildCallbacks).forEach((fn) => fn());
    });

    node.on("close", function (removed, done) {
      delete registry[compName];
      if (done) done();
    });
  }
  RED.nodes.registerType("fc-portal-component", PortalComponentNode);

  // ── Main node: portal-react ───────────────────────────────────

  function PortalReactNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const nodeId = node.id;

    // Config
    const endpoint = (config.endpoint || "/fromcubes").replace(/\/+$/, "");
    const componentCode = config.componentCode || "";
    const pageTitle = config.pageTitle || "Portal";
    const customHead = config.customHead || "";
    const portalAuth = config.portalAuth === true;
    const showWsStatus = config.showWsStatus === true;
    const libs = config.libs || [];

    // State
    const clients = new Map(); // portalId → ws
    let lastPayload = null;
    let wsServer = null;
    let isClosing = false;

    if (libs.length > 0) {
      const names = libs.map((l) => l.module).join(", ");
      node.status({ fill: "blue", shape: "ring", text: `installing ${names}...` });
    } else {
      node.status({ fill: "yellow", shape: "ring", text: "starting..." });
    }

    const wsPath = nodeRoot + endpoint + "/_ws";

    // ── Rebuild: transpile JSX + update page state ────────────

    function rebuild() {
      node.status({ fill: "yellow", shape: "dot", text: "building..." });

      // Selective injection: only include components referenced in user code (+ transitive deps)
      const allEntries = Object.entries(registry);
      const needed = new Set();

      function addWithDeps(name) {
        if (needed.has(name)) return;
        const entry = registry[name];
        if (!entry) return;
        needed.add(name);
        for (const [other] of allEntries) {
          if (other !== name && entry.code.includes(other)) {
            addWithDeps(other);
          }
        }
      }

      for (const [name] of allEntries) {
        if (componentCode.includes(name)) {
          addWithDeps(name);
        }
      }

      // Topological sort only needed components
      const entries = allEntries.filter(([n]) => needed.has(n));
      entries.sort((a, b) => {
        const aUsesB = a[1].code.includes(b[0]);
        const bUsesA = b[1].code.includes(a[0]);
        if (aUsesB && !bUsesA) return 1; // a depends on b → b first
        if (bUsesA && !aUsesB) return -1; // b depends on a → a first
        return 0;
      });
      const libraryJsx = entries
        .map(
          ([name, c]) =>
            `// Library: ${name}\nconst ${name} = (() => {\n${c.code}\nreturn ${name};\n})();`,
        )
        .join("\n\n");

      // Extract import statements from library/user code so they appear at top level
      const importRe = /^import\s+.+?from\s+['"].+?['"];?\s*$/gm;
      const libImports = libraryJsx.match(importRe) || [];
      const userImports = componentCode.match(importRe) || [];
      const cleanLibJsx = libraryJsx.replace(importRe, "").trim();
      const cleanCompCode = componentCode.replace(importRe, "").trim();

      const fullJsx = [
        "// ── Imports ──",
        'import React from "react";',
        'import ReactDOM from "react-dom";',
        'import { createRoot } from "react-dom/client";',
        ...libImports,
        ...userImports,
        "",
        "// ── React shorthand ──",
        "Object.keys(React).filter(k => /^use[A-Z]/.test(k)).forEach(k => { window[k] = React[k]; });",
        "const { createContext, memo, forwardRef, Fragment } = React;",
        "",
        "// ── useNodeRed hook ──",
        [
          "function useNodeRed() {",
          "  const [data, setData] = React.useState(window.__NR._lastData);",
          "  React.useEffect(() => {",
          "    return window.__NR.subscribe(setData);",
          "  }, []);",
          "  const send = React.useCallback((payload, topic) => {",
          "    window.__NR.send(payload, topic);",
          "  }, []);",
          "  const user = window.__NR._user || null;",
          "  const portalClient = window.__NR._portalClient;",
          "  return { data, send, user, portalClient };",
          "}",
        ].join("\n"),
        "",
        "// ── Library components ──",
        cleanLibJsx,
        "",
        "// ── View component ──",
        cleanCompCode,
        "",
        "// ── Mount ──",
        "createRoot(document.getElementById('root')).render(React.createElement(App));",
      ].join("\n");

      const compiled = transpile(fullJsx);

      if (compiled.error) {
        node.error("JSX transpile error: " + compiled.error);
        node.status({ fill: "red", shape: "dot", text: "transpile error" });
      } else {
        node.status({ fill: "green", shape: "dot", text: `built • ${endpoint}` });
      }

      const contentHash = compiled.js ? hash(compiled.js) : "";
      const prevState = pageState[endpoint];
      const jsxHash = hash(fullJsx);

      const cssReady = !compiled.error
        ? (prevState?.jsxHash === jsxHash && prevState?.css
            ? Promise.resolve({ css: prevState.css, cssHash: prevState.cssHash })
            : generateCSS(fullJsx))
          .catch((err) => {
            node.warn("Tailwind CSS generation failed: " + err.message);
            return { css: "", cssHash: "" };
          })
        : Promise.resolve({ css: "", cssHash: "" });

      pageState[endpoint] = {
        compiled,
        contentHash,
        cssReady,
        jsxHash,
        css: null,
        cssHash: "",
        pageTitle,
        wsPath,
        customHead,
        portalAuth,
        showWsStatus,
      };

      cssReady.then(({ css, cssHash }) => {
        const state = pageState[endpoint];
        if (state && state.jsxHash === jsxHash) {
          state.css = css;
          state.cssHash = cssHash;
          node.status({ fill: "green", shape: "dot", text: `built • ${endpoint}` });
        }
      });
    }

    // Register rebuild callback so library components can trigger re-transpile
    rebuildCallbacks[nodeId] = rebuild;

    // Delay initial build so all fc-portal-component nodes register first
    setImmediate(() => {
      rebuild();

      // Register route only once per endpoint (persists across deploys)
      if (!registeredRoutes[endpoint]) {
        RED.httpNode.get(endpoint, async function (_req, res) {
          const state = pageState[endpoint];
          if (!state) {
            res.status(404).send("Not found");
            return;
          }
          res.set("Cache-Control", "no-store");
          if (state.compiled.error) {
            res
              .status(500)
              .type("text/html")
              .send(buildErrorPage(state.pageTitle, state.compiled.error));
            return;
          }
          const { cssHash } = await state.cssReady;
          const user = state.portalAuth
            ? extractPortalUser(_req.headers)
            : null;
          res
            .type("text/html")
            .send(
              buildPage(
                state.pageTitle,
                state.compiled.js,
                state.wsPath,
                state.customHead,
                cssHash,
                user,
                state.showWsStatus,
              ),
            );
        });
        registeredRoutes[endpoint] = true;
      }

      // ── WebSocket ─────────────────────────────────────────────

      try {
        const WebSocket = require("ws");
        wsServer = new WebSocket.Server({ noServer: true });

        // Remove previous upgrade handler for this node (dirty deploy)
        if (upgradeHandlers[nodeId]) {
          RED.server.removeListener("upgrade", upgradeHandlers[nodeId]);
          delete upgradeHandlers[nodeId];
        }

        const onUpgrade = function (request, socket, head) {
          if (isClosing) return;
          let pathname;
          try {
            pathname = new URL(request.url, `http://${request.headers.host}`)
              .pathname;
          } catch {
            pathname = request.url;
          }
          if (pathname === wsPath) {
            wsServer.handleUpgrade(request, socket, head, (ws) => {
              wsServer.emit("connection", ws, request);
            });
          }
        };

        RED.server.on("upgrade", onUpgrade);
        upgradeHandlers[nodeId] = onUpgrade;

        wsServer.on("connection", (ws, request) => {
          if (isClosing) {
            ws.close();
            return;
          }
          const portalClient = crypto.randomUUID();
          ws._portalClient = portalClient;
          if (portalAuth) {
            ws._portalUser = extractPortalUser(request.headers);
          }
          clients.set(portalClient, ws);
          updateStatus();

          // Push current state to new client
          if (lastPayload !== null) {
            wsSend(ws, { type: "data", payload: lastPayload });
          }

          // Send content version for deploy-reload detection
          const contentHash = pageState[endpoint]?.contentHash || "";
          wsSend(ws, { type: "version", hash: contentHash });

          // Send assigned portalClient to browser
          wsSend(ws, { type: "hello", portalClient });

          ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === "output") {
                const out = {
                  payload: msg.payload,
                  topic: msg.topic || "",
                };
                const client = { portalClient: ws._portalClient };
                if (portalAuth && ws._portalUser) {
                  Object.assign(client, ws._portalUser);
                }
                out._client = client;
                node.send(out);
              }
            } catch (e) {
              node.warn("Bad WS message: " + e.message);
            }
          });

          ws.on("close", () => {
            clients.delete(portalClient);
            updateStatus();
          });

          ws.on("error", () => {
            clients.delete(portalClient);
            updateStatus();
          });
        });
      } catch (e) {
        node.error("WebSocket setup failed: " + e.message);
      }

      // ── Input handler ─────────────────────────────────────────

      node.on("input", (msg, send, done) => {
        const target = msg._client;
        const frame = JSON.stringify({ type: "data", payload: msg.payload });

        if (target && target.portalClient) {
          // Target specific client by portalClient
          const ws = clients.get(target.portalClient);
          if (ws && ws.readyState === 1) ws.send(frame);
        } else if (target && (target.userId || target.username)) {
          // Target all sessions of a specific user
          const matchId = target.userId;
          const matchName = target.username;
          clients.forEach((ws) => {
            if (ws.readyState !== 1) return;
            const u = ws._portalUser;
            if (!u) return;
            if ((matchId && u.userId === matchId) || (matchName && u.username === matchName)) {
              ws.send(frame);
            }
          });
        } else {
          // Broadcast to all (default)
          lastPayload = msg.payload;
          clients.forEach((ws) => {
            if (ws.readyState === 1) ws.send(frame);
          });
        }

        updateStatus();
        if (done) done();
      });

      // ── Cleanup on redeploy / shutdown ────────────────────────

      node.on("close", (removed, done) => {
        isClosing = true;

        // Remove upgrade handler
        if (upgradeHandlers[nodeId]) {
          RED.server.removeListener("upgrade", upgradeHandlers[nodeId]);
          delete upgradeHandlers[nodeId];
        }

        // Close all WS clients
        clients.forEach((ws) => {
          try {
            ws.close(1001, "node redeployed");
          } catch (_) {}
        });
        clients.clear();

        // Close WS server
        if (wsServer) {
          try {
            wsServer.close();
          } catch (_) {}
          wsServer = null;
        }

        // Unregister rebuild callback
        delete rebuildCallbacks[nodeId];

        // Clean up route only when node is fully removed (not redeployed)
        if (removed) {
          delete pageState[endpoint];
          removeRoute(RED.httpNode._router, endpoint);
          delete registeredRoutes[endpoint];
        }

        if (done) done();
      });

      // ── Utilities ─────────────────────────────────────────────

      function wsSend(ws, obj) {
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify(obj));
        } catch (_) {}
      }

      function updateStatus() {
        if (isClosing) return;
        const n = clients.size;
        node.status({
          fill: n > 0 ? "green" : "grey",
          shape: n > 0 ? "dot" : "ring",
          text: `${endpoint} [${n} client${n !== 1 ? "s" : ""}]`,
        });
      }
    }); // end setImmediate
  }

  RED.nodes.registerType("portal-react", PortalReactNode, {
    dynamicModuleList: "libs",
  });

  // ── Serve Monaco editor files locally ────────────────────────
  const express = require("express");
  const monacoPath = path.dirname(
    require.resolve("monaco-editor/package.json"),
  );
  RED.httpAdmin.use(
    "/portal-react/vs",
    express.static(path.join(monacoPath, "min", "vs")),
  );

  // ── Tailwind class list endpoint ────────────────────────────
  const { generateCandidates } = require("./tw-candidates");
  let twClassesCache = null;
  RED.httpAdmin.get("/portal-react/tw-classes", (_req, res) => {
    if (!twClassesCache) {
      twClassesCache = generateCandidates();
    }
    res.json(twClassesCache);
  });

  // ── Vendor CSS endpoint (per page, looked up from pageState) ─────────
  RED.httpAdmin.get("/portal-react/css/:hash.css", (req, res) => {
    const reqHash = req.params.hash;
    let css = null;
    for (const ep in pageState) {
      if (pageState[ep]?.cssHash === reqHash) {
        css = pageState[ep].css;
        break;
      }
    }
    if (!css) {
      res.status(404).send("Not found");
      return;
    }
    res.set({
      "Content-Type": "text/css",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(css);
  });

  // ── Public assets folder ─────────────────────────────────────
  const assetsDir = path.join(userDir, "fromcubes-public");
  fs.mkdirSync(assetsDir, { recursive: true });
  const UNSAFE_EXTS = new Set([".html", ".htm", ".svg", ".js", ".mjs", ".xml", ".xhtml"]);
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

  const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;
  function isSafePathSegment(s) {
    return (
      typeof s === "string" &&
      s.length > 0 &&
      s.length <= 255 &&
      !/[\\:*?"<>|\0]/.test(s) &&
      !s.startsWith(".") &&
      !s.endsWith(".") &&   // Windows strips trailing dots
      !s.endsWith(" ") &&   // Windows strips trailing spaces
      s !== ".." &&
      !RESERVED_NAMES.test(s)
    );
  }

  const MAX_PATH_DEPTH = 10;
  function safePath(rel) {
    if (!rel || typeof rel !== "string") return null;
    const segments = rel.split("/").filter(Boolean);
    if (segments.length === 0 || segments.length > MAX_PATH_DEPTH) return null;
    if (!segments.every(isSafePathSegment)) return null;
    const resolved = path.resolve(assetsDir, ...segments);
    if (!resolved.startsWith(assetsDir + path.sep) && resolved !== assetsDir)
      return null;
    // Symlink escape check: verify realpath stays inside assetsDir
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(assetsDir + path.sep) && real !== assetsDir)
        return null;
    } catch (_e) { /* path doesn't exist yet — OK for mkdir/upload */ }
    return resolved;
  }

  function scanDir(dir, prefix) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // skip symlinks for safety
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

  RED.httpAdmin.get("/portal-react/assets", (_req, res) => {
    try {
      res.json(scanDir(assetsDir, ""));
    } catch (e) {
      res.json([]);
    }
  });

  RED.httpAdmin.post("/portal-react/assets/mkdir", express.json(), (req, res) => {
    const target = safePath(req.body && req.body.path);
    if (!target) return res.status(400).json({ error: "invalid path" });
    try {
      fs.mkdirSync(target, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      RED.log.error("portal-react assets mkdir: " + e.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  RED.httpAdmin.post("/portal-react/assets/move", express.json(), (req, res) => {
    const from = safePath(req.body && req.body.from);
    const to = safePath(req.body && req.body.to);
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

  const MAX_ASSETS_BYTES = 500 * 1024 * 1024; // 500 MB total
  const MAX_ASSETS_FILES = 1000;
  function getAssetsStats() {
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

  RED.httpAdmin.post(
    "/portal-react/assets/upload/*",
    express.raw({ type: "*/*", limit: "100mb" }),
    (req, res) => {
      const rel = req.params[0];
      const target = safePath(rel);
      if (!target) return res.status(400).json({ error: "invalid path" });
      const stats = getAssetsStats();
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

  RED.httpAdmin.delete("/portal-react/assets/*", (req, res) => {
    const rel = req.params[0];
    const target = safePath(rel);
    if (!target) return res.status(400).json({ error: "invalid path" });
    try {
      fs.rmSync(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      RED.log.error("portal-react assets delete: " + e.message);
      res.status(404).json({ error: "not found" });
    }
  });

  RED.httpAdmin.get("/portal-react/assets/download/*", (req, res) => {
    const rel = req.params[0];
    const target = safePath(rel);
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

  // ── Admin API for component registry ──────────────────────────

  RED.httpAdmin.get("/portal-react/registry", (_req, res) => {
    res.json(registry);
  });

  RED.httpAdmin.post("/portal-react/registry", (req, res) => {
    const { name, code, inputs, outputs } = req.body || {};
    if (!isSafeName(name))
      return res.status(400).json({ error: "invalid name" });
    registry[name] = { code, inputs: inputs || [], outputs: outputs || [] };
    res.json({ ok: true });
  });

  RED.httpAdmin.delete("/portal-react/registry/:name", (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name))
      return res.status(400).json({ error: "invalid name" });
    delete registry[name];
    res.json({ ok: true });
  });

  // ── Page builders ─────────────────────────────────────────────

  function buildPage(title, transpiledJs, wsPath, customHead, cssHash, user, showWsStatus) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1.0">
      <title>${esc(title)}</title>
      ${cssHash ? `<link rel="stylesheet" href="${adminRoot}/portal-react/css/${cssHash}.css">` : ""}
      ${escScript(customHead)}
      ${showWsStatus ? `<style>
        #__cs {
          position: fixed; bottom: 6px; right: 6px;
          padding: 3px 8px; font-size: 10px; border-radius: 3px;
          z-index: 99999; background: #111; border: 1px solid #333;
          opacity: .7; transition: opacity .2s;
        }
        #__cs:hover { opacity: 1 }
        #__cs.ok { color: #4ade80 }
        #__cs.err { color: #f87171 }
      </style>` : ""}
    </head>
    <body>
      <div id="root"></div>
      ${showWsStatus ? `<div id="__cs" class="err">fromcubes</div>` : ""}
      <script>
        window.__NR = {
          _ws: null,
          _listeners: new Set(),
          _lastData: null,
          _retries: 0,
          _wasConnected: false,
          _version: null,
          _portalClient: null,
          _user: ${user ? escScript(JSON.stringify(user)) : "null"},

          connect() {
            const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(p + '//' + location.host + '${wsPath}');
            this._ws = ws;
            const s = document.getElementById('__cs');

            ws.onopen = () => {
              if (s) { s.textContent = 'fromcubes \u2022 connected'; s.className = 'ok'; }
              this._retries = 0;
              this._wasConnected = true;
            };

            ws.onmessage = (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.type === 'hello') {
                  this._portalClient = m.portalClient;
                }
                if (m.type === 'version') {
                  if (this._version && this._version !== m.hash) { location.reload(); return; }
                  this._version = m.hash;
                }
                if (m.type === 'data') {
                  this._lastData = m.payload;
                  this._listeners.forEach(fn => fn(m.payload));
                }
              } catch (err) { console.error('WS parse', err); }
            };

            ws.onclose = () => {
              if (s) { s.textContent = 'fromcubes \u2022 disconnected'; s.className = 'err'; }
              this._ws = null;
              const delay = Math.min(500 * Math.pow(2, this._retries), 8000);
              this._retries++;
              setTimeout(() => this.connect(), delay);
            };

            ws.onerror = () => ws.close();
          },

          subscribe(fn) {
            this._listeners.add(fn);
            if (this._lastData !== null) fn(this._lastData);
            return () => this._listeners.delete(fn);
          },

          send(payload, topic) {
            if (this._ws && this._ws.readyState === 1)
              this._ws.send(JSON.stringify({ type: 'output', payload, topic: topic || '' }));
          }
        };
        window.__NR.connect();
      <\/script>
      <script>
        ${escScript(transpiledJs)}
      <\/script>
    </body>
    </html>`;
  }

  function buildErrorPage(title, error) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${esc(title)} — Error</title>
      <style>
        body { font-family: monospace; background: #1a0000; color: #f87171; padding: 40px; line-height: 1.6 }
        h1 { color: #ff4444; margin-bottom: 16px }
        pre { background: #0a0a0a; border: 1px solid #ff4444; border-radius: 8px; padding: 20px; overflow-x: auto; color: #fca5a5 }
      </style>
    </head>
    <body>
      <h1>JSX Transpile Error</h1>
      <p>Fix the component code in Node-RED and deploy again.</p>
      <pre>${esc(error)}</pre>
    </body>
    </html>`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escScript(s) {
    return String(s).replace(/<\/(script)/gi, "<\\/$1");
  }
};

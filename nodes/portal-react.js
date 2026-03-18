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

const reactBundle = fs.readFileSync(
  path.join(__dirname, "vendor", "react-19.production.min.js"),
  "utf8",
);
const reactHash = crypto
  .createHash("sha256")
  .update(reactBundle)
  .digest("hex")
  .slice(0, 10);

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

  // CSS cache: hash → css string
  if (!RED.settings.fcCssCache) {
    RED.settings.fcCssCache = {};
  }
  const cssCache = RED.settings.fcCssCache;

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

  function transpile(jsx) {
    try {
      const buildResult = esbuild.buildSync({
        stdin: {
          contents: jsx,
          resolveDir: path.join(__dirname, "../../.."),
          loader: "jsx",
        },
        bundle: true,
        format: "iife",
        write: false,
        target: ["es2020"],
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        external: ["react", "react-dom"],
        define: { "process.env.NODE_ENV": '"production"' },
      });
      return { js: buildResult.outputFiles[0].text, error: null };
    } catch (e) {
      return { js: null, error: e.message };
    }
  }

  async function generateCSS(source) {
    const key = hash(source);
    if (cssCache[key]) return cssCache[key];
    const compiled = await getTwCompiled();
    const candidates = [...new Set(source.match(CANDIDATE_RE) || [])];
    const css = compiled.build(candidates);
    cssCache[key] = css;
    return css;
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
    const endpoint = (config.endpoint || "/portal").replace(/\/+$/, "");
    const componentCode = config.componentCode || "";
    const pageTitle = config.pageTitle || "Portal";
    const customHead = config.customHead || "";
    const portalAuth = config.portalAuth === true;
    const showWsStatus = config.showWsStatus === true;

    // State
    const clients = new Set();
    let lastPayload = null;
    let wsServer = null;
    let isClosing = false;

    const wsPath = nodeRoot + endpoint + "/_ws";

    // ── Rebuild: transpile JSX + update page state ────────────

    function rebuild() {
      // Topological sort: components used by others come first
      const entries = Object.entries(registry);
      const names = entries.map(([n]) => n);
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

      const fullJsx = [
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
          "  return { data, send, user };",
          "}",
        ].join("\n"),
        "",
        "// ── Library components ──",
        libraryJsx,
        "",
        "// ── View component ──",
        componentCode,
        "",
        "// ── Mount ──",
        "ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));",
      ].join("\n");

      const compiled = transpile(fullJsx);

      if (compiled.error) {
        node.error("JSX transpile error: " + compiled.error);
        node.status({ fill: "red", shape: "dot", text: "transpile error" });
      } else {
        node.status({ fill: "grey", shape: "ring", text: endpoint });
      }

      const cssHashReady = !compiled.error
        ? generateCSS(fullJsx)
            .then((css) => {
              node.status({ fill: "grey", shape: "ring", text: endpoint });
              return css ? hash(fullJsx) : "";
            })
            .catch((err) => {
              node.warn("Tailwind CSS generation failed: " + err.message);
              return "";
            })
        : Promise.resolve("");

      const contentHash = compiled.js ? hash(compiled.js) : "";

      pageState[endpoint] = {
        compiled,
        contentHash,
        cssHashReady,
        pageTitle,
        wsPath,
        customHead,
        portalAuth,
        showWsStatus,
      };
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
          const cssHash = await state.cssHashReady;
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
          if (portalAuth) {
            ws._portalUser = extractPortalUser(request.headers);
          }
          clients.add(ws);
          updateStatus();

          // Push current state to new client
          if (lastPayload !== null) {
            wsSend(ws, { type: "data", payload: lastPayload });
          }

          // Send content version for deploy-reload detection
          const contentHash = pageState[endpoint]?.contentHash || "";
          wsSend(ws, { type: "version", hash: contentHash });

          ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === "output") {
                const out = {
                  payload: msg.payload,
                  topic: msg.topic || "",
                };
                if (portalAuth && ws._portalUser) {
                  out._client = ws._portalUser;
                }
                node.send(out);
              }
            } catch (e) {
              node.warn("Bad WS message: " + e.message);
            }
          });

          ws.on("close", () => {
            clients.delete(ws);
            updateStatus();
          });

          ws.on("error", () => {
            clients.delete(ws);
            updateStatus();
          });
        });
      } catch (e) {
        node.error("WebSocket setup failed: " + e.message);
      }

      // ── Input handler ─────────────────────────────────────────

      node.on("input", (msg, send, done) => {
        lastPayload = msg.payload;
        const frame = JSON.stringify({ type: "data", payload: msg.payload });
        clients.forEach((ws) => {
          if (ws.readyState === 1) ws.send(frame);
        });
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

  RED.nodes.registerType("portal-react", PortalReactNode);

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

  // ── Vendor CSS endpoint (per content hash) ─────────────────
  RED.httpAdmin.get("/portal-react/css/:hash.css", (req, res) => {
    const css = cssCache[req.params.hash];
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

  // ── Vendor React bundle endpoint ────────────────────────────
  RED.httpAdmin.get("/portal-react/vendor/react.min.js", (_req, res) => {
    res.set({
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${reactHash}"`,
    });
    res.send(reactBundle);
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
      <script src="${adminRoot}/portal-react/vendor/react.min.js?v=${reactHash}"><\/script>
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

/**
 * @aaqu/fromcubes-portal-react
 *
 * Node-RED node that serves React apps from configurable HTTP endpoints
 * with live WebSocket data binding. JSX is transpiled server-side via esbuild
 * at deploy time — browsers receive pre-compiled JS.
 */

const crypto = require("crypto");
const path = require("path");

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

  // Track endpoint ownership: { endpoint: nodeId } — prevents duplicate endpoints
  if (!RED.settings.fcEndpointOwners) {
    RED.settings.fcEndpointOwners = {};
  }
  const endpointOwners = RED.settings.fcEndpointOwners;

  // Debounced rebuild-all: coalesces multiple component registrations into one rebuild pass
  let _rebuildTimer = null;
  function scheduleRebuildAll() {
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(() => {
      _rebuildTimer = null;
      Object.values(rebuildCallbacks).forEach((fn) => fn());
    }, 50);
  }

  // ── Load modules ─────────────────────────────────────────────
  const helpers = require("./lib/helpers")(RED);
  const { hash, transpile, generateCSS, extractPortalUser, removeRoute, isSafeName, userDir,
          readCachedJS, writeCachedJS, readCachedCSS, writeCachedCSS, deleteCacheFiles, isHashInUse } = helpers;
  const { buildPage, buildErrorPage } = require("./lib/page-builder");

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

    // Trigger re-transpile on all portal-react nodes (debounced across all component registrations)
    scheduleRebuildAll();

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

    // ── Duplicate endpoint check ──
    const existingOwner = endpointOwners[endpoint];
    if (existingOwner && existingOwner !== nodeId) {
      node.error(`Endpoint "${endpoint}" is already used by another portal node`);
      node.status({ fill: "red", shape: "ring", text: "duplicate: " + endpoint });
      node.on("close", function (_removed, done) { if (done) done(); });
      return;
    }
    endpointOwners[endpoint] = nodeId;

    // State
    const clients = new Map(); // portalId → ws
    let lastPayload = null;
    let wsServer = null;
    let isClosing = false;
    let lastJsxHash = null;

    if (libs.length > 0) {
      node.status({ fill: "blue", shape: "ring", text: "loading libs..." });
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

      // Warn about import * (prevents tree-shaking)
      const starRe = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"](.+?)['"];?\s*$/;
      const allCode = cleanLibJsx + "\n" + cleanCompCode;
      for (const imp of [...libImports, ...userImports]) {
        const m = imp.match(starRe);
        if (!m) continue;
        const [, localName, modulePath] = m;
        const propRe = new RegExp(`\\b${localName}\\s*\\??\\s*\\.\\s*(\\w+)`, "g");
        const props = new Set();
        let pm;
        while ((pm = propRe.exec(allCode)) !== null) props.add(pm[1]);
        if (props.size > 0) {
          const named = [...props].sort().join(", ");
          node.warn(
            `"import * as ${localName}" bundles entire ${modulePath} library. ` +
            `For smaller builds use: import { ${named} } from '${modulePath}'`,
          );
        }
      }

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

      const jsxHash = hash(fullJsx);
      const prevState = pageState[endpoint];
      const prevHash = prevState?.jsxHash;

      // ── JS: disk cache → transpile ──
      let compiled = readCachedJS(jsxHash);
      let cacheHit = !!compiled;
      if (!compiled) {
        compiled = transpile(fullJsx);
        if (!compiled.error) {
          writeCachedJS(jsxHash, compiled.js, compiled.metafile);
        }
      }

      if (compiled.error) {
        node.error("JSX transpile error: " + compiled.error);
        node.status({ fill: "red", shape: "dot", text: "transpile error" });
      } else {
        node.status({ fill: "green", shape: "dot", text: `built • ${endpoint}` });
        if (compiled.metafile) {
          const output = Object.values(compiled.metafile.outputs)[0];
          const sizes = output
            ? Object.entries(output.inputs)
                .map(([name, info]) => ({ name: name.replace(/^.*node_modules\//, ""), bytes: info.bytesInOutput }))
                .sort((a, b) => b.bytes - a.bytes)
                .slice(0, 5)
            : [];
          const totalKB = (compiled.js.length / 1024).toFixed(1);
          node.log(`Bundle${cacheHit ? " (cached)" : ""}: ${totalKB}KB — top: ${sizes.map((s) => `${s.name} (${(s.bytes / 1024).toFixed(1)}KB)`).join(", ")}`);
        }
      }

      const contentHash = compiled.js ? hash(compiled.js) : "";

      // ── CSS: disk cache → in-memory → generate ──
      const cssReady = !compiled.error
        ? (() => {
            const cachedCSS = readCachedCSS(jsxHash);
            if (cachedCSS) return Promise.resolve(cachedCSS);
            if (prevState?.jsxHash === jsxHash && prevState?.css) {
              return Promise.resolve({ css: prevState.css, cssHash: prevState.cssHash });
            }
            return generateCSS(fullJsx).then(({ css, cssHash }) => {
              writeCachedCSS(jsxHash, css);
              return { css, cssHash };
            });
          })().catch((err) => {
            node.warn("Tailwind CSS generation failed: " + err.message);
            return { css: "", cssHash: "" };
          })
        : Promise.resolve({ css: "", cssHash: "" });

      // ── Stale cache cleanup ──
      if (prevHash && prevHash !== jsxHash && !isHashInUse(prevHash, pageState, endpoint)) {
        deleteCacheFiles(prevHash);
      }

      lastJsxHash = jsxHash;

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

    // Initial build: debounced so all fc-portal-component nodes register first
    scheduleRebuildAll();
    setImmediate(() => {

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
                adminRoot,
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

        // Release endpoint ownership
        if (endpointOwners[endpoint] === nodeId) {
          delete endpointOwners[endpoint];
        }

        // Clean up route only when node is fully removed (not redeployed)
        if (removed) {
          // Delete disk cache if no other endpoint uses this hash
          if (lastJsxHash && !isHashInUse(lastJsxHash, pageState, endpoint)) {
            deleteCacheFiles(lastJsxHash);
          }
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
  const { registerAssets } = require("./lib/assets");
  registerAssets(RED, express, path.join(userDir, "fromcubes", "public"));

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

};

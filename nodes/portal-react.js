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

  // Per-portal set of component names the portal depends on (needed set from last rebuild,
  // including transitive deps). Lets component changes target only portals that use them.
  if (!RED.settings.fcPortalNeeded) {
    RED.settings.fcPortalNeeded = {};
  }
  const portalNeeded = RED.settings.fcPortalNeeded;

  // Per-portal raw user JSX code string. Used as fallback to detect references to
  // newly-added components that haven't been in a `needed` set yet.
  if (!RED.settings.fcPortalCode) {
    RED.settings.fcPortalCode = {};
  }
  const portalCode = RED.settings.fcPortalCode;

  // Track endpoint ownership: { endpoint: nodeId } — prevents duplicate endpoints
  if (!RED.settings.fcEndpointOwners) {
    RED.settings.fcEndpointOwners = {};
  }
  const endpointOwners = RED.settings.fcEndpointOwners;

  // Track component name ownership: { compName: nodeId } — prevents duplicate component names
  if (!RED.settings.fcCompNameOwners) {
    RED.settings.fcCompNameOwners = {};
  }
  const compNameOwners = RED.settings.fcCompNameOwners;

  // Per-portal config signature — detects no-op Full-deploy reconstructions so unchanged
  // portals skip rebuild entirely (Node-RED closes/reopens every node on Full deploy).
  if (!RED.settings.fcPortalSig) {
    RED.settings.fcPortalSig = {};
  }
  const portalSig = RED.settings.fcPortalSig;

  // Debounced selective rebuild: coalesces multiple component changes into one pass.
  // Yields event loop between builds so HTTP server stays responsive.
  let _rebuildTimer = null;
  const _dirtyComps = new Set();
  const _dirtyPortals = new Set();

  // Startup gate: on first process start, Node-RED constructs portal/component nodes
  // sequentially over a window longer than the 50ms debounce. Without gating, an early
  // flush rebuilds a portal, then a late component registration triggers a second
  // rebuild. Hold all flushes until `flows:started` (or a 2s failsafe) so startup
  // collapses to exactly one rebuild pass.
  let _startupPhase = true;
  function _endStartupPhase() {
    if (!_startupPhase) return;
    _startupPhase = false;
    if (_dirtyPortals.size > 0 || _dirtyComps.size > 0) {
      if (_rebuildTimer) { clearTimeout(_rebuildTimer); _rebuildTimer = null; }
      _flushRebuild();
    }
  }
  try {
    if (RED.events && typeof RED.events.once === "function") {
      RED.events.once("flows:started", _endStartupPhase);
    }
  } catch (e) { RED.log.trace("[portal-react] events.once: " + e.message); }
  // Failsafe: if flows:started never arrives (module loaded mid-run, test harness, etc.)
  setTimeout(_endStartupPhase, 2000).unref?.();

  function _armRebuild() {
    if (_startupPhase) return; // gated — _endStartupPhase will flush
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(_flushRebuild, 50);
    _rebuildTimer.unref?.();
  }
  function scheduleRebuildSelf(nodeId) {
    if (!nodeId) return;
    _dirtyPortals.add(nodeId);
    _armRebuild();
  }
  function scheduleRebuildUsing(compName) {
    if (!compName) return;
    _dirtyComps.add(compName);
    _armRebuild();
  }
  function _flushRebuild() {
    _rebuildTimer = null;
    const dirty = new Set(_dirtyComps);
    const selfIds = new Set(_dirtyPortals);
    _dirtyComps.clear();
    _dirtyPortals.clear();

    const targetIds = new Set(selfIds);
    if (dirty.size > 0) {
      for (const nodeId of Object.keys(rebuildCallbacks)) {
        if (targetIds.has(nodeId)) continue;
        const used = portalNeeded[nodeId];
        const raw = portalCode[nodeId] || "";
        for (const name of dirty) {
          if ((used && used.has(name)) || raw.includes(name)) {
            targetIds.add(nodeId);
            break;
          }
        }
      }
    }

    const fns = [...targetIds].map((id) => rebuildCallbacks[id]).filter(Boolean);
    let i = 0;
    function next() {
      if (i >= fns.length) return;
      try { fns[i](); } catch (e) { RED.log.error("[portal-react] rebuild failed: " + e.message); }
      i++;
      if (i < fns.length) setImmediate(next);
    }
    next();
  }

  // ── Load modules ─────────────────────────────────────────────
  const helpers = require("./lib/helpers")(RED);
  const {
    hash,
    transpile,
    quickCheckSyntax,
    generateCSS,
    extractPortalUser,
    removeRoute,
    isSafeName,
    validateSubPath,
    userDir,
    readCachedJS,
    writeCachedJS,
    readCachedCSS,
    writeCachedCSS,
    deleteCacheFiles,
    isHashInUse,
  } = helpers;
  const { buildPage, buildErrorPage } = require("./lib/page-builder");
  const hooks = require("./lib/hooks")(RED);
  const router = require("./lib/router");

  // Per-process cache of the last broadcast payload per endpoint.
  // Lets a freshly-connected client see the most recent broadcast value
  // (similar to dashboard2's lastMsg recovery). Sent as a distinct
  // `recovery` WS frame so React can opt out via useNodeRed({ ignoreRecovery: true }).
  const lastBroadcastCache = new Map();

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

    // Duplicate component name check
    const existingOwner = compNameOwners[compName];
    if (existingOwner && existingOwner !== node.id) {
      node.error(
        `Component name "${compName}" is already used by another node`,
      );
      node.status({
        fill: "red",
        shape: "ring",
        text: "duplicate: " + compName,
      });
      node.on("close", function (_removed, done) {
        if (done) done();
      });
      return;
    }
    compNameOwners[compName] = node.id;

    const newCode = config.compCode || "";
    const prevCode = registry[compName]?.code;
    const syntaxErr = quickCheckSyntax(newCode);
    registry[compName] = { code: newCode, error: syntaxErr };

    if (syntaxErr) {
      node.error(`Component "${compName}" syntax error: ${syntaxErr}`);
      const short = syntaxErr.split("\n")[0].slice(0, 40);
      node.status({ fill: "red", shape: "dot", text: "syntax: " + short });
    } else {
      node.status({ fill: "green", shape: "dot", text: compName });
    }

    // Only rebuild portals that reference this component, and only if the code actually changed.
    if (prevCode !== newCode) {
      scheduleRebuildUsing(compName);
    }

    node.on("close", function (removed, done) {
      if (compNameOwners[compName] === node.id) {
        delete compNameOwners[compName];
      }
      delete registry[compName];
      // Portals depending on this component must rebuild (topology changed or name resolution breaks).
      scheduleRebuildUsing(compName);
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
    const subPathResult = validateSubPath(config.subPath);
    const legacyEndpoint =
      typeof config.endpoint === "string" && config.endpoint.trim().length > 0
        ? config.endpoint.trim()
        : null;

    if (!subPathResult.ok) {
      // No valid subPath. If there's a legacy endpoint, hard-fail with a
      // migration message; otherwise fail on the sub-path error.
      if (legacyEndpoint) {
        node.error(
          `Legacy 'endpoint' field detected ("${legacyEndpoint}"). ` +
            "Open the node, set a Sub-path (served under /fromcubes/<sub-path>), and redeploy.",
        );
        node.status({ fill: "red", shape: "ring", text: "legacy endpoint" });
      } else {
        node.error("Invalid sub-path: " + subPathResult.error);
        node.status({ fill: "red", shape: "ring", text: "bad sub-path" });
      }
      node.on("close", function (_removed, done) {
        if (done) done();
      });
      return;
    }
    const subPath = subPathResult.value;
    const endpoint = "/fromcubes/" + subPath;

    const componentCode = config.componentCode || "";
    const pageTitle = config.pageTitle || "Portal";
    const customHead = config.customHead || "";
    const portalAuth = config.portalAuth === true;
    const showWsStatus = config.showWsStatus === true;
    const libs = config.libs || [];

    // ── Duplicate endpoint check ──
    const existingOwner = endpointOwners[endpoint];
    if (existingOwner && existingOwner !== nodeId) {
      node.error(
        `Endpoint "${endpoint}" is already used by another portal node`,
      );
      node.status({
        fill: "red",
        shape: "ring",
        text: "duplicate: " + endpoint,
      });
      node.on("close", function (_removed, done) {
        if (done) done();
      });
      return;
    }
    endpointOwners[endpoint] = nodeId;

    // State
    const clients = new Map(); // portalClient → ws
    const userIndex = new Map(); // userId → Set<ws>   (O(1) user-cast)
    let wsServer = null;
    let isClosing = false;
    let lastJsxHash = null;

    if (libs.length > 0) {
      node.status({ fill: "blue", shape: "ring", text: "loading libs..." });
    } else {
      node.status({ fill: "yellow", shape: "ring", text: "starting..." });
    }

    const wsPath = nodeRoot + endpoint + "/_ws";

    function updateStatus() {
      if (isClosing) return;
      const st = pageState[endpoint];
      const n = clients.size;
      const clientTail = n > 0 ? ` [${n} client${n !== 1 ? "s" : ""}]` : "";

      // Preserve build-error state — don't clobber with client count until JSX is fixed.
      // Show "(serving last good)" suffix in degraded mode (ring shape) so it is
      // obvious the portal still works for connected clients despite the broken build.
      if (st && st.compiled && st.compiled.error) {
        let base;
        if (st.errorSource) base = "broken: " + st.errorSource;
        else if (st.errorKind === "missing-return") base = "missing return";
        else if (st.errorKind === "rebuild") base = "rebuild error";
        else base = "transpile error";
        if (st.lastGood) {
          node.status({
            fill: "red",
            shape: "ring",
            text: base + " (serving last good)" + clientTail,
          });
        } else {
          node.status({ fill: "red", shape: "dot", text: base + clientTail });
        }
        return;
      }
      // Preserve building state — same reason.
      if (st && st.building) {
        node.status({ fill: "yellow", shape: "dot", text: "building..." });
        return;
      }
      // Build succeeded but a connected browser threw at runtime
      // (e.g. ReferenceError to a missing component / undefined identifier).
      if (st && st.runtimeError) {
        node.status({
          fill: "red",
          shape: "ring",
          text: "runtime error" + clientTail,
        });
        return;
      }
      node.status({
        fill: n > 0 ? "green" : "grey",
        shape: n > 0 ? "dot" : "ring",
        text: `${endpoint}${clientTail || " [0 clients]"}`,
      });
    }

    // ── Rebuild: transpile JSX + update page state ────────────

    function rebuild() {
      try {
        // ── Pre-build: clear cache, set building state, notify browsers ──
        const prevState = pageState[endpoint];
        const prevHash = prevState?.jsxHash;
        if (prevHash && !isHashInUse(prevHash, pageState, endpoint)) {
          deleteCacheFiles(prevHash);
        }
        pageState[endpoint] = { building: true, wsPath, pageTitle };
        updateStatus();
        clients.forEach((ws) => {
          try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "building" })); } catch (e) { RED.log.trace("[portal-react] ws send building: " + e.message); }
        });

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

        // Remember which components this portal depends on, so component changes
        // can target only affected portals.
        portalNeeded[nodeId] = new Set(needed);

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
          const propRe = new RegExp(
            `\\b${localName}\\s*\\??\\s*\\.\\s*(\\w+)`,
            "g",
          );
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
            "function useNodeRed(opts) {",
            "  // opts.ignoreRecovery = true → ignore the cached last-broadcast",
            "  // frame the server sends on connect; data stays undefined until",
            "  // a fresh broadcast arrives. Latched once globally — strictest",
            "  // call wins (any caller asking to ignore disables recovery for all).",
            "  if (opts && opts.ignoreRecovery) window.__NR._ignoreRecovery = true;",
            "  const [data, setData] = React.useState(window.__NR._lastData);",
            "  React.useEffect(() => window.__NR.subscribe(setData), []);",
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

        // ── Check: any used component has its own syntax error ──
        let errorSource = null;
        for (const name of needed) {
          if (registry[name]?.error) {
            errorSource = name;
            break;
          }
        }

        // ── Check: missing return in App ──
        let missingReturn = false;
        const appFnMatch = cleanCompCode.match(/function\s+App\s*\([^)]*\)\s*\{/);
        if (appFnMatch) {
          let depth = 1, i = appFnMatch.index + appFnMatch[0].length;
          let hasReturn = false;
          while (i < cleanCompCode.length && depth > 0) {
            const ch = cleanCompCode[i];
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
            else if (cleanCompCode.slice(i, i + 7) === "return ") hasReturn = true;
            i++;
          }
          missingReturn = !hasReturn;
        }

        // ── Resolve compiled (success or unified error) ──
        let compiled;
        let cacheHit = false;
        let errorKind = null; // 'component' | 'missing-return' | 'transpile'
        if (errorSource) {
          compiled = {
            js: null,
            error: `Component "${errorSource}" has a syntax error:\n\n${registry[errorSource].error}`,
          };
          errorKind = "component";
        } else if (missingReturn) {
          compiled = {
            js: null,
            error:
              "App component has no return statement.\n\nAdd a return with JSX, e.g.:\n\nfunction App() {\n  return <div>Hello</div>\n}",
          };
          errorKind = "missing-return";
        } else {
          compiled = readCachedJS(jsxHash);
          cacheHit = !!compiled;
          if (!compiled) {
            compiled = transpile(fullJsx);
            if (!compiled.error) {
              writeCachedJS(jsxHash, compiled.js, compiled.metafile);
            }
          }
          if (compiled.error) errorKind = "transpile";
        }

        if (compiled.error) {
          node.error(
            (errorKind === "component"
              ? `Component "${errorSource}" syntax error: `
              : errorKind === "missing-return"
              ? "App component has no return statement: "
              : "JSX transpile error: ") + compiled.error,
          );
          // Status + WS frames handled below (lastGood-aware).
        } else {
          updateStatus();
          if (compiled.metafile) {
            const output = Object.values(compiled.metafile.outputs)[0];
            const sizes = output
              ? Object.entries(output.inputs)
                  .map(([name, info]) => ({
                    name: name
                      .replace(/^.*node_modules\//, "")
                      .replace(/\.(js|mjs|cjs|ts|tsx)$/, ""),
                    bytes: info.bytesInOutput,
                  }))
                  .sort((a, b) => b.bytes - a.bytes)
                  .slice(0, 5)
              : [];
            const totalKB = Math.round(compiled.js.length / 1024);
            const top = sizes
              .map((s) => `${s.name} ${Math.round(s.bytes / 1024)}`)
              .join(" · ");
            node.log(
              `[${node.id}] ${cacheHit ? "cached" : "built"} ${totalKB}KB · ${top}`,
            );
          }
        }

        const contentHash = compiled.js ? hash(compiled.js) : "";

        // ── CSS: disk cache → in-memory → generate ──
        const cssReady = !compiled.error
          ? (() => {
              const cachedCSS = readCachedCSS(jsxHash);
              if (cachedCSS) return Promise.resolve(cachedCSS);
              if (prevState?.jsxHash === jsxHash && prevState?.css) {
                return Promise.resolve({
                  css: prevState.css,
                  cssHash: prevState.cssHash,
                });
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

        lastJsxHash = jsxHash;

        // Preserve last successful build so that on transpile errors we keep
        // serving the previous working JS instead of throwing clients to an error page.
        const lastGood = compiled.error
          ? prevState?.lastGood || null
          : null; // will be populated after cssReady resolves on success

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
          errorSource,
          errorKind,
          lastGood,
        };

        if (compiled.error) {
          // Status text (red) handled centrally by updateStatus — it formats
          // base + "(serving last good)" + client-count suffix consistently
          // across build and connect/disconnect events.
          updateStatus();
          const frame = lastGood
            ? JSON.stringify({ type: "error", message: compiled.error, degraded: true })
            : JSON.stringify({ type: "error", message: compiled.error });
          clients.forEach((ws) => {
            try { if (ws.readyState === 1) ws.send(frame); } catch (e) { RED.log.trace("[portal-react] ws send error: " + e.message); }
          });
        }

        // Notify all connected browsers that build finished — triggers reload or overlay cleanup
        if (!compiled.error && contentHash) {
          const versionFrame = JSON.stringify({ type: "version", hash: contentHash });
          clients.forEach((ws) => {
            try { if (ws.readyState === 1) ws.send(versionFrame); } catch (e) { RED.log.trace("[portal-react] ws send version: " + e.message); }
          });
        }

        cssReady.then(({ css, cssHash }) => {
          const state = pageState[endpoint];
          if (state && state.jsxHash === jsxHash) {
            state.css = css;
            state.cssHash = cssHash;
            // Snapshot current good build so future failed builds can fall back.
            if (!state.compiled.error && state.compiled.js) {
              state.lastGood = {
                compiledJs: state.compiled.js,
                contentHash: state.contentHash,
                cssHash,
                pageTitle: state.pageTitle,
                customHead: state.customHead,
              };
            }
            updateStatus();
          }
        });
      } catch (e) {
        node.error("Rebuild failed: " + e.message);
        // Surface as a regular build error so the lastGood/degraded path,
        // status formatting and FE error frame all run uniformly.
        const prev = pageState[endpoint];
        pageState[endpoint] = {
          compiled: { js: null, error: "Internal rebuild error: " + e.message },
          contentHash: "",
          cssReady: Promise.resolve({ css: "", cssHash: "" }),
          jsxHash: "",
          css: null,
          cssHash: "",
          pageTitle,
          wsPath,
          customHead,
          portalAuth,
          showWsStatus,
          errorSource: null,
          errorKind: "rebuild",
          lastGood: prev?.lastGood || null,
        };
        updateStatus();
        const frame = JSON.stringify({
          type: "error",
          message: "Internal rebuild error: " + e.message,
          degraded: !!prev?.lastGood,
        });
        clients.forEach((ws) => {
          try { if (ws.readyState === 1) ws.send(frame); } catch (err) { RED.log.trace("[portal-react] ws send rebuild err: " + err.message); }
        });
      }
    }

    // Register rebuild callback so library components can trigger re-transpile
    rebuildCallbacks[nodeId] = rebuild;
    // Remember raw user JSX so selective rebuild can detect references to new components
    portalCode[nodeId] = componentCode;

    // No-op redeploy detection: if nothing in the portal's config changed AND a valid
    // build already exists for this endpoint, skip rebuild. Node-RED Full deploy
    // reconstructs every node even when unchanged — without this check every portal
    // would rebuild on every Full deploy.
    const sig = hash(
      [
        componentCode,
        JSON.stringify(libs),
        pageTitle,
        customHead,
        String(portalAuth),
        String(showWsStatus),
      ].join("\0"),
    );
    const prevSig = portalSig[nodeId];
    const existing = pageState[endpoint];
    const hasValidBuild =
      !!existing && !existing.building && !existing.compiled?.error;
    portalSig[nodeId] = sig;

    if (prevSig !== sig || !hasValidBuild) {
      scheduleRebuildSelf(nodeId);
    } else {
      node.log(`[${nodeId}] unchanged — skipping rebuild`);
      updateStatus();
    }
    setImmediate(() => {
      // Register route only once per endpoint (persists across deploys)
      if (!registeredRoutes[endpoint]) {
        RED.httpNode.get(endpoint, async function (_req, res) {
          try {
            const state = pageState[endpoint];
            if (!state || state.building) {
              const bWsPath = state?.wsPath || wsPath;
              res
                .set("Cache-Control", "no-store")
                .type("text/html")
                .send(
                  `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Building\u2026</title><style>@keyframes __sp{to{transform:rotate(360deg)}}body{font-family:monospace;background:#111;color:#888;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}</style></head><body><div style="font-size:24px;margin-bottom:16px">Building\u2026</div><div style="width:40px;height:40px;border:3px solid #333;border-top-color:#888;border-radius:50%;animation:__sp .8s linear infinite"></div><script>(function(){var r=0;function c(){var p=location.protocol==='https:'?'wss:':'ws:';var ws=new WebSocket(p+'//'+location.host+'${bWsPath}');ws.onmessage=function(e){try{var m=JSON.parse(e.data);if((m.type==='version'&&m.hash)||m.type==='error')location.reload();}catch(_){}};ws.onclose=function(){var d=Math.min(500*Math.pow(2,r),8000);r++;setTimeout(c,d);};ws.onerror=function(){ws.close();};}c();})()</script></body></html>`,
                );
              return;
            }
            res.set("Cache-Control", "no-store");
            if (state.compiled.error) {
              if (state.lastGood) {
                // Degraded: serve previous good build, banner-only error UI.
                const user = state.portalAuth
                  ? extractPortalUser(_req.headers)
                  : null;
                res
                  .type("text/html")
                  .send(
                    buildPage(
                      state.lastGood.pageTitle,
                      state.lastGood.compiledJs,
                      state.wsPath,
                      state.lastGood.customHead,
                      state.lastGood.cssHash,
                      user,
                      state.showWsStatus,
                      adminRoot,
                    ),
                  );
                return;
              }
              res
                .status(500)
                .type("text/html")
                .send(
                  buildErrorPage(
                    state.pageTitle,
                    state.compiled.error,
                    state.wsPath,
                  ),
                );
              return;
            }
            const { cssHash } = await Promise.race([
              state.cssReady,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("CSS generation timeout")),
                  15000,
                ),
              ),
            ]);
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
          } catch (e) {
            res
              .status(500)
              .type("text/html")
              .send(
                buildErrorPage(
                  pageTitle,
                  "Page build failed: " + e.message,
                  wsPath,
                ),
              );
          }
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
            // Plugin hook: plugins may reject the connection before upgrade.
            // Default (no plugins) = allowed, matches dashboard behavior.
            if (!hooks.allow("onIsValidConnection", request)) {
              try { socket.destroy(); } catch (e) { RED.log.trace("[portal-react] socket destroy: " + e.message); }
              return;
            }
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

          // Index by userId for O(1) user-cast routing
          const userId = ws._portalUser && ws._portalUser.userId;
          if (userId) {
            let set = userIndex.get(userId);
            if (!set) {
              set = new Set();
              userIndex.set(userId, set);
            }
            set.add(ws);
          }

          updateStatus();

          // Send content version for deploy-reload detection.
          // In degraded mode (current build failed but lastGood served), advertise
          // the lastGood hash so the freshly reloaded client matches the JS we sent.
          const cs = pageState[endpoint];
          const contentHash =
            cs?.compiled?.error && cs?.lastGood
              ? cs.lastGood.contentHash
              : cs?.contentHash || "";
          wsSend(ws, { type: "version", hash: contentHash });

          // Send assigned portalClient to browser
          wsSend(ws, { type: "hello", portalClient });

          // Degraded warning — show banner, not full overlay.
          if (cs?.compiled?.error && cs?.lastGood) {
            wsSend(ws, {
              type: "error",
              message: cs.compiled.error,
              degraded: true,
            });
          }

          // Send the cached last broadcast (if any) as a distinct
          // `recovery` frame. The browser uses this to seed `data` on a
          // fresh connection. React components can opt out via
          // useNodeRed({ ignoreRecovery: true }).
          if (lastBroadcastCache.has(endpoint)) {
            wsSend(ws, { type: "recovery", payload: lastBroadcastCache.get(endpoint) });
          }

          // Heartbeat — detect dead sockets via WS ping/pong. Browser
          // auto-replies to ping frames, no client JS needed.
          ws._isAlive = true;
          ws.on("pong", () => { ws._isAlive = true; });
          ws._pingIv = setInterval(() => {
            if (ws._isAlive === false) {
              try { ws.terminate(); } catch (e) { RED.log.trace("[portal-react] ws terminate: " + e.message); }
              return;
            }
            ws._isAlive = false;
            try { ws.ping(); } catch (e) { RED.log.trace("[portal-react] ws ping: " + e.message); }
          }, 30000);

          ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === "runtime_error") {
                // Browser caught an exception while running the bundle —
                // surface it on node status so the editor shows red even
                // when the build itself succeeded (e.g. ReferenceError to
                // an undefined identifier or missing component).
                const st = pageState[endpoint];
                if (st && !(st.compiled && st.compiled.error)) {
                  st.runtimeError = String(msg.message || "")
                    .split("\n")[0]
                    .slice(0, 200);
                  node.error("Runtime error in browser: " + st.runtimeError);
                  updateStatus();
                }
                return;
              }
              if (msg.type === "output") {
                let out = {
                  payload: msg.payload,
                  topic: msg.topic || "",
                };
                // Server-side identity injection — the client cannot forge
                // _client because we build it from ws state, not from the
                // inbound frame.
                const client = { portalClient: ws._portalClient };
                if (portalAuth && ws._portalUser) {
                  Object.assign(client, ws._portalUser);
                }
                out._client = client;
                // Transform hook — plugins may mutate / drop the msg.
                // A hook returning null signals "drop this message".
                out = hooks.transform("onInbound", out, ws);
                if (out) node.send(out);
                return;
              }
            } catch (e) {
              node.warn("Bad WS message: " + e.message);
            }
          });

          const detach = () => {
            if (ws._pingIv) { clearInterval(ws._pingIv); ws._pingIv = null; }
            clients.delete(portalClient);
            if (userId) {
              const set = userIndex.get(userId);
              if (set) {
                set.delete(ws);
                if (set.size === 0) userIndex.delete(userId);
              }
            }
            updateStatus();
          };

          ws.on("close", detach);
          ws.on("error", detach);
        });
      } catch (e) {
        node.error("WebSocket setup failed: " + e.message);
      }

      // ── Input handler ─────────────────────────────────────────

      // sendTo: single point where every outbound frame passes through
      // the onCanSendTo hook. Strict-by-default — no opt-in per widget
      // type like dashboard's acceptsClientConfig.
      function sendTo(ws, frame, msg) {
        if (!ws || ws.readyState !== 1) return false;
        if (!hooks.allow("onCanSendTo", ws, msg)) return false;
        try {
          ws.send(frame);
          return true;
        } catch (e) {
          RED.log.trace("[portal-react] ws send frame: " + e.message);
          return false;
        }
      }

      node.on("input", (msg, send, done) => {
        const result = router.route(msg, { clients, userIndex, sendTo });
        // Cache the latest broadcast payload so freshly-connected clients
        // can recover it via the `recovery` frame on connect.
        if (result.mode === "broadcast") {
          lastBroadcastCache.set(endpoint, msg.payload);
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

        // Close all WS clients — clear heartbeat interval BEFORE ws.close()
        // so pending pings do not leak if the 'close' event is delayed.
        clients.forEach((ws) => {
          if (ws._pingIv) { clearInterval(ws._pingIv); ws._pingIv = null; }
          try {
            ws.close(1001, "node redeployed");
          } catch (e) { RED.log.trace("[portal-react] ws close client: " + e.message); }
        });
        clients.clear();

        // Close WS server
        if (wsServer) {
          try {
            wsServer.close();
          } catch (e) { RED.log.trace("[portal-react] wsServer close: " + e.message); }
          wsServer = null;
        }

        // Unregister rebuild callback + selective-rebuild metadata
        delete rebuildCallbacks[nodeId];
        delete portalNeeded[nodeId];
        delete portalCode[nodeId];

        // Release endpoint ownership
        if (endpointOwners[endpoint] === nodeId) {
          delete endpointOwners[endpoint];
        }

        // Drop the recovery cache only on full node removal — on a
        // redeploy we keep it so reconnecting clients still recover.
        if (removed) {
          lastBroadcastCache.delete(endpoint);
          delete portalSig[nodeId];
        }

        // Clear the userIndex — WS clients are already closed above, but
        // the Map itself should not outlive the node instance.
        userIndex.clear();

        // Break references to large objects / Promises in pageState even on
        // redeploy. Next rebuild overwrites pageState[endpoint] anyway, but
        // between close and the new build these would retain closures over
        // the old clients/userIndex/rebuild scope.
        const st = pageState[endpoint];
        if (st) {
          st.cssReady = null;
          st.compiled = null;
          st.css = null;
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
        } catch (e) { RED.log.trace("[portal-react] wsSend: " + e.message); }
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
    const { name, code } = req.body || {};
    if (!isSafeName(name))
      return res.status(400).json({ error: "invalid name" });
    const newCode = code || "";
    const prevCode = registry[name]?.code;
    registry[name] = { code: newCode };
    if (prevCode !== newCode) {
      scheduleRebuildUsing(name);
    }
    res.json({ ok: true });
  });

  RED.httpAdmin.delete("/portal-react/registry/:name", (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name))
      return res.status(400).json({ error: "invalid name" });
    const existed = Object.prototype.hasOwnProperty.call(registry, name);
    delete registry[name];
    if (existed) {
      scheduleRebuildUsing(name);
    }
    res.json({ ok: true });
  });
};

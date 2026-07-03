/** @module @aaqu/fromcubes-portal-react */

/**
 * Node-RED node that serves React apps from configurable HTTP endpoints
 * with live WebSocket data binding. JSX is transpiled server-side via esbuild
 * at deploy time — browsers receive pre-compiled JS.
 *
 * Module-global state lives on `RED.settings.portalReact*` so it survives
 * Full deploys (Node-RED closes and re-opens every node on a Full deploy;
 * the `RED.settings` namespace persists across that cycle).
 */

/**
 * @typedef {Object} LibSpec
 * @property {string} module          npm package name (auto-installed at deploy).
 * @property {string} [var]           Optional global var name when bundled.
 */

/**
 * @typedef {Object} PortalConfig
 * @property {string}  subPath           URL segment served under `/fromcubes/<subPath>`.
 * @property {string}  [endpoint]        Legacy field — hard-fails on deploy if subPath empty.
 * @property {string}  componentCode     User JSX entrypoint (must declare `function App`).
 * @property {string}  [pageTitle]       `<title>` for the served HTML page.
 * @property {string}  [customHead]      Raw HTML injected into `<head>` (trusted-author content).
 * @property {boolean} [portalAuth]      Read `x-portal-user-*` headers from incoming HTTP requests.
 * @property {boolean} [showWsStatus]    Render the in-page `#__cs` connection badge.
 * @property {Array<LibSpec>} [libs]    npm packages auto-installed at deploy via `dynamicModuleList`.
 */

/**
 * @typedef {Object} ClientInfo
 * @property {string}                  portalClient  Server-assigned per-tab UUID.
 * @property {string}                  [userId]
 * @property {string}                  [userName]
 * @property {string}                  [username]
 * @property {string}                  [email]
 * @property {string}                  [role]
 * @property {string|Array<string>}    [groups]
 */

/**
 * @typedef {Object} MessagePayload
 * @property {*}            payload
 * @property {string}       [topic]
 * @property {ClientInfo}   [_client]    Server-side identity (set on outbound WS msgs).
 */

/**
 * @typedef {Object} RouteResult
 * @property {"unicast"|"user-cast"|"broadcast"} mode
 * @property {number} delivered
 */

/**
 * @typedef {Object} CompiledBundle
 * @property {?string}  js
 * @property {?string}  error
 * @property {Object}   [metafile]      esbuild metafile (size analysis).
 */

/**
 * @typedef {Object} ComponentNodeConfig
 * @property {string}  [name]
 * @property {string}  compName
 * @property {string}  compCode
 */

/**
 * @typedef {Object} UtilityNodeConfig
 * @property {string}  [name]
 * @property {string}  utilName
 * @property {string}  utilCode
 */

/**
 * @typedef {Object} PageState
 * @property {CompiledBundle} compiled
 * @property {string}  contentHash       sha256-16 of the compiled JS.
 * @property {string}  jsxHash
 * @property {Promise<{css: string, cssHash: string}>} cssReady
 * @property {?string} css
 * @property {string}  cssHash
 * @property {string}  pageTitle
 * @property {string}  wsPath
 * @property {string}  customHead
 * @property {boolean} portalAuth
 * @property {boolean} showWsStatus
 * @property {?string} errorSource       Component / utility name responsible for the build error.
 * @property {?string} errorKind         'component' | 'utility' | 'missing-component' | 'missing-return' | 'transpile' | 'rebuild'
 * @property {?Object} lastGood          Snapshot of the previous successful build (degraded-mode fallback).
 * @property {boolean} [cssError]        Tailwind generation failed on the last attempt.
 * @property {boolean} [building]
 * @property {?string} [runtimeError]    Browser-reported exception (truncated).
 */

const crypto = require("crypto");
const packageInfo = require("../package.json");

const CACHE_SCHEMA_VERSION = "portal-react-cache-v2";

module.exports = function (RED) {
  // ── Admin root prefix (for correct URLs when httpAdminRoot is set) ──
  const adminRoot = (RED.settings.httpAdminRoot || "/").replace(/\/$/, "");
  const nodeRoot = (RED.settings.httpNodeRoot || "/").replace(/\/$/, "");

  // ── Admin auth gate (Node-RED 4.x adminAuth) ─────────────────
  // When the user configures `adminAuth` in settings.js, RED.auth.needsPermission
  // returns an Express middleware that enforces the named permission scope.
  // Without this gate, any endpoint mounted on RED.httpAdmin is reachable
  // without auth and can read/modify the registry, utilities, and assets.
  // Fallback no-op for runtimes that do not expose RED.auth.
  /**
   * Resolve a Node-RED permission middleware. Returns a no-op when the runtime
   * does not expose `RED.auth.needsPermission` (test harnesses, Node-RED <1.0)
   * so unit tests don't have to mock auth.
   *
   * @param {string} scope  Permission scope (e.g. `"portal-react.write"`).
   * @returns {import("express").RequestHandler}
   * @private
   */
  function needsPerm(scope) {
    if (RED.auth && typeof RED.auth.needsPermission === "function") {
      return RED.auth.needsPermission(scope);
    }
    return function (_req, _res, next) { next(); };
  }
  const PERM_READ = needsPerm("portal-react.read");
  const PERM_WRITE = needsPerm("portal-react.write");

  // ── CSRF guard for admin write endpoints ──────────────────────
  // The Node-RED editor sends `Node-RED-API-Version` on every XHR. Browsers
  // refuse to attach custom headers on cross-origin form/fetch submissions
  // without a CORS preflight, so requiring this header on write endpoints is
  // sufficient CSRF protection without per-session tokens. Same trick the
  // Node-RED core admin API uses for its own POST/PUT/DELETE routes.
  /**
   * Express middleware enforcing the `Node-RED-API-Version` header on write
   * endpoints. The header is sent by the Node-RED editor XHR layer on every
   * request; browser cross-origin form/fetch POSTs cannot attach custom
   * headers without a CORS preflight, so requiring this header gives CSRF
   * protection without per-session tokens.
   *
   * @param {import("express").Request}  req
   * @param {import("express").Response} res
   * @param {Function}                   next
   * @returns {void}
   * @private
   */
  function csrfGuard(req, res, next) {
    if (!req.get("Node-RED-API-Version")) {
      return res.status(403).json({ error: "missing Node-RED-API-Version header" });
    }
    next();
  }

  // ── Token-bucket rate limiter keyed by req.ip ─────────────────
  // Steady-state: RATE_LIMIT_TOKENS tokens refilled over RATE_LIMIT_WINDOW_MS.
  // Default = 60 tokens / 60 s → 1 req/s sustained, 60 burst. Tunable via
  // RED.settings.portalReact.rateLimit = { tokens, windowMs }. The buckets
  // are pruned every 5 minutes to bound memory usage.
  const rateLimitCfg = (RED.settings.portalReact &&
    RED.settings.portalReact.rateLimit) || {};
  const RATE_LIMIT_TOKENS = Number.isFinite(rateLimitCfg.tokens)
    ? rateLimitCfg.tokens
    : 60;
  const RATE_LIMIT_WINDOW_MS = Number.isFinite(rateLimitCfg.windowMs)
    ? rateLimitCfg.windowMs
    : 60_000;
  if (!RED.settings.portalReactRateBuckets) RED.settings.portalReactRateBuckets = new Map();
  const rateBuckets = RED.settings.portalReactRateBuckets;

  /**
   * Token-bucket rate limit middleware keyed by `req.ip`. Each bucket refills
   * `RATE_LIMIT_TOKENS` over `RATE_LIMIT_WINDOW_MS`. Steady-state default is
   * 1 request/second with a 60-token burst. On exhaustion: HTTP 429 with
   * `Retry-After`. Buckets idle > 10 minutes get pruned by a separate
   * interval (see below).
   *
   * @param {import("express").Request}  req
   * @param {import("express").Response} res
   * @param {Function}                   next
   * @returns {void}
   * @private
   */
  function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b) {
      b = { tokens: RATE_LIMIT_TOKENS, last: now };
      rateBuckets.set(ip, b);
    }
    const elapsed = now - b.last;
    b.tokens = Math.min(
      RATE_LIMIT_TOKENS,
      b.tokens + (elapsed * RATE_LIMIT_TOKENS) / RATE_LIMIT_WINDOW_MS,
    );
    b.last = now;
    if (b.tokens < 1) {
      res.set("Retry-After", Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
      return res.status(429).json({ error: "rate limit exceeded" });
    }
    b.tokens -= 1;
    next();
  }

  if (!RED.settings.portalReactRateBucketPruneIv) {
    RED.settings.portalReactRateBucketPruneIv = setInterval(() => {
      const now = Date.now();
      for (const [ip, b] of rateBuckets) {
        if (now - b.last > 10 * 60_000) rateBuckets.delete(ip);
      }
    }, 5 * 60_000);
    RED.settings.portalReactRateBucketPruneIv.unref?.();
  }

  // ── Standard JSON parser with 1 MB limit ──────────────────────
  // Applied per-route on POSTs that read req.body. 1 MB easily fits even
  // large component files, and protects the registry endpoints from being
  // used as a denial-of-service vector.
  const JSON_BODY_LIMIT = "1mb";

  // ── Status text helper ───────────────────────────────────────
  // Node-RED appearance docs recommend status text "around 20 characters".
  // Truncate with an ellipsis so long error fragments, component names, or
  // endpoint paths don't spill past the node tile.
  const STATUS_MAX = 20;
  /**
   * Truncate a status text to at most `STATUS_MAX` characters, replacing the
   * final character with an ellipsis when truncation occurs. Keeps node tile
   * width predictable per the Node-RED appearance guidelines.
   *
   * @param {*} s
   * @returns {string}
   */
  function shortStatus(s) {
    s = String(s == null ? "" : s);
    return s.length <= STATUS_MAX ? s : s.slice(0, STATUS_MAX - 1) + "…";
  }

  // ── Shared state ──────────────────────────────────────────────
  // Component registry: populated by fc-portal-component canvas nodes at deploy time
  if (!RED.settings.portalReactComponentRegistry) {
    RED.settings.portalReactComponentRegistry = {};
  }
  const registry = RED.settings.portalReactComponentRegistry;

  // Active upgrade handlers per node id (for cleanup on redeploy)
  if (!RED.settings.portalReactUpgradeHandlers) {
    RED.settings.portalReactUpgradeHandlers = {};
  }
  const upgradeHandlers = RED.settings.portalReactUpgradeHandlers;

  // Live page state per endpoint — route handlers read from this on each request
  if (!RED.settings.portalReactPageState) {
    RED.settings.portalReactPageState = {};
  }
  const pageState = RED.settings.portalReactPageState;

  // Track which endpoints already have a registered Express route
  if (!RED.settings.portalReactRegisteredRoutes) {
    RED.settings.portalReactRegisteredRoutes = {};
  }
  const registeredRoutes = RED.settings.portalReactRegisteredRoutes;

  // Rebuild callbacks: portal-react nodes register here so components can trigger re-transpile
  if (!RED.settings.portalReactRebuildCallbacks) {
    RED.settings.portalReactRebuildCallbacks = {};
  }
  const rebuildCallbacks = RED.settings.portalReactRebuildCallbacks;

  // Per-portal set of component names the portal depends on (needed set from last rebuild,
  // including transitive deps). Lets component changes target only portals that use them.
  if (!RED.settings.portalReactPortalNeeded) {
    RED.settings.portalReactPortalNeeded = {};
  }
  const portalNeeded = RED.settings.portalReactPortalNeeded;

  // Per-portal raw user JSX code string. Used as fallback to detect references to
  // newly-added components that haven't been in a `needed` set yet.
  if (!RED.settings.portalReactPortalCode) {
    RED.settings.portalReactPortalCode = {};
  }
  const portalCode = RED.settings.portalReactPortalCode;

  // Track endpoint ownership: { endpoint: nodeId } — prevents duplicate endpoints
  if (!RED.settings.portalReactEndpointOwners) {
    RED.settings.portalReactEndpointOwners = {};
  }
  const endpointOwners = RED.settings.portalReactEndpointOwners;

  // Track the endpoint each portal node currently serves: { nodeId: endpoint }.
  // A sub-path change arrives as a plain redeploy (close(removed=false)), which
  // intentionally keeps routes and pageState alive — without this map the old
  // URL would keep serving the holding page forever. The constructor compares
  // against this map and tears down the previous endpoint on mismatch.
  if (!RED.settings.portalReactNodeEndpoints) {
    RED.settings.portalReactNodeEndpoints = {};
  }
  const nodeEndpoints = RED.settings.portalReactNodeEndpoints;

  // Track component name ownership: { compName: nodeId } — prevents duplicate component names
  // Shared namespace with fc-portal-utility nodes so a component and a utility
  // can never share the same name.
  if (!RED.settings.portalReactCompNameOwners) {
    RED.settings.portalReactCompNameOwners = {};
  }
  const compNameOwners = RED.settings.portalReactCompNameOwners;

  // Utility registry: populated by fc-portal-utility canvas nodes at deploy time.
  // Keyed by node-level utilName (e.g. "mathHelpers"), value { code, error }.
  // Each utility node may declare multiple top-level symbols inside its code block.
  if (!RED.settings.portalReactUtilities) {
    RED.settings.portalReactUtilities = {};
  }
  const utilities = RED.settings.portalReactUtilities;

  // Per-portal set of utility node names this portal depends on (transitively).
  // Lets utility code changes target only portals that reference at least one
  // symbol declared by the changed utility node.
  if (!RED.settings.portalReactNeededUtilities) {
    RED.settings.portalReactNeededUtilities = {};
  }
  const portalNeededUtilities = RED.settings.portalReactNeededUtilities;

  // Track owner of each top-level symbol declared inside fc-portal-utility nodes:
  // { symbol: utilName }. Lets us catch collisions upfront (component-name vs
  // utility-symbol, utility-symbol vs utility-symbol from another node) before
  // they reach esbuild, where the diagnostic would surface on the portal node
  // as a confusing transpile error rather than on the offending utility node.
  if (!RED.settings.portalReactUtilSymbolOwners) {
    RED.settings.portalReactUtilSymbolOwners = {};
  }
  const utilSymbolOwners = RED.settings.portalReactUtilSymbolOwners;

  // Per-portal config signature — detects no-op Full-deploy reconstructions so unchanged
  // portals skip rebuild entirely (Node-RED closes/reopens every node on Full deploy).
  if (!RED.settings.portalReactSig) {
    RED.settings.portalReactSig = {};
  }
  const portalSig = RED.settings.portalReactSig;

  const {
    createWsHeartbeat,
  } = require("./lib/ws-heartbeat");
  const {
    registerPingedServer,
    unregisterPingedServer,
  } = createWsHeartbeat(RED);

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
  /**
   * Lift the startup gate and flush any pending rebuild work. Called once
   * from `flows:started` and once again from a 2 s failsafe `setTimeout`;
   * idempotent.
   * @returns {void}
   * @private
   */
  function _endStartupPhase() {
    if (!_startupPhase) return;
    _startupPhase = false;
    if (_dirtyPortals.size > 0 || _dirtyComps.size > 0) {
      if (_rebuildTimer) { clearTimeout(_rebuildTimer); _rebuildTimer = null; }
      _flushRebuild();
    }
  }
  try {
    // Subscribed ONCE per process (not per deploy).
    // Component registry is module-global state that persists across deploys.
    // Re-running this handler on every deploy would duplicate work without
    // benefit. For per-deploy hooks use RED.events.on('flows:started', ...)
    // with dedup.
    if (RED.events && typeof RED.events.once === "function") {
      RED.events.once("flows:started", _endStartupPhase);
    }
  } catch (e) { RED.log.trace("[portal-react] events.once: " + e.message); }
  // Failsafe: if flows:started never arrives (module loaded mid-run, test harness, etc.)
  setTimeout(_endStartupPhase, 2000).unref?.();

  /**
   * Debounce arm — defer the next rebuild flush by 50 ms. During the
   * startup phase the arm is a no-op; `_endStartupPhase` flushes directly.
   * @returns {void}
   * @private
   */
  function _armRebuild() {
    if (_startupPhase) return; // gated — _endStartupPhase will flush
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(_flushRebuild, 50);
    _rebuildTimer.unref?.();
  }
  /**
   * Mark a portal node id as needing rebuild on the next flush. Used by
   * the portal constructor when its own config signature changed.
   * @param {string} nodeId
   */
  function scheduleRebuildSelf(nodeId) {
    if (!nodeId) return;
    _dirtyPortals.add(nodeId);
    _armRebuild();
  }
  /**
   * Mark a component / utility symbol as dirty. The next flush re-builds
   * every portal that references the symbol (via `portalNeeded`,
   * `portalNeededUtilities` or a raw-code regex scan in `portalCode`).
   * @param {string} compName
   */
  function scheduleRebuildUsing(compName) {
    if (!compName) return;
    _dirtyComps.add(compName);
    _armRebuild();
  }
  /**
   * Run pending rebuild callbacks. Resolves the union of:
   *  - portal ids in `_dirtyPortals` (self-trigger), AND
   *  - every portal whose `portalNeeded` / `portalNeededUtilities` / raw
   *    code references any name in `_dirtyComps`.
   * Each callback runs through `setImmediate` chaining so the event loop
   * stays responsive between heavy esbuild passes.
   * @returns {void}
   * @private
   */
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
        const usedComps = portalNeeded[nodeId];
        const usedUtils = portalNeededUtilities[nodeId];
        const raw = portalCode[nodeId] || "";
        for (const name of dirty) {
          if (
            (usedComps && usedComps.has(name)) ||
            (usedUtils && usedUtils.has(name)) ||
            // Identifier-boundary match, not substring — a dirty `Button`
            // must not rebuild portals that only use `ButtonGroup`.
            identifierRe(name).test(raw)
          ) {
            targetIds.add(nodeId);
            break;
          }
        }
      }
    }

    const fns = [...targetIds].map((id) => rebuildCallbacks[id]).filter(Boolean);
    let i = 0;
    /**
     * Trampoline over the rebuild list — awaits each (async) rebuild so
     * builds run sequentially, and yields to the event loop between
     * iterations so a heavy queue does not block the HTTP server.
     * @returns {Promise<void>}
     * @private
     */
    async function next() {
      if (i >= fns.length) return;
      try { await fns[i](); } catch (e) { RED.log.error("[portal-react] rebuild failed: " + e.message); }
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
    serveableHash,
    hasFreshBuild,
    removeRoute,
    isSafeName,
    validateSubPath,
    findMissingComponentRefs,
    identifierRe,
    userDir,
    readCachedJS,
    writeCachedJS,
    readCachedCSS,
    writeCachedCSS,
    deleteCacheFiles,
    isHashInUse,
  } = helpers;
  const { buildPage, buildErrorPage } = require("./lib/page-builder");
  const { createPortalPageHandler } = require("./lib/portal-page-route");
  const {
    extractUtilitySymbols,
    registerRegistryNodes,
  } = require("./lib/registry-nodes");
  const hooks = require("./lib/hooks")(RED);
  const router = require("./lib/router");

  // Per-process cache of the last broadcast payload per endpoint.
  // Lets a freshly-connected client see the most recent broadcast value
  // (similar to dashboard2's lastMsg recovery). Sent as a distinct
  // `recovery` WS frame so React can opt out via useNodeRed({ ignoreRecovery: true }).
  const lastBroadcastCache = new Map();

  registerRegistryNodes(RED, {
    registry,
    utilities,
    compNameOwners,
    utilSymbolOwners,
    isSafeName,
    quickCheckSyntax,
    shortStatus,
    scheduleRebuildUsing,
  });

  // ── Main node: portal-react ───────────────────────────────────

  /**
   * Main canvas node: serves a React app at `/fromcubes/<subPath>` and
   * bridges its WebSocket to Node-RED wires.
   *
   * Lifecycle (per deploy):
   *   1. Validate subPath / legacy endpoint migration.
   *   2. Take ownership of the endpoint (one portal per URL).
   *   3. Compute the config signature — skip rebuild if unchanged.
   *   4. Register rebuild callback in `rebuildCallbacks`.
   *   5. Inside `setImmediate`: mount HTTP route, attach WS upgrade handler,
   *      wire `input` + `close` events.
   *
   * Input handler routes incoming `msg` through `lib/router.js` and caches
   * the payload (deep-cloned) when broadcasting so freshly-connected clients
   * recover the last value.
   *
   * @param {PortalConfig} config
   * @returns {void}
   * @fires Node-RED#close
   * @listens Node-RED#input
   * @listens ws#connection
   * @private
   */
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
        done();
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
        text: shortStatus("dup: " + subPath),
      });
      node.on("close", function (_removed, done) {
        done();
      });
      return;
    }
    endpointOwners[endpoint] = nodeId;

    // ── Sub-path changed on redeploy → tear down the previous endpoint ──
    // Route, pageState, cache and recovery entries of the old URL must go,
    // or it keeps serving the "Building…" holding page until restart.
    const prevEndpoint = nodeEndpoints[nodeId];
    if (prevEndpoint && prevEndpoint !== endpoint) {
      const oldSt = pageState[prevEndpoint];
      if (oldSt?.jsxHash && !isHashInUse(oldSt.jsxHash, pageState, prevEndpoint)) {
        deleteCacheFiles(oldSt.jsxHash);
      }
      delete pageState[prevEndpoint];
      removeRoute(RED.httpNode._router, prevEndpoint);
      delete registeredRoutes[prevEndpoint];
      if (endpointOwners[prevEndpoint] === nodeId) {
        delete endpointOwners[prevEndpoint];
      }
      lastBroadcastCache.delete(prevEndpoint);
    }
    nodeEndpoints[nodeId] = endpoint;

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

    /**
     * Refresh the canvas-node status indicator. Priority of states (highest
     * first): build error > building > runtime error > CSS-fail >
     * connected/0-clients. Returns early when the node is closing so a late
     * rebuild promise can't flash a stale state on a torn-down node.
     * @returns {void}
     * @private
     */
    function updateStatus() {
      if (isClosing) return;
      const st = pageState[endpoint];
      const n = clients.size;
      // Compact tail keeps within the 20-char status budget. Shape (ring vs
      // dot) and fill carry the "0 clients" + "degraded" signals; we no
      // longer pack them into the text.
      const tail = n > 0 ? ` [${n}]` : "";

      if (st && st.compiled && st.compiled.error) {
        let base;
        if (st.errorKind === "missing-component") base = "missing: " + st.errorSource;
        else if (st.errorSource) base = "broken: " + st.errorSource;
        else if (st.errorKind === "missing-app") base = "no App";
        else if (st.errorKind === "missing-return") base = "no return";
        else if (st.errorKind === "rebuild") base = "rebuild err";
        else base = "transpile err";
        // Degraded mode = ring shape (already conveys "serving last good");
        // hard failure = dot. Text stays ≤20.
        node.status({
          fill: "red",
          shape: st.lastGood ? "ring" : "dot",
          text: shortStatus(base + tail),
        });
        return;
      }
      if (st && st.building) {
        node.status({ fill: "yellow", shape: "dot", text: "building…" });
        return;
      }
      if (st && st.runtimeError) {
        node.status({
          fill: "red",
          shape: "ring",
          text: shortStatus("runtime err" + tail),
        });
        return;
      }
      // CSS generation failed but JS is fine — the portal still works,
      // just unstyled. Yellow ring distinguishes from green-OK without
      // claiming "broken". Cleared on the next successful CSS pass.
      if (st && st.cssError) {
        node.status({
          fill: "yellow",
          shape: "ring",
          text: shortStatus("css-fail" + tail),
        });
        return;
      }
      // All status text stays as English literals for now. A full i18n
      // catalog migration is tracked separately — until then, mixing one
      // RED._(...) call with ~10 hardcoded strings would just confuse the
      // reader without giving any locale coverage.
      node.status({
        fill: n > 0 ? "green" : "grey",
        shape: n > 0 ? "dot" : "ring",
        text: n > 0 ? "connected" + tail : "0 clients",
      });
    }

    // ── Rebuild: transpile JSX + update page state ────────────

    /**
     * Transpile and bundle the portal's JSX into a fresh PageState entry.
     *
     * Pipeline (per call):
     *   1. Resolve needed components (transitive deps from registry)
     *   2. Resolve needed utility nodes (any symbol referenced anywhere)
     *   3. Hoist imports, dedupe across sources
     *   4. Pre-flight: syntax errors in components / utilities, missing
     *      `return` in `function App`
     *   5. Read disk cache; on miss run `transpile()` (esbuild buildSync)
     *   6. Generate Tailwind CSS (cssReady promise)
     *   7. Snapshot lastGood for degraded-mode serving
     *   8. Broadcast `version` / `error` / `building` frames to live WS
     *
     * Errors set `pageState[endpoint].compiled.error` and the route handler
     * serves an error page (or the previous lastGood build with a banner).
     *
     * @returns {Promise<void>}
     * @throws never — internal exceptions are caught and stored in pageState.
     * @private
     */
    async function rebuild() {
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

        /**
         * Depth-first walk that pulls a component and every transitively
         * referenced sibling into `needed`. Matching uses `identifierRe`
         * (cached, identifier-boundary) so a component named `Button` does
         * not pull in `ButtonGroup`.
         * @param {string} name
         * @returns {void}
         * @private
         */
        function addWithDeps(name) {
          if (needed.has(name)) return;
          const entry = registry[name];
          if (!entry) return;
          needed.add(name);
          for (const [other] of allEntries) {
            if (other !== name && identifierRe(other).test(entry.code)) {
              addWithDeps(other);
            }
          }
        }

        for (const [name] of allEntries) {
          if (identifierRe(name).test(componentCode)) {
            addWithDeps(name);
          }
        }

        // Remember which components this portal depends on, so component changes
        // can target only affected portals.
        portalNeeded[nodeId] = new Set(needed);

        // ── Selective utility injection ──
        // Each utility node contributes raw top-level code that may declare
        // multiple symbols. Pull the whole node in if the user JSX OR any
        // included library component references at least one of its symbols.
        const allUtilEntries = Object.entries(utilities);
        const utilSymbols = new Map(); // utilName -> Set of symbol names
        for (const [n, u] of allUtilEntries) {
          utilSymbols.set(n, extractUtilitySymbols(u.code || ""));
        }
        const includedLibraryCode = [...needed]
          .map((n) => registry[n]?.code || "")
          .join("\n");
        // identifierRe escapes regex metacharacters and handles `$`-edged
        // names — symbols come from user code, so both matter here.
        const referencesAnySymbol = (text, syms) => {
          for (const s of syms) {
            if (identifierRe(s).test(text)) return true;
          }
          return false;
        };
        const neededUtils = new Set();
        /**
         * Same walk as `addWithDeps` but over utility nodes — a utility is
         * included as soon as any of its top-level symbols is referenced.
         * Transitive: pulled-in utilities can in turn reference others.
         * @param {string} name
         * @returns {void}
         * @private
         */
        function addUtilWithDeps(name) {
          if (neededUtils.has(name)) return;
          const u = utilities[name];
          if (!u) return;
          neededUtils.add(name);
          // Transitively include other utilities referenced by this utility's code
          for (const [other, otherSyms] of utilSymbols) {
            if (other === name) continue;
            if (referencesAnySymbol(u.code || "", otherSyms)) {
              addUtilWithDeps(other);
            }
          }
        }
        const userScanText = componentCode + "\n" + includedLibraryCode;
        for (const [n, syms] of utilSymbols) {
          if (referencesAnySymbol(userScanText, syms)) addUtilWithDeps(n);
        }
        portalNeededUtilities[nodeId] = new Set(neededUtils);

        // Topological sort of needed components (Kahn). Edge b→a when a's
        // code references b, i.e. b must be emitted first. A pairwise
        // Array.sort comparator is NOT transitive over dependency chains
        // (A→B→C without a direct A→C reference), so a real topo sort is
        // required. Cycles (mutual references) fall back to registry
        // insertion order for the remainder.
        const neededNames = allEntries
          .filter(([n]) => needed.has(n))
          .map(([n]) => n);
        const indegree = new Map(neededNames.map((n) => [n, 0]));
        const dependents = new Map(neededNames.map((n) => [n, []]));
        for (const a of neededNames) {
          const codeA = registry[a].code;
          for (const b of neededNames) {
            if (a !== b && identifierRe(b).test(codeA)) {
              dependents.get(b).push(a);
              indegree.set(a, indegree.get(a) + 1);
            }
          }
        }
        const topoQueue = neededNames.filter((n) => indegree.get(n) === 0);
        const ordered = [];
        while (topoQueue.length > 0) {
          const n = topoQueue.shift();
          ordered.push(n);
          for (const d of dependents.get(n)) {
            indegree.set(d, indegree.get(d) - 1);
            if (indegree.get(d) === 0) topoQueue.push(d);
          }
        }
        if (ordered.length < neededNames.length) {
          const emitted = new Set(ordered);
          for (const n of neededNames) if (!emitted.has(n)) ordered.push(n);
        }
        const libraryJsx = ordered
          .map(
            (name) =>
              `// Library: ${name}\nconst ${name} = (() => {\n${registry[name].code}\nreturn ${name};\n})();`,
          )
          .join("\n\n");

        // Build utility block — raw top-level concat of needed utility codes.
        // No IIFE wrapper: a single utility node may declare many symbols.
        const utilityJsx = [...neededUtils]
          .map((n) => `// Utility: ${n}\n${utilities[n].code}`)
          .join("\n\n");

        // Extract import statements from library/utility/user code so they appear at top level
        const importRe = /^import\s+.+?from\s+['"].+?['"];?\s*$/gm;
        const libImports = libraryJsx.match(importRe) || [];
        const userImports = componentCode.match(importRe) || [];
        const utilImports = utilityJsx.match(importRe) || [];
        const cleanLibJsx = libraryJsx.replace(importRe, "").trim();
        const cleanCompCode = componentCode.replace(importRe, "").trim();
        const cleanUtilJsx = utilityJsx.replace(importRe, "").trim();

        // ── Check: JSX references a PascalCase tag with no definition ──
        // Catches the common foot-gun where a portal references a shared
        // component (e.g. <Header/>) without the example flow that defines
        // it being imported. Without this check the bundler silently skips
        // the missing name and the browser crashes with ReferenceError.
        let missingComps = null;
        {
          const knownNames = new Set(Object.keys(registry));
          for (const [, syms] of utilSymbols) {
            for (const s of syms) knownNames.add(s);
          }
          // Use raw componentCode (with imports intact) so the helper can see
          // `import {Canvas} from '@react-three/fiber'` and not flag Canvas
          // as a missing fc-portal-component.
          const miss = findMissingComponentRefs(componentCode, knownNames);
          if (miss.size > 0) missingComps = [...miss].sort();
        }

        // Dedupe imports across all sources (libs may already pull React; user
        // and utility may import the same package).
        const seenImports = new Set();
        const dedupImports = (arr) =>
          arr.filter((s) => {
            const k = s.trim();
            if (seenImports.has(k)) return false;
            seenImports.add(k);
            return true;
          });
        const allLibImports = dedupImports(libImports);
        const allUserImports = dedupImports(userImports);
        const allUtilImports = dedupImports(utilImports);

        // Warn about import * (prevents tree-shaking)
        const starRe = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"](.+?)['"];?\s*$/;
        const allCode = cleanLibJsx + "\n" + cleanUtilJsx + "\n" + cleanCompCode;
        for (const imp of [...allLibImports, ...allUserImports, ...allUtilImports]) {
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
          ...allLibImports,
          ...allUtilImports,
          ...allUserImports,
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
          "// ── Utilities (helpers / hooks / constants) ──",
          cleanUtilJsx,
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

        const jsxHash = hash(
          [CACHE_SCHEMA_VERSION, packageInfo.version, fullJsx].join("\0"),
        );

        // ── Check: any used component or utility has its own syntax error ──
        let errorSource = null;
        let errorSourceKind = null; // 'component' | 'utility'
        for (const name of needed) {
          if (registry[name]?.error) {
            errorSource = name;
            errorSourceKind = "component";
            break;
          }
        }
        if (!errorSource) {
          for (const name of neededUtils) {
            if (utilities[name]?.error) {
              errorSource = name;
              errorSourceKind = "utility";
              break;
            }
          }
        }

        // ── Check: App definition + missing return ──
        const hasAppDefinition =
          /\b(?:export\s+default\s+)?function\s+App\s*\(/.test(cleanCompCode) ||
          /\bclass\s+App\b/.test(cleanCompCode) ||
          /\b(?:const|let|var)\s+App\s*=/.test(cleanCompCode);

        let missingReturn = false;
        const appFnMatch = cleanCompCode.match(
          /(?:export\s+default\s+)?function\s+App\s*\([^)]*\)\s*\{/,
        );
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
        let errorKind = null; // 'component' | 'utility' | 'missing-component' | 'missing-app' | 'missing-return' | 'transpile'
        if (missingComps) {
          const list = missingComps.join(", ");
          const plural = missingComps.length > 1;
          const hint = plural
            ? `Make sure these fc-portal-components exist (e.g. import the "Shared Components" example flow): ${list}.`
            : `Make sure a fc-portal-component named "${missingComps[0]}" exists (e.g. import the "Shared Components" example flow), then redeploy.`;
          compiled = {
            js: null,
            error: `Missing component${plural ? "s" : ""}: ${list}\n\n${hint}`,
          };
          errorKind = "missing-component";
          // Re-use errorSource for status/text — first missing name + count tail.
          errorSource = plural
            ? `${missingComps[0]} +${missingComps.length - 1}`
            : missingComps[0];
        } else if (errorSource) {
          const srcErr =
            errorSourceKind === "utility"
              ? utilities[errorSource].error
              : registry[errorSource].error;
          const label = errorSourceKind === "utility" ? "Utility" : "Component";
          compiled = {
            js: null,
            error: `${label} "${errorSource}" has a syntax error:\n\n${srcErr}`,
          };
          errorKind = errorSourceKind;
        } else if (!hasAppDefinition) {
          compiled = {
            js: null,
            error:
              "App component is required.\n\nAdd a top-level App component, e.g.:\n\nfunction App() {\n  return <div>Hello</div>\n}",
          };
          errorKind = "missing-app";
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
            compiled = await transpile(fullJsx);
            // The await opens a window where close() may have torn this node
            // down (redeploy/removal). Writing pageState now would resurrect
            // state for a dead node — bail out; the successor node's own
            // rebuild owns the endpoint from here.
            if (isClosing) return;
            if (!compiled.error) {
              writeCachedJS(jsxHash, compiled.js, compiled.metafile);
            }
          }
          if (compiled.error) errorKind = "transpile";
        }

        if (compiled.error) {
          node.error(
            (errorKind === "missing-component"
              ? "Missing component(s) in JSX: "
              : errorKind === "component"
              ? `Component "${errorSource}" syntax error: `
              : errorKind === "utility"
              ? `Utility "${errorSource}" syntax error: `
              : errorKind === "missing-app"
              ? "App component is required: "
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
              // cssHash is always jsxHash — generateCSS hashes raw fullJsx
              // (no schema-version prefix), which would give the same CSS a
              // different URL on cache-hit vs cache-miss builds and force a
              // pointless browser refetch after redeploy.
              return generateCSS(fullJsx).then(({ css }) => {
                writeCachedCSS(jsxHash, css);
                return { css, cssHash: jsxHash };
              });
            })().catch((err) => {
              // CSS generation failed (Tailwind compile error, missing
              // entrypoint, etc.). Surface as warn + flag pageState so
              // updateStatus() shows a yellow ring "css-fail" — the portal
              // page still loads (empty CSS), just unstyled. Cleared on
              // the next successful build.
              node.warn("Tailwind CSS generation failed: " + err.message);
              const st = pageState[endpoint];
              if (st) st.cssError = true;
              updateStatus();
              return { css: "", cssHash: "" };
            })
          : Promise.resolve({ css: "", cssHash: "" });

        lastJsxHash = jsxHash;

        // Preserve last successful build so that on transpile errors we keep
        // serving the previous working JS instead of throwing clients to an
        // error page. On success, snapshot IMMEDIATELY (not after cssReady
        // resolves) — a rebuild failing inside that async window must still
        // find a fallback. cssHash is patched in when cssReady settles.
        const lastGood = compiled.error
          ? prevState?.lastGood || null
          : {
              compiledJs: compiled.js,
              contentHash,
              cssHash: "",
              pageTitle,
              customHead,
            };

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

        cssReady
          .then(({ css, cssHash }) => {
            const state = pageState[endpoint];
            if (state && state.jsxHash === jsxHash) {
              state.css = css;
              state.cssHash = cssHash;
              // Clear css-fail flag on a successful generation. Only the
              // outer .catch above sets it, so we don't risk wiping a
              // freshly-set error mid-flight.
              if (cssHash) state.cssError = false;
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
          })
          .catch((e) => {
            // Tail-handler — generateCSS already has its own .catch upstream
            // that yields { css: "", cssHash: "" }. This guards against
            // exceptions thrown inside the state-update block above so the
            // process doesn't see an UnhandledPromiseRejection.
            RED.log.warn("[portal-react] cssReady tail: " + e.message);
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
    // hasFreshBuild also requires `compiled` to be present — close() nulls it on
    // redeploy, and a guard that ignored that (checking only building/error)
    // would treat the destroyed build as valid and skip the rebuild, leaving the
    // GET route serving the holding page forever. See helpers.hasFreshBuild.
    const hasValidBuild = hasFreshBuild(existing);
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
        RED.httpNode.get(
          endpoint,
          createPortalPageHandler({
            endpoint,
            pageState,
            wsPath,
            pageTitle,
            adminRoot,
            buildPage,
            buildErrorPage,
            extractPortalUser,
          }),
        );
        registeredRoutes[endpoint] = true;
      }

      // ── WebSocket ─────────────────────────────────────────────

      try {
        const WebSocket = require("ws");
        // 1 MB hard cap on incoming WS frames — far above typical msg.output
        // sizes (a few KB of JSON) and well below the 100 MB default. Blocks
        // a hostile client from spamming oversized frames.
        wsServer = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
        registerPingedServer(wsServer);

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
          // Only advertise a non-empty hash when there is a page the GET route
          // can actually serve (real build, or degraded lastGood). Advertising
          // a stale hash for a nulled/error state drives the served error page
          // into a reload loop. See helpers.serveableHash.
          const contentHash = serveableHash(cs);
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
          // auto-replies to ping frames, no client JS needed. The actual
          // ping interval lives in the module-level `_pingSweep` tick;
          // each client only needs the alive flag and pong listener here.
          ws._isAlive = true;
          ws.on("pong", () => { ws._isAlive = true; });

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
                  // Source is extractPortalUser() — whitelist of named
                  // header reads. No untrusted key can land here, so this
                  // Object.assign cannot be turned into prototype pollution.
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
            // No per-client interval to clear — heartbeat is centralised in
            // the shared `_pingSweep` tick (see registerPingedServer).
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
      /**
       * Send a pre-serialised frame to one WS client, gated by the
       * `onCanSendTo` plugin hook. Returns true on successful send.
       * @param {import("ws").WebSocket} ws
       * @param {string} frame                JSON-encoded payload.
       * @param {MessagePayload} msg          Inspected by plugin hooks.
       * @returns {boolean}
       * @private
       */
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
        // Target Node-RED ≥4.0: `done` is always present. No defensive guard.
        try {
          const result = router.route(msg, { clients, userIndex, sendTo });
          // Cache the latest broadcast payload so freshly-connected clients
          // can recover it via the `recovery` frame on connect. Deep-clone via
          // RED.util.cloneMessage so a downstream mutation cannot retroactively
          // change what a fresh client sees on connect.
          if (result.mode === "broadcast") {
            let cached;
            try {
              cached = RED.util.cloneMessage({ p: msg.payload }).p;
            } catch (_) {
              cached = msg.payload;
            }
            lastBroadcastCache.set(endpoint, cached);
          }
          // No updateStatus() here — client count only changes on WS
          // connect/disconnect, and emitting a status event per routed msg
          // floods the editor comms channel on high-rate streams.
          done();
        } catch (err) {
          // Catch-node propagation: done(err) lets the runtime route the
          // error to a Catch node on the same tab (Node-RED docs: "this will
          // trigger any Catch nodes present on the same tab").
          done(err);
        }
      });

      // ── Cleanup on redeploy / shutdown ────────────────────────
      //
      // Teardown order (Node-RED gives us a 15 s budget before forcibly
      // killing the close handler):
      //   1. mark isClosing = true (refuse new WS upgrades)
      //   2. close all WS clients with 1001
      //   3. remove the upgrade listener from RED.server
      //   4. close the ws.Server
      //   5. clear timers / interval handles
      //   6. drop route & shared state (only when fully removed)
      //   7. done()
      //
      // `removed` is true when the node is deleted *or* disabled in the
      // editor (Node-RED docs). For both we drop persistent route + cache;
      // for redeploy (removed=false) we keep pageState[endpoint] so
      // reconnecting clients hit the same build with a smaller delay.

      node.on("close", (removed, done) => {
        let doneCalled = false;
        const callDone = (err) => {
          if (doneCalled) return;
          doneCalled = true;
          done(err);
        };
        // Safety net — runtime force-kills at 15 s. Resolve at 14 s if
        // teardown is somehow blocked so we don't get a hard timeout log.
        const safety = setTimeout(() => callDone(), 14_000);
        safety.unref?.();

        try {
          isClosing = true;

          // Close all WS clients. Heartbeat lives in the shared module-level
          // sweep tick — no per-client cleanup needed here. ws.close() is
          // non-blocking; we don't await drain.
          clients.forEach((ws) => {
            try {
              ws.close(1001, "node redeployed");
            } catch (e) { RED.log.trace("[portal-react] ws close client: " + e.message); }
          });
          clients.clear();

          // Remove upgrade handler before tearing down the WS server so a
          // late upgrade request doesn't race into a half-closed wsServer.
          if (upgradeHandlers[nodeId]) {
            RED.server.removeListener("upgrade", upgradeHandlers[nodeId]);
            delete upgradeHandlers[nodeId];
          }

          // Close WS server — also drop it from the shared heartbeat tick.
          // When the last portal node tears down its server, the shared
          // interval auto-clears (see unregisterPingedServer).
          if (wsServer) {
            unregisterPingedServer(wsServer);
            try {
              wsServer.close();
            } catch (e) { RED.log.trace("[portal-react] wsServer close: " + e.message); }
            wsServer = null;
          }

          // Unregister rebuild callback + selective-rebuild metadata
          delete rebuildCallbacks[nodeId];
          delete portalNeeded[nodeId];
          delete portalNeededUtilities[nodeId];
          delete portalCode[nodeId];

          // Release endpoint ownership
          if (endpointOwners[endpoint] === nodeId) {
            delete endpointOwners[endpoint];
          }

          // Drop the recovery cache on full removal/disable; on a plain
          // redeploy keep it so reconnecting clients still recover.
          if (removed) {
            lastBroadcastCache.delete(endpoint);
            delete portalSig[nodeId];
            delete nodeEndpoints[nodeId];
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
            // Clear the advertised hash too. Leaving a stale non-empty
            // contentHash while compiled is null makes the WS `version` frame
            // advertise a "ready" page that the GET route can no longer serve,
            // which drives the served error/building page into a reload loop.
            st.contentHash = "";
          }

          // Clean up route only on full removal/disable (not on redeploy).
          if (removed) {
            // Delete disk cache if no other endpoint uses this hash
            if (lastJsxHash && !isHashInUse(lastJsxHash, pageState, endpoint)) {
              deleteCacheFiles(lastJsxHash);
            }
            delete pageState[endpoint];
            removeRoute(RED.httpNode._router, endpoint);
            delete registeredRoutes[endpoint];
          }

          clearTimeout(safety);
          callDone();
        } catch (err) {
          clearTimeout(safety);
          callDone(err);
        }
      });

      // ── Utilities ─────────────────────────────────────────────

      /**
       * Best-effort `JSON.stringify` + `ws.send`. Swallows write errors at
       * trace level — used for status/control frames where dropping a
       * single packet has no semantic impact (the next deploy or heartbeat
       * will reconcile state).
       * @param {import("ws").WebSocket} ws
       * @param {Object} obj
       * @returns {void}
       * @private
       */
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

  const express = require("express");
  const { registerAdminApi } = require("./lib/admin-api");
  registerAdminApi(RED, {
    express,
    permRead: PERM_READ,
    permWrite: PERM_WRITE,
    csrfGuard,
    rateLimit,
    jsonBodyLimit: JSON_BODY_LIMIT,
    userDir,
    pageState,
    registry,
    utilities,
    extractUtilitySymbols,
  });
};

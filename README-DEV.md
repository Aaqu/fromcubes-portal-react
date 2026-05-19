# @aaqu/fromcubes-portal-react — Developer guide

This document covers the bits a contributor or plugin author actually uses: how the bundle is assembled at deploy, the WebSocket wire protocol you can talk to from any client, how to extend the runtime with a plugin, and how to iterate on this code base locally.

For end-user docs (install, `useNodeRed()`, examples) see [README.md](./README.md).

---

## What happens at deploy

```
Node-RED deploy
  │
  ├─ npm packages listed in `libs` are auto-installed via dynamicModuleList
  │  (lands in userDir/node_modules, not in this plugin's tree)
  │
  ├─ esbuild runs ONE pass that bundles together:
  │     React + ReactDOM
  │     each requested npm package
  │     every fc-portal-utility node referenced by the JSX
  │     every fc-portal-component node referenced by the JSX
  │     the user JSX itself
  │  alias on `react` / `react-dom` keeps a single React instance
  │  (peer-dep packages such as @react-three/fiber, @pixi/react share it)
  │
  ├─ Tailwind candidate scan over the JSX → tailwindcss.compile() → CSS string
  │  stored per page; reused on redeploy when the JSX hash matches
  │
  └─ HTTP route at /fromcubes/<sub-path> serves the built HTML
     WebSocket route at /fromcubes/<sub-path>/_ws handles msg I/O
```

The only thing the browser receives is the resulting JS + CSS — no Babel, no Sucrase, no compiler at runtime.

### The shape of the bundle

Inside the IIFE the order matters:

```
imports (hoisted, deduplicated)
React shorthand (React, ReactDOM, hooks pulled into local scope)
useNodeRed hook
utilities       ── concatenated raw, top level
library components ── each wrapped in its own IIFE that returns the named export
user JSX
createRoot(...).render(<App/>)
```

Utilities precede library components on purpose — a component can call utility-declared helpers and hooks. Components and utilities are pulled in **selectively**: only the ones whose top-level symbols appear (transitively) in the user JSX or in another included component. Anything unreferenced is left out of the bundle entirely.

### Per-portal rebuild scope

A redeploy of one `portal-react` node triggers a rebuild **only** for that node, unless one of its referenced components or utilities changed. The same applies in reverse: a `fc-portal-component` or `fc-portal-utility` change rebuilds only the portals whose resolved dependency set actually mentions the changed name (not every portal in the flow).

## Repository layout

```
nodes/
  portal-react.js       Node-RED-bound runtime — registers portal-react,
                        fc-portal-component, fc-portal-utility node types,
                        manages WS lifecycle, builds bundles, mounts admin REST API.
  portal-react.html     Editor UI for all three node types: Monaco, Tailwind +
                        JSX + utility-symbol autocompletion, Components and
                        Utilities dialogs, Portal Assets sidebar.
  lib/
    helpers.js          hash, transpile, generateCSS, isSafeName,
                        validateSubPath, disk cache helpers
    hooks.js            Plugin hook dispatcher (allow + transform)
    router.js           Pure routing function (unicast / user-cast / broadcast)
    page-builder.js     Browser HTML + window.__NR shim (the WS bridge that
                        useNodeRed() talks to)
    assets.js           Portal Assets file manager
tests/
  helpers.test.js, hooks.test.js, routing.test.js, assets.test.js
examples/                Importable Node-RED flows
```

`nodes/lib/*.js` is **pure**: factories that take `RED` (or a tiny shim) and return functions. Anything Node-RED-specific lives in `portal-react.js`. Keep it that way — every helper that ends up in `lib/` becomes unit-testable without standing up Node-RED.

## Plugin hooks — extending the runtime

Other Node-RED plugins (or your own one-off scripts dropped into `~/.node-red/node_modules`) can register hooks against the type `fromcubes-portal-react`. Hooks are how you add auth, audit, RBAC, message rewriting, etc. without forking this module.

```javascript
RED.plugins.registerPlugin("my-portal-rbac", {
  type: "fromcubes-portal-react",
  hooks: {
    // Reject the WebSocket upgrade entirely.
    onIsValidConnection(request) {
      return request.headers["x-internal-secret"] === process.env.SECRET;
    },

    // Per-recipient veto on every outbound frame.
    onCanSendTo(ws, msg) {
      const role = ws._portalUser && ws._portalUser.role;
      if (msg.payload && msg.payload.__adminOnly) return role === "admin";
      return true;
    },

    // Mutate or drop every inbound msg before node.send().
    // Return null to drop.
    onInbound(msg, ws) {
      if (!ws._portalUser) return null;       // no anonymous writes
      msg.__audit = { at: Date.now() };
      return msg;
    },
  },
});
```

| Hook | Type | When | Arguments | Return |
|---|---|---|---|---|
| `onIsValidConnection` | allow | Before WS upgrade | `(request)` | `false` to reject |
| `onCanSendTo` | allow | Before every outbound `ws.send()` | `(ws, msg)` | `false` to drop the frame for this ws |
| `onInbound` | transform | After receiving a client output, before `node.send()` | `(msg, ws)` | mutated `msg`, or `null` to drop |

### `allow` vs `transform`

- **allow** — every registered hook must return `!== false`. AND-logic. First `false` short-circuits. A throwing hook is treated as `false` and the throw is logged via `RED.log.error`.
- **transform** — runs sequentially, each hook receives the previous hook's output. Returning `undefined` keeps the current value; anything else replaces it. A throwing hook is logged and skipped — the chain continues with the previous value.

### Where hooks fire

| Hook | Call site |
|---|---|
| `onIsValidConnection` | `nodes/portal-react.js` — WS `upgrade` handler |
| `onCanSendTo` | `nodes/portal-react.js` — `sendTo()` (the single chokepoint for every outbound frame) |
| `onInbound` | `nodes/portal-react.js` — inside the `ws.on("message")` handler, before `node.send()` |

### Debugging your hook

Hooks run inside the Node-RED process — anything you `RED.log.info(...)` shows up in the Node-RED log (`~/.node-red/log/...` or your `journalctl` if you run as a service). A practical pattern:

```javascript
onCanSendTo(ws, msg) {
  const ok = ws._portalUser && ws._portalUser.role === "admin";
  RED.log.info(`[portal-rbac] sendTo decided ok=${ok} for user=${ws._portalUser && ws._portalUser.userId}`);
  return ok;
}
```

If your hook is silent in the log: check that the plugin file is actually loaded (Node-RED needs the package in `userDir/node_modules` and it must export `RED.plugins.registerPlugin(...)` from the entry referenced by `package.json#node-red.plugins`).

### End-to-end: a tiny RBAC plugin

1. Create `~/.node-red/node_modules/portal-rbac/`.
2. `package.json`:

   ```json
   {
     "name": "portal-rbac",
     "version": "0.0.1",
     "node-red": { "plugins": { "portal-rbac": "rbac.js" } }
   }
   ```

3. `rbac.js`:

   ```javascript
   module.exports = function (RED) {
     RED.plugins.registerPlugin("portal-rbac", {
       type: "fromcubes-portal-react",
       hooks: {
         onInbound(msg, ws) {
           const u = ws._portalUser;
           if (!u) return null;                       // anonymous → drop
           msg.actor = { userId: u.userId, role: u.role };
           return msg;
         },
       },
     });
   };
   ```

4. Restart Node-RED. Open a portal page. Click anything that calls `send(...)`. Inspect the inbound `msg` in your flow with a `debug` node — `msg.actor` should be present, anonymous tabs should produce nothing.

## WebSocket protocol

Frames are JSON. Inbound (browser → server) and outbound (server → browser) types:

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| ← server | `hello` | `{ portalClient }` | Assigned session ID for this tab |
| ← server | `version` | `{ hash }` | Content hash for deploy-reload detection |
| ← server | `data` | `{ payload, topic? }` | Routed flow message |
| ← server | `recovery` | `{ payload }` | Cached last broadcast at connect time, if any. The browser seeds `data` from this unless `useNodeRed({ ignoreRecovery: true })` |
| ← server | `building` | `{}` | Server is rebuilding the bundle; browser shows the building overlay |
| ← server | `error` | `{ message, degraded? }` | Build/runtime error; if `degraded:true` the previous good build is still being served |
| → server | `output` | `{ payload, topic? }` | The result of `useNodeRed().send(...)` |

The client cannot forge `_client` — the server overwrites it from socket state on every inbound frame.

### Talking to a portal from a non-React client

`useNodeRed()` is a thin convenience over a plain WebSocket. If you want to drive a portal page from a script, a Node test, or a different framework:

```javascript
const ws = new WebSocket("ws://localhost:1880/fromcubes/sensors/_ws");

ws.addEventListener("message", (evt) => {
  const m = JSON.parse(evt.data);
  switch (m.type) {
    case "hello":     console.log("connected as", m.portalClient); break;
    case "version":   /* m.hash — you only need this if you implement reload-on-redeploy */ break;
    case "data":
    case "recovery":  console.log("payload:", m.payload); break;
    case "error":     console.warn("server error:", m.message); break;
  }
});

// Emit a message on the portal node's output wire:
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "output", payload: { hello: "from a raw client" } }));
});
```

That's the entire contract. Reconnect logic, recovery seeding, and the building/error overlays are all browser conveniences layered on top of these frames.

## Deploy lifecycle

1. `node.on("close")` fires on the existing instance.
2. All WebSocket clients receive close code `1001` ("node redeployed").
3. The browser auto-reconnects with exponential backoff.
4. The stale HTTP route and WS upgrade handler are removed.
5. The new instance transpiles JSX (cache hit on unchanged source skips esbuild entirely).
6. The new HTTP route and WS handler are registered.
7. Reconnecting clients soft-reconnect (no page reload) and receive the current cached broadcast as a `recovery` frame.

**Rapid deploys** (clicking deploy repeatedly) are safe:

- An `isClosing` flag prevents accepting new WS connections during teardown.
- Upgrade handlers are tracked per node id — old ones are removed before new ones register, so listeners do not pile up on `RED.server`.

**Transpile errors:**

- The node status turns red with a `transpile error` label.
- The endpoint serves a generated error page with the message (or, if a previous good build exists, keeps serving that build and shows a small dismissible error banner — degraded mode).
- Fix the code, redeploy. The cache key is the JSX hash, so the next deploy bypasses the broken cache automatically.

**Missing components:**

- A reference to a PascalCase tag (`<Header/>`) with no provider — neither in the registry, nor in any utility's top-level symbols, nor defined locally, nor imported, nor a React built-in — is caught at deploy time, before bundling.
- Status turns red with `missing: <Name>` (suffixed `+N` when more than one). The page serves an error overlay listing the missing names and a hint to import the example flow that defines them. No runtime `ReferenceError` in the browser.

## Browser bundle

A single esbuild pass produces one IIFE containing React, every requested npm package, the utilities and components actually referenced, and the user JSX. Tree-shaking drops unused exports. The `alias` on `react` / `react-dom` makes peer-dep packages share the same React instance — no duplicate React, no hooks errors.

There is no separate vendor bundle endpoint. The compiled JS is inlined into the served HTML. The Tailwind CSS is generated server-side from the JSX source and served at `/fromcubes/css/<hash>.css` (with a `/portal-react/css/<hash>.css` legacy alias).

## Iterating locally

```bash
# from the repo
npm test                # vitest, all units pure-JS
npm run test:watch      # iterate on lib/ changes
```

To run the plugin against a real Node-RED:

```bash
cd ~/.node-red
npm install /Users/you/path/to/fromcubes-portal-react
# then
npm start              # or however you start your Node-RED
```

For most edits you do not need to restart Node-RED:

- **JSX, library components, utilities, examples** — just hit Deploy in the editor. The runtime tears down the affected portals and rebuilds them.
- **Editor UI (`portal-react.html`), tw-candidates, anything served as an editor asset** — full browser refresh of the editor (Node-RED caches editor assets aggressively). Sometimes `Cmd-Shift-R` is needed.
- **Server runtime (`nodes/portal-react.js`, `nodes/lib/*.js`)** — restart Node-RED. The runtime is loaded once at startup; in-place edits are not picked up by deploy.

A handy loop while debugging the runtime: keep `npm test -- --watch` open in one pane and Node-RED in another. Most regressions surface in the unit tests first because `lib/` is intentionally pure.

### Test design

Tests use no Node-RED runtime. Files are pure-JS units with fake `RED.plugins.getByType` and fake `ws` objects. See `tests/hooks.test.js` and `tests/routing.test.js` for the shim patterns to copy when adding new tests.

When adding a new hook:

1. Update the doc block at the top of `nodes/lib/hooks.js`.
2. Wire the call site in `router.js` or `portal-react.js`.
3. Add a unit test next to the closest existing one (`hooks.test.js` for the dispatcher chain, `routing.test.js` for routing-time behaviour).

## Contributing

PRs welcome. Please:

- Run `npm test` before pushing.
- Keep `nodes/lib/*.js` Node-RED-free so it stays unit-testable.
- Match the null-drop convention for any new transform hook (falsy return = drop / skip).
- Update both READMEs when adding user-visible features.

## License

Apache-2.0

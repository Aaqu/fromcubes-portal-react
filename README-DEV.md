# @aaqu/fromcubes-portal-react — Developer guide

This document covers the internals: how a deploy turns JSX into a browser bundle, the WebSocket protocol, the plugin hook system, the test setup, and how to contribute.

For end-user docs (install, `useNodeRed()`, examples) see [README.md](./README.md).

---

## Architecture overview

```
┌─ Deploy time (Node-RED server) ───────────────────────────┐
│                                                           │
│  npm packages  ──►  auto-installed at deploy              │
│       (d3, three, @react-three/fiber…)                    │
│       via dynamicModuleList                               │
│                                                           │
│  React + packages + JSX  ──►  single esbuild pass         │
│       one IIFE, one React instance (alias)                │
│       tree-shaking removes unused exports                 │
│       React peer deps share same instance                 │
│                                                           │
│  Tailwind classes  ──►  server-side compile  ──►  CSS     │
│       stored per-page in pageState                        │
│                                                           │
│  Unchanged JSX on redeploy = reuse CSS, 0ms               │
│  Changed JSX = retranspile, ~5ms                          │
└───────────────────────────────────────────────────────────┘

┌─ Runtime (browser) ───────────────────────────────────────┐
│                                                           │
│  GET /fromcubes/<sub-path>  ──►  HTML + inlined bundle    │
│                      Tailwind CSS (server-compiled)       │
│                      NO Babel, NO Sucrase, NO compiler    │
│                                                           │
│  WebSocket /fromcubes/<sub-path>/_ws  ◄──►  msg I/O       │
└───────────────────────────────────────────────────────────┘
```

### Key design decisions

- **One esbuild pass per sub-path.** React + npm packages + utility helpers + library components + your JSX are compiled into one IIFE bundle. Tree-shaking removes unused exports. All portal nodes share the hardcoded `/fromcubes/` URL prefix — only the sub-path after it is user-configurable.
- **Two flavours of shared canvas nodes:** `fc-portal-component` (one exported React component per node, IIFE-wrapped — referenced as `<Tag/>`), and `fc-portal-utility` (raw top-level concat — many helpers/hooks/constants per node, referenced as bare identifiers). Both selectively bundled by symbol reference.
- **Upfront symbol-collision check.** A shared `fcUtilSymbolOwners` table catches duplicate top-level identifiers across utility nodes (and against component names) at deploy, so the offending utility node is flagged red instead of esbuild surfacing a confusing `Identifier "X" has already been declared` error on a downstream portal.
- **Single React instance.** esbuild `alias` ensures peer-dep packages (`@react-three/fiber`, `@pixi/react`) share the same React — no duplicate React, no hooks errors.
- **Content-hash cache.** Unchanged JSX on redeploy reuses the cached bundle (~0 ms). Changed JSX retranspiles (~5 ms).
- **Tailwind compiled server-side.** No PostCSS in the browser; the CSS is generated from the JSX source and stored per-page.
- **Strict-by-default WebSocket.** Every outbound frame passes through the plugin hook chain; nothing is sent without explicit permission.

## Repository layout

```
nodes/
  portal-react.js        Main runtime — registers portal-react, fc-portal-component
                         and fc-portal-utility node types; WS lifecycle, routing,
                         bundle pipeline, admin REST API
  portal-react.html      Editor UI for all three node types (Monaco, Tailwind +
                         JSX + utility-symbol autocompletion, Components dialog,
                         Utilities dialog, Portal Assets sidebar)
  lib/
    helpers.js           hash, transpile, generateCSS, isSafeName, validateSubPath,
                         disk cache helpers
    hooks.js             Plugin hook dispatcher (allow + transform)
    router.js            Pure routing function (unicast / user-cast / broadcast)
    page-builder.js      Browser HTML + window.__NR shim (WS bridge for useNodeRed)
    assets.js            Portal Assets file manager
tests/
  helpers.test.js        Pure helpers
  hooks.test.js          Hook dispatcher unit tests
  routing.test.js        Pure routing function tests
  assets.test.js         Assets module tests
examples/                Example flows (importable into Node-RED)
```

## npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Start Node-RED |
| `npm test`  | Run the vitest suite |

## Plugin hooks

Other Node-RED plugins can install hooks to validate connections and filter messages. **Strict-by-default**: if any `allow`-type hook returns `false`, the action is denied. Multiple plugins can register — `allow` hooks are AND-ed; `transform` hooks run sequentially.

```javascript
// in another Node-RED plugin
RED.plugins.registerPlugin("my-portal-rbac", {
  type: "fromcubes-portal-react",
  hooks: {
    // Reject WS upgrade entirely (e.g. missing shared secret)
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
| `onInbound` | transform | After receiving client output, before `node.send()` | `(msg, ws)` | mutated `msg`, or `null` to drop |

### `allow` vs `transform`

- **allow** — every registered hook must return `!== false`. AND logic. First `false` short-circuits. Throwing is treated as `false` and logged via `RED.log.error`.
- **transform** — runs sequentially, each hook receives the previous hook's output. Returning `undefined` keeps the current value; returning anything else replaces it. A throwing hook is logged and skipped (the chain continues with the previous value).

### Where hooks fire (call sites)

| Hook | Call site |
|---|---|
| `onIsValidConnection` | `nodes/portal-react.js` — WS `upgrade` handler |
| `onCanSendTo` | `nodes/portal-react.js` — `sendTo()` (single chokepoint for every outbound frame) |
| `onInbound` | `nodes/portal-react.js` — inside the `ws.on("message")` handler, before `node.send()` |

## WebSocket protocol

Frames are JSON. Inbound (browser → server) and outbound (server → browser) types:

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| ← server | `hello` | `{ portalClient }` | Assigned session ID |
| ← server | `version` | `{ hash }` | Content hash for deploy-reload detection |
| ← server | `data` | `{ payload }` | Routed flow message |
| ← server | `recovery` | `{ payload }` | Cached last broadcast at connect time, if any. Browser seeds `data` from this unless `useNodeRed({ ignoreRecovery: true })` |
| → server | `output` | `{ payload, topic? }` | `useNodeRed().send(...)` |

The client cannot forge `_client` — the server overwrites it from socket state on every inbound frame.

## Deploy lifecycle

1. Node `close` fires on the existing instance.
2. All WebSocket clients receive close code `1001` ("node redeployed").
3. Browser auto-reconnects with exponential backoff (500 ms → 1 s → 2 s → 4 s → 8 s cap).
4. Stale HTTP route and WS upgrade handler are removed.
5. New instance transpiles JSX:
   - Content hash computed.
   - Cache hit → reuse (~0 ms).
   - Cache miss → esbuild transpile (~5 ms).
6. New HTTP route and WS handler are registered.
7. Reconnecting clients soft-reconnect (no page reload) and receive the current cached broadcast as a `recovery` frame.

**Rapid deploys** (user clicking deploy repeatedly) are safe:

- `isClosing` flag prevents accepting new WS connections during teardown.
- Upgrade handlers are tracked per node ID; old ones are removed before new ones register.
- No orphan listeners accumulate on `RED.server`.

**Transpile errors:**

- Node status shows red "transpile error".
- Endpoint serves an error page with the message.
- Fix code, redeploy — cache invalidates because the hash changes.

## Browser payload

| Asset | Size (gzip) |
|---|---|
| Single JS bundle (React + packages + your code) | ~45 KB React only, grows with packages |
| Tailwind CSS (server-compiled) | stored per-page, reused if JSX unchanged |
| WebSocket bridge | <1 KB |

Single-pass esbuild bundle. Tree-shaking removes unused exports. The React `alias` ensures peer-dep packages share the same React instance — no duplicate React, no hooks errors. No Babel, no Sucrase, no runtime compiler in the browser.

Bundle layout inside the IIFE: `imports → React shorthand → useNodeRed hook → utilities (raw) → library components (each in IIFE wrapper) → user JSX → createRoot(...).render(<App/>)`. Utilities precede library components so a component can call utility-declared helpers and hooks.

## Testing

```bash
npm test   # vitest
```

The test suite uses no Node-RED runtime. Files are pure-JS units with fake `RED.plugins.getByType` and fake `ws` objects. See `tests/hooks.test.js` and `tests/routing.test.js` for the shim patterns to copy when adding new hook tests.

When adding a new hook:

1. Update the doc block at the top of `nodes/lib/hooks.js`.
2. Wire the call site in `router.js` or `portal-react.js`.
3. Add a unit test next to the closest existing one (`hooks.test.js` for the dispatcher chain, `routing.test.js` for routing-time behaviour).

## Contributing

PRs welcome. Please:

- Run `npm test` before pushing — the suite is fast (~300 ms).
- Keep `nodes/lib/*.js` Node-RED-free so it stays unit-testable.
- Match the null-drop convention for any new transform hook (falsy return = drop / skip).
- Update both READMEs when adding user-visible features.

## License

Apache-2.0

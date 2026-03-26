# @aaqu/fromcubes-portal-react

> **⚠️ Alpha Module** — This project is in early development. Expect many breaking changes. Please test on a clean Node-RED instance.

React portal node for Node-RED. Server-side JSX transpilation via esbuild. Tailwind CSS 4. Zero runtime compilation in browser.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/L4L01UOFRG)

## How it works

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
│  GET /endpoint  ──►  HTML + single inlined JS bundle      │
│                      Tailwind CSS (server-compiled)       │
│                      NO Babel, NO Sucrase, NO compiler    │
│                                                           │
│  WebSocket /endpoint/_ws  ◄──►  Node-RED msg I/O          │
└───────────────────────────────────────────────────────────┘
```

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-portal-react@alpha
# restart Node-RED
```

Dependencies install automatically. No build step needed.

## npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Start Node-RED |

## Nodes

### portal-react

| Field | Purpose                                                          |
|---|------------------------------------------------------------------|
| Endpoint | HTTP path, e.g. `/fromcubes/page1`                               |
| Page Title | Browser tab title                                                |
| npm Packages | Comma-separated packages, e.g. `d3, three, @react-three/fiber` |
| Portal Auth | Enable portal user header extraction                             |
| Head HTML | Extra `<head>` tags (CDN, fonts, CSS)                            |
| Code Editor | Monaco with JSX — must define `<App />`                          |

### fc-portal-component (config node)

Shared component store. Each component has name, code, input/output field definitions.
Referenced components (with transitive dependencies) are selectively injected at transpile time.

## Editor features

- **Monaco editor** with full JSX support and `useNodeRed()` type declarations
- **Tailwind CSS autocompletion** inside `className="..."` strings (~19k utility classes)
- **JSX tag completion** — type tag name, Tab to expand (open+close and self-closing variants)
- **Self-close collapse** — type `/` inside empty `<tag></tag>` to convert to `<tag />`
- **Component completion** — registry components + any PascalCase word
- **Portal Assets sidebar** — file manager for static assets (GLB models, textures, fonts, etc.)

## Hook API

```jsx
function App() {
  const { data, send, user, portalClient } = useNodeRed();
  // data         = last msg.payload from input wire (reactive)
  // send(payload, topic?) = emit msg on output wire
  // user         = portal user object (when Portal Auth enabled), or null
  // portalClient = unique session/tab ID (assigned by server on WS connect)
  return <div className="p-4 text-lg">{JSON.stringify(data)}</div>;
}
```

## Portal Authentication

When **Portal Auth** is checked, the node extracts user identity from incoming request headers:

| Header | Field |
|---|---|
| `x-portal-user-id` | `userId` |
| `x-portal-user-name` | `userName` |
| `x-portal-user-username` | `username` |
| `x-portal-user-email` | `email` |
| `x-portal-user-role` | `role` |
| `x-portal-user-groups` | `groups` (JSON array) |

- In the browser, `useNodeRed().user` returns the extracted user object (or `null` if auth is disabled or no headers present).
- Every WebSocket message includes `msg._client = { portalClient, ...userFields }`. The `portalClient` is always present (unique per tab/session); user fields are added when Portal Auth is enabled.
- To send a response to a specific tab, keep `msg._client` on the return message (or set `msg._client = { portalClient: "..." }`).
- To send to all sessions of a user, set `msg._client = { userId: "..." }` (omit `portalClient`).
- To broadcast to all clients, remove `msg._client` from the message.

## Portal Assets

Static files (3D models, textures, fonts, etc.) can be uploaded and served from a public endpoint.

- Open the **Portal Assets** tab in the Node-RED sidebar
- Upload files via button or drag & drop
- Organize in folders (create, rename, move between folders)
- Copy public path with one click — use in JSX: `/fromcubes/public/models/scene.glb`
- Download and delete files from the context menu

All uploads require Node-RED admin authentication. Files are served publicly at `/fromcubes/public/`.

Limits: 100 MB per file, 500 MB total, 1000 files max.

## Deploy lifecycle

What happens on each deploy:

1. Node `close` fires on existing instance
2. All WebSocket clients receive close code `1001` ("node redeployed")
3. Browser auto-reconnects with exponential backoff (500ms → 1s → 2s → 4s → 8s cap)
4. Stale HTTP route and WS upgrade handler removed
5. New instance transpiles JSX:
   - Content hash computed
   - Cache hit → reuse (0ms)
   - Cache miss → esbuild transpile (~5ms)
6. New HTTP route and WS handler registered
7. Reconnecting clients soft-reconnect (no page reload) and receive current `lastPayload`

Rapid deploys (user clicking deploy repeatedly) are safe:
- `isClosing` flag prevents accepting new WS connections during teardown
- Upgrade handlers are tracked per node ID, old ones removed before new ones register
- No orphan listeners accumulate on `RED.server`

Transpile errors:
- Node status shows red "transpile error"
- Endpoint serves an error page with the error message
- Fix code, redeploy — cache invalidates because hash changes

## Browser payload

| Asset | Size (gzip) |
|---|---|
| Single JS bundle (React + packages + your code) | ~45 KB React only, grows with packages |
| Tailwind CSS (server-compiled) | stored per-page, reused if JSX unchanged |
| WebSocket bridge | <1 KB |

Single-pass esbuild bundle — React, npm packages, and your JSX compiled into one IIFE. Tree-shaking removes unused exports. React `alias` ensures packages with React peer deps (e.g. `@react-three/fiber`, `@pixi/react`) share the same React instance — no duplicate React, no hooks errors.

No Babel, no Sucrase, no runtime compiler in the browser.

## Examples

Import `001-shared-components-flow.json` first — it provides shared UI components (Page, Header, Stat, Button, ValueBadge) used by all examples.

| Flow | npm packages | Description |
|---|---|---|
| `001-shared-components-flow.json` | — | Shared components: Page, Header, Stat, Button, ValueBadge |
| `002-sensor-portal-flow.json` | — | Sensor gauge with live WebSocket data |
| `003-chart-portal-flow.json` | `chart.js/auto` | Live updating Chart.js charts |
| `004-d3-poland-flow.json` | `d3` | Interactive SVG map of Poland (simulated data) |
| `005-threejs-portal-flow.json` | `three` | 3D scene with Three.js |
| `006-pixi-portal-flow.json` | `pixi.js`, `@pixi/react` | Clickable bunny sprites with PixiJS |
| `007-webgpu-tsl-flow.json` | `three` | WebGPU renderer + TSL animated shaders |

## License

Apache-2.0

# @aaqu/fromcubes-portal-react

> **⚠️ Alpha Module** — This project is in early development. Expect breaking changes. Test on a clean Node-RED instance.

A Node-RED node that turns any `/fromcubes/<sub-path>` URL into a React page. Write JSX in the editor, deploy, open the URL — your component talks to the flow over WebSocket. No build step, no browser compiler. All portal pages are served under the hardcoded `/fromcubes/` prefix so every node cleanly coexists under one URL tree.

For internals, plugin authoring, and the deploy pipeline see [README-DEV.md](./README-DEV.md).

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/L4L01UOFRG)

## Install

```bash
cd ~/.node-red
npm install @aaqu/fromcubes-portal-react@alpha
# restart Node-RED
```

That's it. No build step. Any npm packages you list in the node config (e.g. `d3, three`) are installed automatically on deploy.

## Your first portal

1. Drop a **portal-react** node onto a flow.
2. Set **Sub-path** to e.g. `hello` (the node will serve at `/fromcubes/hello`; the `/fromcubes/` prefix is fixed).
3. Open the code editor and paste:
   ```jsx
   function App() {
     const { data, send } = useNodeRed();
     return (
       <div className="p-4">
         <p>From flow: {JSON.stringify(data)}</p>
         <button
           className="px-3 py-1 bg-blue-500 text-white rounded"
           onClick={() => send({ clicked: Date.now() })}
         >
           click me
         </button>
       </div>
     );
   }
   ```
4. Deploy. Open `http://localhost:1880/fromcubes/hello`.
5. Wire an **inject** node into the portal-react input → see `data` update live. Wire its output → see button clicks arrive in your flow.

## The `useNodeRed()` hook

Everything your component needs from the flow lives in one hook:

```jsx
const {
  data,          // last broadcast msg.payload from input wire (reactive)
  send,          // send(payload, topic?) — emit msg on output wire
  user,          // portal user object (when Portal Auth is enabled), or null
  portalClient,  // unique session/tab ID assigned by server on connect
} = useNodeRed();
```

### Recovery on connect

A freshly-connected client receives the **last broadcast payload** the server has cached for this endpoint, sent as a distinct `recovery` frame. By default it's seeded straight into `data`, so the first render of a new tab shows the most recent value instead of waiting for the next broadcast — same idea as dashboard2's `lastMsg`.

Opt out per page:

```jsx
// data stays undefined until a fresh broadcast arrives — no recovery seed
const { data } = useNodeRed({ ignoreRecovery: true });
```

The opt-out is page-wide — the strictest call wins. If any component on the page asks to ignore recovery, recovery is dropped for all of them.

## Node configuration

| Field | Purpose |
|---|---|
| Sub-path | Part after `/fromcubes/`, e.g. `page1` → served at `/fromcubes/page1`. Required. Nesting allowed (`team/alpha`). Reserved: `public`, `_ws`. |
| Page Title | Browser tab title |
| npm Packages | Comma-separated, e.g. `d3, three, @react-three/fiber` |
| Portal Auth | Enable portal user header extraction (see Multi-user) |
| Head HTML | Extra `<head>` tags (CDN, fonts, CSS) |
| Code Editor | Monaco with JSX — must define `<App />` |

There is also a config node, **fc-portal-component**, that lets you define reusable React components once and reference them by name from any portal-react node. Referenced components (and their transitive dependencies) are injected at transpile time, so unused ones add nothing to the bundle.

## Editor features

- **Monaco** with full JSX support and `useNodeRed()` type declarations
- **Tailwind CSS autocompletion** inside `className="..."` (~19k utility classes)
- **JSX tag completion** — type tag name, Tab to expand
- **Self-close collapse** — type `/` inside empty `<tag></tag>` to convert to `<tag />`
- **Component completion** — registry components + any PascalCase word
- **Portal Assets sidebar** — file manager for static assets (GLB, textures, fonts…)

## Multi-user / Multi-tenancy

Portal-react has three routing modes — broadcast, user-cast (every tab of one user), and unicast (one specific tab). Everything works without authentication too — user-cast just degrades gracefully when there is no user.

### Identity

| Identifier | Scope | Persistence | Source |
|---|---|---|---|
| `portalClient` | Single WS session (one tab) | Lost on reconnect — server assigns a new UUID | Generated server-side on connect |
| `userId` / `username` | All sessions of a user | Survives reconnect and new tabs | `x-portal-user-*` headers (when **Portal Auth** is enabled) |

**Portal Auth header contract** — injected by an upstream reverse proxy such as `aaqu-portal-auth`:

| Header | Field |
|---|---|
| `x-portal-user-id` | `userId` |
| `x-portal-user-name` | `userName` |
| `x-portal-user-username` | `username` |
| `x-portal-user-email` | `email` |
| `x-portal-user-role` | `role` |
| `x-portal-user-groups` | `groups` (JSON array) |

If Portal Auth is disabled or headers are absent, `user` is `null` and user-scoped features are silently skipped — broadcast and per-session features still work.

### Routing modes

Every inbound `msg` arrives in your flow with `msg._client` already filled in by the server. The flow then decides where the response should go by setting (or clearing) `msg._client` on the outgoing `msg`:

```javascript
// BROADCAST — everyone connected to this endpoint
delete msg._client;
return msg;

// UNICAST — only the tab that sent the original msg (echo)
// Keep msg._client as-is; it already carries portalClient.
return msg;

// UNICAST — a specific tab whose ID you know
msg._client = { portalClient: "a1b2c3d4-..." };
return msg;

// USER-CAST — every tab of a specific user (even ones that just opened)
msg._client = { userId: "alice" };
return msg;
```

**Anti-spoof guarantee.** On every inbound message the server overwrites `msg._client` from scratch using the socket's own `portalClient` and the user data captured at connect. A browser cannot forge `_client` — whatever it puts there is discarded.

**User-cast uses an O(1) index** so a message to `{userId: "alice"}` reaches every tab of Alice with a single lookup, not a scan.

### Without a user (anonymous mode)

If **Portal Auth** is off (or no proxy headers arrive), everything still works:

- `broadcast` and `portalClient` unicast: unchanged
- `user`-cast: gracefully skipped (no `userId` to target)
- `useNodeRed().user` is `null`

Same model as dashboard 2 — no auth required to use the node.

## Portal Assets

Static files (3D models, textures, fonts, etc.) can be uploaded and served from a public endpoint.

- Open the **Portal Assets** tab in the Node-RED sidebar
- Upload files via button or drag & drop
- Organize in folders (create, rename, move between folders)
- Copy public path with one click — use in JSX: `/fromcubes/public/models/scene.glb`
- Download and delete files from the context menu

All uploads require Node-RED admin authentication. Files are served publicly at `/fromcubes/public/`.

Limits: 100 MB per file, 500 MB total, 1000 files max.

## Examples

Import `001-shared-components-flow.json` first — it provides shared UI components (Page, Header, Stat, Button, ValueBadge) used by the others.

| Flow | npm packages | Description |
|---|---|---|
| `001-shared-components-flow.json` | — | Shared components: Page, Header, Stat, Button, ValueBadge |
| `002-sensor-portal-flow.json` | — | Sensor gauge with live WebSocket data |
| `003-chart-portal-flow.json` | `chart.js/auto` | Live updating Chart.js charts |
| `004-d3-poland-flow.json` | `d3` | Interactive SVG map of Poland (simulated data) |
| `005-threejs-portal-flow.json` | `three` | 3D scene with Three.js |
| `006-pixi-portal-flow.json` | `pixi.js`, `@pixi/react` | Clickable bunny sprites with PixiJS |
| `007-webgpu-tsl-flow.json` | `three` | WebGPU renderer + TSL animated shaders |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Red status "transpile error" + error page on the endpoint | JSX syntax error — fix code, redeploy (cache invalidates automatically) |
| Red status "legacy endpoint" on deploy | Flow was saved before the `/fromcubes/` prefix became hardcoded. Open the node, set **Sub-path**, redeploy. Automatic migration is disabled to avoid silent URL changes. |
| Red status "bad sub-path" | Sub-path is empty or violates the rules (no leading `/`, no whitespace, no `..`, segments must start alphanumerically, `public`/`_ws` reserved). |
| Page loads but `data` stays `undefined` | No input wire has fired yet — broadcast something into the node |
| `user` is `null` even with Portal Auth on | Upstream proxy is not injecting `x-portal-user-*` headers |
| New tab shows the previous broadcast value | Expected — that's the recovery frame. Use `useNodeRed({ ignoreRecovery: true })` to opt out |
| Page reloads on every deploy | Expected for code changes; clients soft-reconnect with exponential backoff |

## License

Apache-2.0

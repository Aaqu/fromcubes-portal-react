# @aaqu/fromcubes-portal-react

React portal node for Node-RED. Server-side JSX transpilation via esbuild. Tailwind CSS 4. Zero runtime compilation in browser.

## How it works

```
┌─ Deploy time (Node-RED server) ──────────────────────────┐
│                                                          │
│  JSX (editor)  ──►  esbuild transpile  ──►  cached JS    │
│                     (hash-keyed cache)                   │
│                                                          │
│  Tailwind classes  ──►  server-side compile ──► CSS file │
│                         (hash-keyed cache)               │
│                                                          │
│  Unchanged code on redeploy = cache hit, 0ms             │
│  Changed code = retranspile, ~5ms                        │
└──────────────────────────────────────────────────────────┘

┌─ Runtime (browser) ──────────────────────────────────────┐
│                                                          │
│  GET /endpoint  ──►  HTML + pre-compiled JS              │
│                      react-19.production.min.js          │
│                      Tailwind CSS (server-compiled)      │
│                      NO Babel, NO Sucrase, NO compiler   │
│                                                          │
│  WebSocket /endpoint/_ws  ◄──►  Node-RED msg I/O         │
└──────────────────────────────────────────────────────────┘
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
| `npm run build` | Rebuild vendored React bundle (`nodes/vendor/react-19.production.min.js`) |
| `npm start` | Start Node-RED |

## Nodes

### portal-react

| Field | Purpose |
|---|---|
| Endpoint | HTTP path, e.g. `/dashboard` |
| Page Title | Browser tab title |
| Portal Auth | Enable portal user header extraction |
| Head HTML | Extra `<head>` tags (CDN, fonts, CSS) |
| Code Editor | Monaco with JSX — must define `<App />` |

### fc-component-library (config node)

Shared component store. Each component has name, code, input/output field definitions.
Components are auto-injected into every portal-react page at transpile time.

## Editor features

- **Monaco editor** with full JSX support and `useNodeRed()` type declarations
- **Tailwind CSS autocompletion** inside `className="..."` strings (~19k utility classes)
- **JSX tag completion** — type tag name, Tab to expand (open+close and self-closing variants)
- **Self-close collapse** — type `/` inside empty `<tag></tag>` to convert to `<tag />`
- **Component completion** — registry components + any PascalCase word

## Hook API

```jsx
function App() {
  const { data, send, user } = useNodeRed();
  // data  = last msg.payload from input wire (reactive)
  // send(payload, topic?) = emit msg on output wire
  // user  = portal user object (when Portal Auth enabled), or null
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
- On outgoing messages, user info is attached as `msg._client` so downstream nodes can identify the sender.

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
| react-19.production.min.js | ~45 KB |
| Your transpiled JS | ~1-5 KB |
| Tailwind CSS (server-compiled) | cached per content hash |
| WebSocket bridge | <1 KB |

No Babel, no Sucrase client, no Vue, no Vuetify, no Socket.IO.

## License

Apache-2.0

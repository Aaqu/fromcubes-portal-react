/** @module nodes/lib/router */

/**
 * Pure routing function for portal-react WS outbound messages.
 *
 * Split out from portal-react.js so it can be unit-tested without a full
 * Node-RED runtime.
 *
 * Routing modes, in priority order:
 *   1. msg._client.portalClient → unicast to that one session
 *   2. msg._client.userId        → user-cast (O(1) via userIndex)
 *   3. msg._client.username      → user-cast fallback (O(N) scan)
 *   4. otherwise                 → broadcast
 *
 * Returns a shallow summary `{ mode, delivered }` for observability/tests.
 * The caller is responsible for any side-effects keyed off the mode
 * (e.g. caching the last broadcast payload for new-client recovery).
 */

/**
 * @typedef {Object} RouteContext
 * @property {Map<string, import("ws").WebSocket>} clients   portalClient → ws
 * @property {Map<string, Set<import("ws").WebSocket>>} userIndex userId → ws set
 * @property {(ws: any, frame: string, msg: Object) => boolean} sendTo
 */

/**
 * @typedef {Object} RouteResult
 * @property {"unicast"|"user-cast"|"broadcast"} mode
 * @property {number} delivered
 */

/**
 * Pure router — chooses delivery mode based on `msg._client` and dispatches
 * via `ctx.sendTo` (which is responsible for hook checks and send-failure
 * handling). Has no side-effects other than calling `sendTo`.
 *
 * @param {Object} msg
 * @param {RouteContext} ctx
 * @returns {RouteResult}
 */
function route(msg, ctx) {
  const { clients, userIndex, sendTo } = ctx;
  const target = msg && msg._client;
  const frame = JSON.stringify({ type: "data", payload: msg.payload });

  let delivered = 0;

  if (target && target.portalClient) {
    if (sendTo(clients.get(target.portalClient), frame, msg)) delivered++;
    return { mode: "unicast", delivered };
  }

  if (target && target.userId) {
    const set = userIndex.get(target.userId);
    if (set) {
      set.forEach((ws) => {
        if (sendTo(ws, frame, msg)) delivered++;
      });
    }
    return { mode: "user-cast", delivered };
  }

  if (target && target.username) {
    clients.forEach((ws) => {
      if (ws._portalUser && ws._portalUser.username === target.username) {
        if (sendTo(ws, frame, msg)) delivered++;
      }
    });
    return { mode: "user-cast", delivered };
  }

  // Broadcast.
  clients.forEach((ws) => {
    if (sendTo(ws, frame, msg)) delivered++;
  });
  return { mode: "broadcast", delivered };
}

module.exports = { route };

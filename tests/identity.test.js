/**
 * Security-focused tests for the identity pipeline:
 *   - extractPortalUser() header parsing (whitelist, groups limits, pollution)
 *   - router trust-model consequences when x-portal-user-* headers are forged
 *
 * These tests document the trust boundary from docs/SECURITY.md: identity
 * headers are trusted unconditionally, so anything a client can put in them
 * lands in ws._portalUser verbatim. The reverse proxy MUST strip inbound
 * x-portal-user-* headers — the assertions below show exactly what breaks
 * when it does not.
 */

const { extractPortalUser } = require("../nodes/lib/helpers");
const { route } = require("../nodes/lib/router");

const MAX_GROUPS_HEADER_BYTES = 8 * 1024;

describe("extractPortalUser — header whitelist", () => {
  it("returns null when no identity header is present", () => {
    expect(extractPortalUser({})).toBeNull();
    expect(extractPortalUser({ host: "red:1880", cookie: "a=1" })).toBeNull();
  });

  it("maps only the six whitelisted headers", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-name": "Jan Kowalski",
      "x-portal-user-username": "jan",
      "x-portal-user-email": "jan@example.com",
      "x-portal-user-role": "admin",
      "x-portal-user-groups": '["ops","dev"]',
    });
    expect(user).toEqual({
      userId: "u1",
      userName: "Jan Kowalski",
      username: "jan",
      email: "jan@example.com",
      role: "admin",
      groups: ["ops", "dev"],
    });
  });

  it("ignores non-whitelisted x-portal-user-* headers (no arbitrary key injection)", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-isadmin": "true",
      "x-portal-user-__proto__": "x",
      "x-portal-user-constructor": "x",
    });
    expect(Object.keys(user)).toEqual(["userId"]);
  });

  it("ignores empty-string header values", () => {
    expect(extractPortalUser({ "x-portal-user-id": "" })).toBeNull();
  });
});

describe("extractPortalUser — groups header", () => {
  it("parses valid JSON groups", () => {
    const user = extractPortalUser({ "x-portal-user-groups": '["a","b"]' });
    expect(user.groups).toEqual(["a", "b"]);
  });

  it("falls back to the raw string on invalid JSON", () => {
    const user = extractPortalUser({ "x-portal-user-groups": "not-json" });
    expect(user.groups).toBe("not-json");
  });

  it("truncates oversized groups without JSON.parse (ReDoS/JSON-bomb guard)", () => {
    const big = '["' + "a".repeat(MAX_GROUPS_HEADER_BYTES * 2) + '"]';
    const user = extractPortalUser({ "x-portal-user-groups": big });
    expect(typeof user.groups).toBe("string");
    expect(user.groups.length).toBe(MAX_GROUPS_HEADER_BYTES);
  });

  it("groups JSON with __proto__ key does not pollute Object.prototype", () => {
    const user = extractPortalUser({
      "x-portal-user-id": "u1",
      "x-portal-user-groups": '{"__proto__":{"polluted":true}}',
    });
    // JSON.parse creates an own "__proto__" property, never the prototype.
    expect({}.polluted).toBeUndefined();
    // And Object.assign(client, user) at the WS layer copies whitelisted
    // top-level keys only — simulate it:
    const client = { portalClient: "P" };
    Object.assign(client, user);
    expect({}.polluted).toBeUndefined();
    expect(client.portalClient).toBe("P");
  });

  it("userId '__proto__' cannot poison a Map-based userIndex", () => {
    const userIndex = new Map();
    const user = extractPortalUser({ "x-portal-user-id": "__proto__" });
    userIndex.set(user.userId, new Set());
    expect(userIndex.get("__proto__")).toBeInstanceOf(Set);
    expect({}.size).toBeUndefined();
  });
});

// ── Multi-tenancy: what header forgery buys an attacker ──────────────

function fakeWs(portalClient, portalUser) {
  return { _portalClient: portalClient, _portalUser: portalUser || null, sent: [] };
}

function setupCtx() {
  const clients = new Map();
  const userIndex = new Map();
  const sendTo = (ws, frame, msg) => {
    if (!ws) return false;
    ws.sent.push({ frame: JSON.parse(frame), msg });
    return true;
  };
  function addClient(portalClient, headers) {
    // Mirrors the WS connection handler: identity comes exclusively from
    // extractPortalUser(request.headers), never from client frames.
    const ws = fakeWs(portalClient, extractPortalUser(headers || {}));
    clients.set(portalClient, ws);
    const userId = ws._portalUser && ws._portalUser.userId;
    if (userId) {
      let set = userIndex.get(userId);
      if (!set) userIndex.set(userId, (set = new Set()));
      set.add(ws);
    }
    return ws;
  }
  return { clients, userIndex, sendTo, addClient };
}

describe("multi-tenancy — honest proxy (headers set per authenticated user)", () => {
  it("user-cast reaches only that user's sessions", () => {
    const ctx = setupCtx();
    const alice1 = ctx.addClient("A1", { "x-portal-user-id": "alice" });
    const alice2 = ctx.addClient("A2", { "x-portal-user-id": "alice" });
    const bob = ctx.addClient("B1", { "x-portal-user-id": "bob" });

    const r = route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(r).toEqual({ mode: "user-cast", delivered: 2 });
    expect(alice1.sent).toHaveLength(1);
    expect(alice2.sent).toHaveLength(1);
    expect(bob.sent).toHaveLength(0);
  });

  it("anonymous client (no headers) never receives user-cast traffic", () => {
    const ctx = setupCtx();
    const anon = ctx.addClient("X1");
    ctx.addClient("A1", { "x-portal-user-id": "alice" });

    route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(anon.sent).toHaveLength(0);
  });

  it("username-cast fallback does not match anonymous clients", () => {
    const ctx = setupCtx();
    const anon = ctx.addClient("X1");
    const alice = ctx.addClient("A1", { "x-portal-user-username": "alice" });

    const r = route({ payload: "s", _client: { username: "alice" } }, ctx);
    expect(r.delivered).toBe(1);
    expect(alice.sent).toHaveLength(1);
    expect(anon.sent).toHaveLength(0);
  });
});

describe("multi-tenancy — forged headers (proxy bypassed / not stripping)", () => {
  // These are the documented consequences of the unconditional header trust:
  // if an attacker can speak to Node-RED directly, forging x-portal-user-id
  // makes them a full member of the victim's user-cast set. The package is
  // NOT resistant to this by itself — the proxy is the enforcement point.

  it("forged x-portal-user-id receives the victim's user-cast messages", () => {
    const ctx = setupCtx();
    const victim = ctx.addClient("V1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", { "x-portal-user-id": "alice" });

    route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(victim.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(1); // interception — proxy must prevent
  });

  it("forged x-portal-user-username intercepts username-cast fallback", () => {
    const ctx = setupCtx();
    const attacker = ctx.addClient("E1", {
      "x-portal-user-username": "alice",
    });
    route({ payload: "secret", _client: { username: "alice" } }, ctx);
    expect(attacker.sent).toHaveLength(1);
  });

  it("forged x-portal-user-* headers count as 'authenticated' for auth-cast (proxy must strip)", () => {
    const ctx = setupCtx();
    const real = ctx.addClient("R1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", { "x-portal-user-id": "mallory" });
    const anon = ctx.addClient("X1");

    route({ payload: "members-only", _client: { authenticated: true } }, ctx);
    expect(real.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(1); // any identity headers pass — proxy is the gate
    expect(anon.sent).toHaveLength(0);
  });

  it("forged headers do NOT grant access to unicast (portalClient is server-assigned)", () => {
    const ctx = setupCtx();
    const victim = ctx.addClient("V1", { "x-portal-user-id": "alice" });
    const attacker = ctx.addClient("E1", {
      "x-portal-user-id": "alice",
      // portalClient is a server-side crypto.randomUUID(); a client cannot
      // choose it, so pretending in headers changes nothing:
      "x-portal-user-portalclient": "V1",
    });

    route({ payload: "secret", _client: { portalClient: "V1" } }, ctx);
    expect(victim.sent).toHaveLength(1);
    expect(attacker.sent).toHaveLength(0);
  });
});

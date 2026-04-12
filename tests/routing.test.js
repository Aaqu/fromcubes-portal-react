/**
 * Unit tests for the outbound routing function.
 * Uses fake ws / store / sendTo — no Node-RED runtime, no sockets.
 */

const { route } = require("../nodes/lib/router");

function fakeWs(portalClient, userId, username) {
  return {
    _portalClient: portalClient,
    _portalUser: userId || username ? { userId, username } : null,
    sent: [],
  };
}

function setupCtx() {
  const clients = new Map();
  const userIndex = new Map();
  // sendTo records every delivery into ws.sent and returns true unless
  // a test overrides via ws._blocked.
  const sendTo = (ws, frame, msg) => {
    if (!ws || ws._blocked) return false;
    ws.sent.push({ frame: JSON.parse(frame), msg });
    return true;
  };
  function addClient(portalClient, userId, username) {
    const ws = fakeWs(portalClient, userId, username);
    clients.set(portalClient, ws);
    if (userId) {
      let set = userIndex.get(userId);
      if (!set) userIndex.set(userId, (set = new Set()));
      set.add(ws);
    }
    return ws;
  }
  return {
    clients,
    userIndex,
    sendTo,
    addClient,
  };
}

describe("router.route — unicast", () => {
  it("delivers to the target portalClient only", () => {
    const ctx = setupCtx();
    const a = ctx.addClient("A", "u1");
    const b = ctx.addClient("B", "u2");
    const c = ctx.addClient("C", "u1");

    const result = route(
      { payload: "hi", _client: { portalClient: "B" } },
      ctx,
    );
    expect(result).toEqual({ mode: "unicast", delivered: 1 });
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0].frame).toEqual({ type: "data", payload: "hi" });
    expect(c.sent).toHaveLength(0);
  });

  it("silently drops if target portalClient is unknown", () => {
    const ctx = setupCtx();
    ctx.addClient("A", "u1");
    const result = route(
      { payload: 1, _client: { portalClient: "Z" } },
      ctx,
    );
    expect(result.delivered).toBe(0);
  });
});

describe("router.route — user-cast", () => {
  it("delivers to every session of the target userId", () => {
    const ctx = setupCtx();
    const a1 = ctx.addClient("A1", "alice");
    const a2 = ctx.addClient("A2", "alice");
    const bob = ctx.addClient("B", "bob");

    const result = route(
      { payload: "hi alice", _client: { userId: "alice" } },
      ctx,
    );
    expect(result).toEqual({ mode: "user-cast", delivered: 2 });
    expect(a1.sent).toHaveLength(1);
    expect(a2.sent).toHaveLength(1);
    expect(bob.sent).toHaveLength(0);
  });

  it("does NOT leak to unrelated users", () => {
    const ctx = setupCtx();
    const alice = ctx.addClient("A1", "alice");
    const bob = ctx.addClient("B", "bob");
    route({ payload: "secret", _client: { userId: "alice" } }, ctx);
    expect(alice.sent).toHaveLength(1);
    expect(bob.sent).toHaveLength(0);
  });

  it("falls back to username scan when only username given", () => {
    const ctx = setupCtx();
    const a = ctx.addClient("A", null, "alice");
    const b = ctx.addClient("B", null, "bob");
    route({ payload: 1, _client: { username: "alice" } }, ctx);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });
});

describe("router.route — broadcast", () => {
  it("delivers to all clients when no _client is set", () => {
    const ctx = setupCtx();
    const a = ctx.addClient("A", "u1");
    const b = ctx.addClient("B", "u2");
    const result = route({ payload: "all" }, ctx);
    expect(result).toEqual({ mode: "broadcast", delivered: 2 });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("returns mode 'broadcast' so the caller can update its own recovery cache", () => {
    const ctx = setupCtx();
    ctx.addClient("A", "u1");
    const result = route({ payload: { v: 42 } }, ctx);
    expect(result.mode).toBe("broadcast");
  });

  it("unicast does NOT report broadcast mode", () => {
    const ctx = setupCtx();
    ctx.addClient("A", "u1");
    const result = route(
      { payload: "secret", _client: { portalClient: "A" } },
      ctx,
    );
    expect(result.mode).toBe("unicast");
  });
});

describe("router.route — onCanSendTo enforcement", () => {
  it("sendTo returning false blocks delivery to that ws", () => {
    const ctx = setupCtx();
    const a = ctx.addClient("A", "u1");
    const b = ctx.addClient("B", "u1");
    b._blocked = true;
    const result = route({ payload: 1, _client: { userId: "u1" } }, ctx);
    expect(result.delivered).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });
});

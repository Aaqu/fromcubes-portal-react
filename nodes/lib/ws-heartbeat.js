const PING_INTERVAL_MS = 30_000;

/**
 * Shared WebSocket heartbeat manager. One interval walks all registered
 * WebSocket.Server instances, replacing per-client timers.
 *
 * @param {Object} RED
 * @returns {{ registerPingedServer: Function, unregisterPingedServer: Function }}
 */
function createWsHeartbeat(RED) {
  if (!RED.settings.portalReactPingedServers) {
    RED.settings.portalReactPingedServers = new Set();
  }
  const pingedServers = RED.settings.portalReactPingedServers;

  if (!RED.settings.portalReactPingTick) {
    RED.settings.portalReactPingTick = { iv: null };
  }
  const pingTick = RED.settings.portalReactPingTick;

  function pingSweep() {
    for (const srv of pingedServers) {
      try {
        srv.clients.forEach((ws) => {
          if (ws._isAlive === false) {
            try { ws.terminate(); } catch (e) { RED.log.trace("[portal-react] ws terminate: " + e.message); }
            return;
          }
          ws._isAlive = false;
          try { ws.ping(); } catch (e) { RED.log.trace("[portal-react] ws ping: " + e.message); }
        });
      } catch (e) {
        RED.log.trace("[portal-react] ping sweep: " + e.message);
      }
    }
  }

  function registerPingedServer(wsServer) {
    if (pingedServers.has(wsServer)) return;
    pingedServers.add(wsServer);
    if (!pingTick.iv) {
      pingTick.iv = setInterval(pingSweep, PING_INTERVAL_MS);
      pingTick.iv.unref?.();
    }
  }

  function unregisterPingedServer(wsServer) {
    if (!pingedServers.delete(wsServer)) return;
    if (pingedServers.size === 0 && pingTick.iv) {
      clearInterval(pingTick.iv);
      pingTick.iv = null;
    }
  }

  return { registerPingedServer, unregisterPingedServer };
}

module.exports = { createWsHeartbeat };

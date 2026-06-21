/**
 * Public portal page route factory.
 *
 * Owns only the HTTP response branching for a portal endpoint:
 * building/teardown, hard build error, degraded last-good build, and fresh
 * successful build. Runtime lifecycle, WebSocket handling, and pageState
 * mutation stay in portal-react.js.
 */

function buildBuildingPage(wsPath) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Building\u2026</title><style>@keyframes __sp{to{transform:rotate(360deg)}}body{font-family:monospace;background:#111;color:#888;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}</style></head><body><div style="font-size:24px;margin-bottom:16px">Building\u2026</div><div style="width:40px;height:40px;border:3px solid #333;border-top-color:#888;border-radius:50%;animation:__sp .8s linear infinite"></div><script>(function(){let r=0;function c(){const p=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(p+'//'+location.host+'${wsPath}');ws.onmessage=function(e){try{const m=JSON.parse(e.data);if((m.type==='version'&&m.hash)||m.type==='error')location.reload();}catch(_){}};ws.onclose=function(){const d=Math.min(500*Math.pow(2,r),8000);r++;setTimeout(c,d);};ws.onerror=function(){ws.close();};}c();})()</script></body></html>`;
}

function withNoStore(res) {
  return res.set("Cache-Control", "no-store");
}

/**
 * @param {Object} opts
 * @param {string} opts.endpoint
 * @param {Object<string, Object>} opts.pageState
 * @param {string} opts.wsPath
 * @param {string} opts.pageTitle
 * @param {string} opts.adminRoot
 * @param {Function} opts.buildPage
 * @param {Function} opts.buildErrorPage
 * @param {Function} opts.extractPortalUser
 * @returns {Function}
 */
function createPortalPageHandler(opts) {
  const {
    endpoint,
    pageState,
    wsPath,
    pageTitle,
    adminRoot,
    buildPage,
    buildErrorPage,
    extractPortalUser,
  } = opts;

  return async function portalPageHandler(req, res) {
    try {
      const state = pageState[endpoint];
      if (!state || state.building || !state.compiled) {
        const bWsPath = state?.wsPath || wsPath;
        withNoStore(res)
          .type("text/html")
          .send(buildBuildingPage(bWsPath));
        return;
      }

      withNoStore(res);
      if (state.compiled.error) {
        if (state.lastGood) {
          const user = state.portalAuth
            ? extractPortalUser(req.headers)
            : null;
          res
            .type("text/html")
            .send(
              buildPage(
                state.lastGood.pageTitle,
                state.lastGood.compiledJs,
                state.wsPath,
                state.lastGood.customHead,
                state.lastGood.cssHash,
                user,
                state.showWsStatus,
                adminRoot,
              ),
            );
          return;
        }

        res
          .status(500)
          .type("text/html")
          .send(
            buildErrorPage(
              state.pageTitle,
              state.compiled.error,
              state.wsPath,
            ),
          );
        return;
      }

      const { cssHash } = await Promise.race([
        state.cssReady,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("CSS generation timeout")),
            15000,
          ),
        ),
      ]);
      const user = state.portalAuth ? extractPortalUser(req.headers) : null;
      res
        .type("text/html")
        .send(
          buildPage(
            state.pageTitle,
            state.compiled.js,
            state.wsPath,
            state.customHead,
            cssHash,
            user,
            state.showWsStatus,
            adminRoot,
          ),
        );
    } catch (e) {
      res
        .status(500)
        .type("text/html")
        .send(
          buildErrorPage(
            pageTitle,
            "Page build failed: " + e.message,
            wsPath,
          ),
        );
    }
  };
}

module.exports = { createPortalPageHandler };

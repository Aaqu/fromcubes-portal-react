/**
 * HTML page builders for portal-react.
 */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escScript(s) {
  return String(s).replace(/<\/(script)/gi, "<\\/$1");
}

const ERROR_OVERLAY_CSS = `
  #__error_overlay {
    position: fixed; inset: 0; z-index: 99999;
    background: #1a0000; color: #f87171;
    font-family: monospace; padding: 40px;
    overflow: auto;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  }
  #__error_overlay h1 { color: #ff4444; margin: 0 0 16px; font-size: 24px }
  #__error_overlay p.__hint { color: #888; margin: 0 0 16px }
  #__error_overlay pre {
    background: #0a0a0a; border: 1px solid #ff4444; border-radius: 8px;
    padding: 20px; color: #fca5a5;
    max-width: 90vw; max-height: 60vh; overflow: auto;
    white-space: pre-wrap; margin: 0;
  }
  #__error_overlay p.__status { color: #4ade80; font-size: 12px; margin: 24px 0 0 }
  #__error_overlay p.__status.__off { color: #888 }
  #__error_banner {
    position: fixed; top: 8px; right: 8px; z-index: 99998;
    max-width: 360px; padding: 8px 12px;
    background: #1a0000; color: #fca5a5;
    border: 1px solid #ff4444; border-radius: 6px;
    font-family: monospace; font-size: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,.4);
    cursor: pointer; user-select: none;
  }
  #__error_banner b { color: #ff4444; display: block; margin-bottom: 2px }
  #__error_banner.__expanded {
    max-width: 70vw; max-height: 60vh; overflow: auto;
    cursor: default;
  }
  #__error_banner pre {
    margin: 8px 0 0; padding: 8px; background: #0a0a0a;
    border-radius: 4px; white-space: pre-wrap; display: none;
  }
  #__error_banner.__expanded pre { display: block }
  #__error_banner .__close {
    float: right; padding: 0 4px; color: #888; cursor: pointer;
  }
`;

// Shared error overlay markup (HTML inside #__error_overlay).
// Used by buildPage (WS error frame, runtime try/catch) and buildErrorPage.
function errorOverlayInnerHtml({ title, hint, message, statusLine, statusOk }) {
  return (
    `<h1>${esc(title)}</h1>` +
    (hint ? `<p class="__hint">${esc(hint)}</p>` : "") +
    `<pre>${esc(message)}</pre>` +
    (statusLine
      ? `<p class="__status${statusOk ? "" : " __off"}" id="__err_status">${esc(statusLine)}</p>`
      : "")
  );
}

const DEFAULT_HINT = "Fix the component code in Node-RED and deploy again.";

function buildPage(title, transpiledJs, wsPath, customHead, cssHash, user, showWsStatus, adminRoot) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1.0">
      <title>${esc(title)}</title>
      ${cssHash ? `<link rel="stylesheet" href="${adminRoot}/portal-react/css/${cssHash}.css">` : ""}
      ${escScript(customHead)}
      <style>${ERROR_OVERLAY_CSS}</style>
      ${showWsStatus ? `<style>
        #__cs {
          position: fixed; bottom: 6px; right: 6px;
          padding: 3px 8px; font-size: 10px; border-radius: 3px;
          z-index: 99999; background: #111; border: 1px solid #333;
          opacity: .7; transition: opacity .2s;
        }
        #__cs:hover { opacity: 1 }
        #__cs.ok { color: #4ade80 }
        #__cs.err { color: #f87171 }
      </style>` : ""}
    </head>
    <body>
      <div id="root"></div>
      ${showWsStatus ? `<div id="__cs" class="err">fromcubes</div>` : ""}
      <script>
        function __safe(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
        function __renderErrorOverlay(title, message, hint) {
          const root = document.getElementById('root');
          if (root) root.style.display = 'none';
          const bo = document.getElementById('__building_overlay');
          if (bo) bo.remove();
          const bn = document.getElementById('__error_banner');
          if (bn) bn.remove();
          let ov = document.getElementById('__error_overlay');
          if (!ov) { ov = document.createElement('div'); ov.id = '__error_overlay'; document.body.appendChild(ov); }
          ov.innerHTML = '<h1>' + __safe(title) + '</h1>'
            + (hint ? '<p class="__hint">' + __safe(hint) + '</p>' : '')
            + '<pre>' + __safe(message) + '</pre>'
            + '<p class="__status __off" id="__err_status">Waiting for redeploy\\u2026</p>';
        }
        function __renderErrorBanner(message) {
          const ov = document.getElementById('__error_overlay');
          if (ov) ov.remove();
          const bo = document.getElementById('__building_overlay');
          if (bo) bo.remove();
          const root = document.getElementById('root');
          if (root) root.style.display = '';
          let bn = document.getElementById('__error_banner');
          if (!bn) {
            bn = document.createElement('div');
            bn.id = '__error_banner';
            document.body.appendChild(bn);
            bn.addEventListener('click', function(e) {
              if (e.target && e.target.className === '__close') { bn.remove(); return; }
              bn.classList.toggle('__expanded');
            });
          }
          bn.innerHTML = '<span class="__close" title="Dismiss">\\u00d7</span>'
            + '<b>\\u26a0 Latest deploy failed</b>'
            + '<span>Running previous version. Click for details.</span>'
            + '<pre>' + __safe(message) + '</pre>';
        }
        function __clearErrorOverlay() {
          const ov = document.getElementById('__error_overlay');
          if (ov) ov.remove();
          const bn = document.getElementById('__error_banner');
          if (bn) bn.remove();
          const root = document.getElementById('root');
          if (root) root.style.display = '';
        }
        window.__NR = {
          _ws: null,
          _listeners: new Set(),
          _lastData: null,
          _ignoreRecovery: false,
          _retries: 0,
          _wasConnected: false,
          _version: null,
          _portalClient: null,
          // Set on building/error WS frames. Next version with real hash reloads,
          // independent of hash diff (build may produce same hash again).
          _buildErrorActive: false,
          // Pending runtime error message captured before WS opened.
          // Flushed in onopen so node status can go red even when the
          // exception fires synchronously during initial bundle execution.
          _pendingRuntimeError: null,
          _user: ${user ? escScript(JSON.stringify(user)) : "null"},

          connect() {
            const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(p + '//' + location.host + '${wsPath}');
            this._ws = ws;
            const s = document.getElementById('__cs');

            ws.onopen = () => {
              if (s) { s.textContent = 'fromcubes • connected'; s.className = 'ok'; }
              this._retries = 0;
              this._wasConnected = true;
              const es = document.getElementById('__err_status');
              if (es) { es.textContent = 'Connected \\u2014 will reload on redeploy'; es.className = '__status'; }
              if (this._pendingRuntimeError) {
                try { ws.send(JSON.stringify({ type: 'runtime_error', message: this._pendingRuntimeError })); } catch(_) {}
                this._pendingRuntimeError = null;
              }
            };

            ws.onmessage = (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.type === 'hello') {
                  this._portalClient = m.portalClient;
                }
                if (m.type === 'version') {
                  // Empty hash = server still in building/error state, ignore (overlay stays).
                  if (!m.hash) return;
                  // Reload when server was in build-error/building (recover regardless of
                  // hash) OR when hash differs from prior known hash (deploy detected).
                  // Do NOT reload merely because an overlay is in the DOM: a runtime
                  // exception caught locally renders the same overlay node and would
                  // otherwise loop reload to runtime-error to reload forever.
                  if (this._buildErrorActive || (this._version && this._version !== m.hash)) {
                    location.reload();
                    return;
                  }
                  this._version = m.hash;
                }
                if (m.type === 'building') {
                  this._buildErrorActive = true;
                  document.getElementById('root').style.display = 'none';
                  const eo = document.getElementById('__error_overlay');
                  if (eo) eo.remove();
                  if (!document.getElementById('__building_overlay')) {
                    const ov = document.createElement('div');
                    ov.id = '__building_overlay';
                    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#111;color:#888;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace';
                    ov.innerHTML = '<div style="font-size:24px;margin-bottom:16px">Building\\u2026</div>'
                      + '<div style="width:40px;height:40px;border:3px solid #333;border-top-color:#888;border-radius:50%;animation:__sp .8s linear infinite"></div>'
                      + '<style>@keyframes __sp{to{transform:rotate(360deg)}}</style>';
                    document.body.appendChild(ov);
                  }
                }
                if (m.type === 'error') {
                  this._buildErrorActive = true;
                  if (m.degraded) {
                    __renderErrorBanner(m.message);
                  } else {
                    __renderErrorOverlay('Build Error', m.message, ${JSON.stringify(DEFAULT_HINT)});
                    const es2 = document.getElementById('__err_status');
                    if (es2) { es2.textContent = 'Connected \\u2014 will reload on redeploy'; es2.className = '__status'; }
                  }
                }
                if (m.type === 'data') {
                  this._lastData = m.payload;
                  this._listeners.forEach(fn => fn(m.payload));
                }
                if (m.type === 'recovery') {
                  // Cached last broadcast at connect time. Seeded into
                  // _lastData unless the page opted out via
                  // useNodeRed({ ignoreRecovery: true }).
                  if (this._ignoreRecovery) return;
                  this._lastData = m.payload;
                  this._listeners.forEach(fn => fn(m.payload));
                }
              } catch (err) { console.error('WS parse', err); }
            };

            ws.onclose = () => {
              if (s) { s.textContent = 'fromcubes • disconnected'; s.className = 'err'; }
              this._ws = null;
              const es = document.getElementById('__err_status');
              if (es) { es.textContent = 'Disconnected \\u2014 reconnecting\\u2026'; es.className = '__status __off'; }
              const delay = Math.min(500 * Math.pow(2, this._retries), 8000);
              this._retries++;
              setTimeout(() => this.connect(), delay);
            };

            ws.onerror = () => ws.close();
          },

          subscribe(fn) {
            this._listeners.add(fn);
            if (this._lastData !== null) fn(this._lastData);
            return () => this._listeners.delete(fn);
          },

          send(payload, topic) {
            if (this._ws && this._ws.readyState === 1)
              this._ws.send(JSON.stringify({ type: 'output', payload, topic: topic || '' }));
          }
        };
        window.__NR.connect();
      <\/script>
      <script>
        try { ${escScript(transpiledJs)}
        } catch(__e) {
          const __m = (__e && (__e.stack || __e.message)) || String(__e);
          __renderErrorOverlay('Runtime Error', __m, ${JSON.stringify(DEFAULT_HINT)});
          // Report back to server so node status goes red. WS may not be open
          // yet (sync throw during initial bundle); queue until onopen.
          try {
            if (window.__NR && window.__NR._ws && window.__NR._ws.readyState === 1) {
              window.__NR._ws.send(JSON.stringify({ type: 'runtime_error', message: __m }));
            } else if (window.__NR) {
              window.__NR._pendingRuntimeError = __m;
            }
          } catch(_) {}
        }
      <\/script>
    </body>
    </html>`;
}

function buildErrorPage(title, error, wsPath) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${esc(title)} — Error</title>
      <style>${ERROR_OVERLAY_CSS}</style>
    </head>
    <body>
      <div id="__error_overlay">${errorOverlayInnerHtml({
        title: "Build Error",
        hint: DEFAULT_HINT,
        message: error,
        statusLine: "Waiting for redeploy…",
        statusOk: false,
      })}</div>
      <script>
        (function() {
          const st = document.getElementById('__err_status');
          const pre = document.querySelector('#__error_overlay pre');
          let retries = 0;
          function setStatus(text, ok) {
            if (!st) return;
            st.textContent = text;
            st.className = '__status' + (ok ? '' : ' __off');
          }
          function connect() {
            const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(p + '//' + location.host + '${wsPath}');
            ws.onopen = function() {
              retries = 0;
              setStatus('Connected \\u2014 will reload on redeploy', true);
            };
            ws.onmessage = function(e) {
              try {
                const m = JSON.parse(e.data);
                if (m.type === 'version' && m.hash) location.reload();
                if (m.type === 'error' && pre) pre.textContent = m.message;
              } catch(_) {}
            };
            ws.onclose = function() {
              setStatus('Disconnected \\u2014 reconnecting\\u2026', false);
              const delay = Math.min(500 * Math.pow(2, retries), 8000);
              retries++;
              setTimeout(connect, delay);
            };
            ws.onerror = function() { ws.close(); };
          }
          ${wsPath ? "connect();" : ""}
          setInterval(function() {
            fetch(location.href, { method: 'HEAD', cache: 'no-store' })
              .then(function(r) { if (r.ok) location.reload(); })
              .catch(function() {});
          }, 3000);
        })();
      <\/script>
    </body>
    </html>`;
}

module.exports = { buildPage, buildErrorPage };

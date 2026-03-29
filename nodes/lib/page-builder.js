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

function buildPage(title, transpiledJs, wsPath, customHead, cssHash, user, showWsStatus, adminRoot) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1.0">
      <title>${esc(title)}</title>
      ${cssHash ? `<link rel="stylesheet" href="${adminRoot}/portal-react/css/${cssHash}.css">` : ""}
      ${escScript(customHead)}
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
        window.__NR = {
          _ws: null,
          _listeners: new Set(),
          _lastData: null,
          _retries: 0,
          _wasConnected: false,
          _version: null,
          _portalClient: null,
          _user: ${user ? escScript(JSON.stringify(user)) : "null"},

          connect() {
            const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(p + '//' + location.host + '${wsPath}');
            this._ws = ws;
            const s = document.getElementById('__cs');

            ws.onopen = () => {
              if (s) { s.textContent = 'fromcubes \u2022 connected'; s.className = 'ok'; }
              this._retries = 0;
              this._wasConnected = true;
            };

            ws.onmessage = (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.type === 'hello') {
                  this._portalClient = m.portalClient;
                }
                if (m.type === 'version') {
                  var hasOverlay = document.getElementById('__building_overlay') || document.getElementById('__error_overlay');
                  if (hasOverlay || (this._version && this._version !== m.hash)) { location.reload(); return; }
                  this._version = m.hash;
                }
                if (m.type === 'building') {
                  document.getElementById('root').style.display = 'none';
                  var eo = document.getElementById('__error_overlay');
                  if (eo) eo.remove();
                  if (!document.getElementById('__building_overlay')) {
                    var ov = document.createElement('div');
                    ov.id = '__building_overlay';
                    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#111;color:#888;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace';
                    ov.innerHTML = '<div style="font-size:24px;margin-bottom:16px">Building\\u2026</div>'
                      + '<div style="width:40px;height:40px;border:3px solid #333;border-top-color:#888;border-radius:50%;animation:__sp .8s linear infinite"></div>'
                      + '<style>@keyframes __sp{to{transform:rotate(360deg)}}</style>';
                    document.body.appendChild(ov);
                  }
                }
                if (m.type === 'error') {
                  document.getElementById('root').style.display = 'none';
                  var bo = document.getElementById('__building_overlay');
                  if (bo) bo.remove();
                  var ov = document.getElementById('__error_overlay');
                  if (!ov) {
                    ov = document.createElement('div');
                    ov.id = '__error_overlay';
                    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a0000;color:#f87171;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;padding:40px';
                    document.body.appendChild(ov);
                  }
                  ov.innerHTML = '<h1 style="color:#ff4444;margin-bottom:16px;font-size:24px">JSX Transpile Error</h1>'
                    + '<p style="color:#888;margin-bottom:16px">Fix the component code in Node-RED and deploy again.</p>'
                    + '<pre style="background:#0a0a0a;border:1px solid #ff4444;border-radius:8px;padding:20px;overflow-x:auto;color:#fca5a5;max-width:90vw;max-height:60vh;overflow:auto;white-space:pre-wrap">'
                    + m.message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    + '</pre>'
                    + '<p style="color:#4ade80;font-size:12px;margin-top:24px">Connected \\u2014 will reload on redeploy</p>';
                }
                if (m.type === 'data') {
                  this._lastData = m.payload;
                  this._listeners.forEach(fn => fn(m.payload));
                }
              } catch (err) { console.error('WS parse', err); }
            };

            ws.onclose = () => {
              if (s) { s.textContent = 'fromcubes \u2022 disconnected'; s.className = 'err'; }
              this._ws = null;
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
          var __r = document.getElementById('root');
          __r.style.cssText = 'font-family:monospace;background:#1a0000;color:#f87171;padding:40px;min-height:100vh;margin:0';
          __r.innerHTML = '<h1 style="color:#ff4444;margin-bottom:16px">Runtime Error</h1>'
            + '<p style="color:#888">Fix the component code in Node-RED and deploy again.</p>'
            + '<pre style="background:#0a0a0a;border:1px solid #ff4444;border-radius:8px;padding:20px;overflow-x:auto;color:#fca5a5;white-space:pre-wrap">'
            + (__e.message || __e).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
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
      <style>
        body { font-family: monospace; background: #1a0000; color: #f87171; padding: 40px; line-height: 1.6 }
        h1 { color: #ff4444; margin-bottom: 16px }
        pre { background: #0a0a0a; border: 1px solid #ff4444; border-radius: 8px; padding: 20px; overflow-x: auto; color: #fca5a5 }
        .status { color: #888; font-size: 12px; margin-top: 24px }
        .status.ok { color: #4ade80 }
      </style>
    </head>
    <body>
      <h1>JSX Transpile Error</h1>
      <p>Fix the component code in Node-RED and deploy again.</p>
      <pre>${esc(error)}</pre>
      <p class="status" id="st">Waiting for redeploy…</p>
      <script>
        (function() {
          var st = document.getElementById('st');
          var retries = 0;
          function connect() {
            var p = location.protocol === 'https:' ? 'wss:' : 'ws:';
            var ws = new WebSocket(p + '//' + location.host + '${wsPath}');
            ws.onopen = function() {
              retries = 0;
              if (st) { st.textContent = 'Connected \\u2014 will reload on redeploy'; st.className = 'status ok'; }
            };
            ws.onmessage = function(e) {
              try {
                var m = JSON.parse(e.data);
                if (m.type === 'version' && m.hash) location.reload();
                if (m.type === 'error') { var pre = document.querySelector('pre'); if (pre) pre.textContent = m.message; }
              } catch(_) {}
            };
            ws.onclose = function() {
              if (st) { st.textContent = 'Disconnected \\u2014 reconnecting\\u2026'; st.className = 'status'; }
              var delay = Math.min(500 * Math.pow(2, retries), 8000);
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

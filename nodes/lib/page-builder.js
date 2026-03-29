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
                  if (this._version && this._version !== m.hash) { location.reload(); return; }
                  this._version = m.hash;
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
        ${escScript(transpiledJs)}
      <\/script>
    </body>
    </html>`;
}

function buildErrorPage(title, error) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${esc(title)} — Error</title>
      <style>
        body { font-family: monospace; background: #1a0000; color: #f87171; padding: 40px; line-height: 1.6 }
        h1 { color: #ff4444; margin-bottom: 16px }
        pre { background: #0a0a0a; border: 1px solid #ff4444; border-radius: 8px; padding: 20px; overflow-x: auto; color: #fca5a5 }
      </style>
    </head>
    <body>
      <h1>JSX Transpile Error</h1>
      <p>Fix the component code in Node-RED and deploy again.</p>
      <pre>${esc(error)}</pre>
    </body>
    </html>`;
}

module.exports = { buildPage, buildErrorPage };

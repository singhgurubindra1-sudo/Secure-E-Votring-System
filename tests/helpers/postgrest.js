'use strict';

/**
 * A throwaway stand-in for Supabase's PostgREST endpoint on 127.0.0.1.
 *
 * Captures the rows the mirror posts instead of storing them, so the real
 * mirror path can be exercised with nothing leaving the machine and no live
 * project involved. It can also be told to fail, so the promise that a broken
 * mirror never breaks a vote is something the suite actually checks rather
 * than something the comments merely claim.
 */

const http = require('http');

function startPostgrest({ status = 201, body = null, delayMs = 0 } = {}) {
  const requests = [];
  const state = { status, body, delayMs };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }

      requests.push({
        method: req.method,
        url: req.url,
        // The table is the last path segment of /rest/v1/<table>.
        table: (req.url.split('?')[0].split('/').filter(Boolean).pop()) || '',
        headers: req.headers,
        row: parsed,
      });

      const send = () => {
        if (state.body) {
          res.writeHead(state.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(state.body));
        } else {
          res.writeHead(state.status);
          res.end();
        }
      };

      if (state.delayMs) setTimeout(send, state.delayMs);
      else send();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        /** Change what the next request gets back. */
        respondWith(next) { Object.assign(state, next); },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startPostgrest };

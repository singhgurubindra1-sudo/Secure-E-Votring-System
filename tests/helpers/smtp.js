'use strict';

/**
 * A throwaway SMTP server on 127.0.0.1, just complete enough for nodemailer to
 * complete a session. It captures the raw message instead of relaying it, so
 * the live (non dry-run) send path can be exercised with nothing leaving the
 * machine.
 */

const net = require('net');

function startSmtpServer() {
  const messages = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let raw = '';
    const envelope = { from: null, to: [] };

    const say = (line) => socket.write(`${line}\r\n`);
    say('220 localhost ESMTP test');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          raw += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ raw, from: envelope.from, to: [...envelope.to] });
          raw = '';
          say('250 2.0.0 Ok: queued as TEST');
          continue;
        }

        const brk = buffer.indexOf('\r\n');
        if (brk < 0) return;
        const line = buffer.slice(0, brk);
        buffer = buffer.slice(brk + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          say('250-localhost greets you');
          say('250-AUTH PLAIN LOGIN');
          say('250-8BITMIME');
          say('250 SIZE 52428800');
        } else if (upper.startsWith('AUTH')) {
          say('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('MAIL FROM')) {
          envelope.from = (line.match(/<([^>]*)>/) || [])[1] || null;
          say('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          const addr = (line.match(/<([^>]*)>/) || [])[1];
          if (addr) envelope.to.push(addr);
          say('250 2.1.5 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
          return;
        } else if (upper === 'RSET' || upper.startsWith('NOOP')) {
          say('250 2.0.0 Ok');
        } else {
          say('250 2.0.0 Ok');
        }
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ------------------------------------------------------------------ MIME bits

function decodeQuotedPrintable(body) {
  return body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function splitHeaders(chunk) {
  const brk = chunk.indexOf('\r\n\r\n');
  const rawHeaders = brk < 0 ? chunk : chunk.slice(0, brk);
  const body = brk < 0 ? '' : chunk.slice(brk + 4);

  const headers = {};
  // Unfold continuation lines before splitting on the colon.
  rawHeaders.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach((line) => {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  });

  return { headers, body };
}

/** Flattens a (possibly nested) MIME message into its leaf parts. */
function leafParts(chunk) {
  const { headers, body } = splitHeaders(chunk);
  const type = headers['content-type'] || '';
  const boundary = (type.match(/boundary="?([^";]+)"?/i) || [])[1];

  if (!boundary) {
    const encoding = (headers['content-transfer-encoding'] || '7bit').toLowerCase();
    let content;
    if (encoding === 'base64') content = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (encoding === 'quoted-printable') content = Buffer.from(decodeQuotedPrintable(body), 'latin1');
    else content = Buffer.from(body, 'utf8');
    return [{ headers, type, content }];
  }

  return body
    .split(`--${boundary}`)
    .slice(1, -1)
    .flatMap((segment) => leafParts(segment.replace(/^\r\n/, '')));
}

function parseMessage(raw) {
  const { headers } = splitHeaders(raw);
  return { headers, parts: leafParts(raw) };
}

module.exports = { startSmtpServer, parseMessage };

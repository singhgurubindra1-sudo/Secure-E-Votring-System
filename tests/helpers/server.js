'use strict';

/**
 * Boots the real server.js in a child process against the project's data
 * directory, with the roll seeded from voters.sample.json.
 *
 * The data files it touches are saved and put back on stop(), so running the
 * suite leaves data/ exactly as it was found.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const MANAGED = ['voters.json', 'users.json', 'tickets.json', 'votes.json'];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startServer(env = {}) {
  // Save whatever is on disk so the suite is non-destructive.
  const saved = new Map();
  for (const file of MANAGED) {
    const full = path.join(DATA, file);
    try {
      saved.set(file, await fs.readFile(full, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      saved.set(file, null);
    }
  }

  const roll = await fs.readFile(path.join(DATA, 'voters.sample.json'), 'utf8');
  await fs.writeFile(path.join(DATA, 'voters.json'), roll, 'utf8');
  for (const file of ['users.json', 'tickets.json', 'votes.json']) {
    await fs.writeFile(path.join(DATA, file), '[]\n', 'utf8');
  }

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      JWT_SECRET: 'end-to-end-test-secret-long-enough-to-pass',
      SESSION_HOURS: '1',
      MAIL_DRY_RUN: 'true',
      TICKET_INBOX: 'support-inbox@example.test',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: 'unused@example.test',
      SMTP_PASS: 'unused',
    },
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base, child);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n--- server output ---\n${logs.join('')}`);
  }

  async function stop() {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    for (const [file, contents] of saved) {
      const full = path.join(DATA, file);
      if (contents === null) await fs.rm(full, { force: true });
      else await fs.writeFile(full, contents, 'utf8');
    }
  }

  return { base, port, stop, logs };
}

/** A fetch bound to the server that carries the session cookie across calls. */
function makeClient(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(pathname, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${base}${pathname}`, { ...options, headers, redirect: 'manual' });
      const setCookie = res.headers.getSetCookie?.() || [];
      for (const entry of setCookie) {
        const pair = entry.split(';')[0];
        if (pair.startsWith('ev_session=')) cookie = pair;
      }
      return res;
    },
    json(pathname, body, method = 'POST') {
      return this.request(pathname, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

module.exports = { startServer, makeClient };

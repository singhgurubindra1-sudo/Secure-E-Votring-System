'use strict';

/**
 * Boots the real server.js in a child process against a throwaway data
 * directory.
 *
 * Each server gets its own DATA_DIR under the OS temp folder, seeded from
 * data/voters.sample.json and data/candidates.json. Nothing in the repository's
 * data/ is read or written, so test files run concurrently without fighting
 * over the same JSON, and a real face enrolled locally is never disturbed.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const REPO_DATA = path.join(ROOT, 'data');

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

async function waitForHealth(base, child, timeoutMs = 20000) {
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

/** A fresh data directory holding the roll, the candidates and empty stores. */
async function seedDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-data-'));

  const roll = await fs.readFile(path.join(REPO_DATA, 'voters.sample.json'), 'utf8');
  await fs.writeFile(path.join(dir, 'voters.json'), roll, 'utf8');

  const candidates = await fs.readFile(path.join(REPO_DATA, 'candidates.json'), 'utf8');
  await fs.writeFile(path.join(dir, 'candidates.json'), candidates, 'utf8');

  // Each server gets its own outbox and uploads too. Without this, test files
  // run concurrently and every one of them asserts on the contents of the same
  // two shared directories.
  await fs.mkdir(path.join(dir, 'outbox'), { recursive: true });
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });

  for (const file of ['users.json', 'tickets.json', 'votes.json']) {
    await fs.writeFile(path.join(dir, file), '[]\n', 'utf8');
  }
  await fs.writeFile(path.join(dir, 'face-templates.json'), '{}\n', 'utf8');

  return dir;
}

async function startServer(env = {}) {
  const dataDir = await seedDataDir();
  const port = await freePort();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      OUTBOX_DIR: path.join(dataDir, 'outbox'),
      UPLOAD_DIR: path.join(dataDir, 'uploads'),
      JWT_SECRET: 'end-to-end-test-secret-long-enough-to-pass',
      SESSION_HOURS: '1',
      MAIL_DRY_RUN: 'true',
      TICKET_INBOX: 'support-inbox@example.test',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: 'unused@example.test',
      SMTP_PASS: 'unused',
      ...env,
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
    await fs.rm(dataDir, { recursive: true, force: true });
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
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return {
    base,
    port,
    dataDir,
    outboxDir: path.join(dataDir, 'outbox'),
    uploadDir: path.join(dataDir, 'uploads'),
    stop,
    logs,
  };
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

'use strict';

/**
 * A very small JSON-file data store.
 *
 * Every write goes to a temp file and is then renamed over the target, so a
 * crash mid-write can never leave a half-written data file behind. Writes are
 * queued per file so two concurrent requests cannot clobber each other.
 *
 * Swapping this for PostgreSQL/MongoDB later only means rewriting this file --
 * the routes only ever call read() and update().
 */

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const queues = new Map();

function filePath(name) {
  if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error('Bad store name: ' + name);
  return path.join(DATA_DIR, name.endsWith('.json') ? name : name + '.json');
}

async function read(name, fallback = []) {
  try {
    const raw = await fs.readFile(filePath(name), 'utf8');
    const trimmed = raw.trim();
    return trimmed ? JSON.parse(trimmed) : fallback;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeNow(name, value) {
  const target = filePath(name);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, target);
  return value;
}

/**
 * Read-modify-write under a per-file lock.
 * mutator receives the current contents and returns the new contents.
 */
function update(name, mutator, fallback = []) {
  const prev = queues.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    const current = await read(name, fallback);
    const updated = await mutator(current);
    await writeNow(name, updated);
    return updated;
  });
  // Keep the chain alive even if one link rejects.
  queues.set(name, next.catch(() => {}));
  return next;
}

module.exports = { read, update, write: writeNow, DATA_DIR };

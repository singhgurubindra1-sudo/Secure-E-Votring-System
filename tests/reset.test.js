'use strict';

/**
 * scripts/reset.js deletes things, so what it spares matters as much as what it
 * clears. The default run must not wipe an enrolled face or the electoral roll.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'reset.js');

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-reset-'));
  fs.writeFileSync(path.join(dir, 'votes.json'), JSON.stringify([{ voterKey: 'a', receipt: 'R' }]));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'u1' }]));
  fs.writeFileSync(path.join(dir, 'tickets.json'), JSON.stringify([{ reference: 'EV-1' }]));
  fs.writeFileSync(path.join(dir, 'voters.json'), JSON.stringify([{ voterId: 'PNB4521907' }]));
  fs.writeFileSync(path.join(dir, 'face-templates.json'), JSON.stringify({ PNB4521907: { descriptors: [[1]] } }));
  fs.mkdirSync(path.join(dir, 'faces'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'faces', 'PNB4521907.jpg'), 'x');
  return dir;
}

const run = (dir, args = []) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATA_DIR: dir },
    encoding: 'utf8',
  });

const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const exists = (p) => fs.existsSync(p);

test('the default reset', async (t) => {
  const dir = makeDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const output = run(dir);

  await t.test('clears ballots, accounts and tickets', () => {
    assert.deepEqual(read(dir, 'votes.json'), []);
    assert.deepEqual(read(dir, 'users.json'), []);
    assert.deepEqual(read(dir, 'tickets.json'), []);
  });

  await t.test('keeps the electoral roll', () => {
    assert.equal(read(dir, 'voters.json').length, 1);
  });

  await t.test('keeps an enrolled face, so testing does not mean re-enrolling', () => {
    assert.deepEqual(Object.keys(read(dir, 'face-templates.json')), ['PNB4521907']);
    assert.equal(exists(path.join(dir, 'faces', 'PNB4521907.jpg')), true);
  });

  await t.test('says what it did', () => {
    assert.match(output, /ballots: cleared 1/);
    assert.match(output, /portal accounts: cleared 1/);
  });
});

test('--votes clears only the ballots', async (t) => {
  const dir = makeDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  run(dir, ['--votes']);
  assert.deepEqual(read(dir, 'votes.json'), []);
  assert.equal(read(dir, 'users.json').length, 1, 'accounts should survive --votes');
  assert.equal(read(dir, 'tickets.json').length, 1, 'tickets should survive --votes');
});

test('--faces clears the biometric data only', async (t) => {
  const dir = makeDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  run(dir, ['--faces']);
  assert.deepEqual(read(dir, 'face-templates.json'), {});
  assert.equal(exists(path.join(dir, 'faces', 'PNB4521907.jpg')), false);
  assert.equal(read(dir, 'votes.json').length, 1, 'ballots should survive --faces');
  assert.equal(read(dir, 'voters.json').length, 1, 'the roll should survive --faces');
});

test('--all clears everything including the roll', async (t) => {
  const dir = makeDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const output = run(dir, ['--all']);
  assert.deepEqual(read(dir, 'votes.json'), []);
  assert.deepEqual(read(dir, 'users.json'), []);
  assert.deepEqual(read(dir, 'tickets.json'), []);
  assert.deepEqual(read(dir, 'voters.json'), []);
  assert.deepEqual(read(dir, 'face-templates.json'), {});
  assert.match(output, /import-voters/, 'should say how to put the roll back');
});

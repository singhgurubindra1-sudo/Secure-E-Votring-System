#!/usr/bin/env node
'use strict';

/**
 * Clears the data a test run leaves behind, so the portal can be exercised
 * again from a clean state.
 *
 *   npm run reset              votes, accounts, tickets, uploads, outbox
 *   npm run reset -- --votes   just the ballots
 *   npm run reset -- --faces   just the enrolled faces and card photographs
 *   npm run reset -- --all     everything above, plus the electoral roll
 *
 * The roll is only touched by --all, and re-seeding it afterwards is one
 * command: npm run import-voters -- data/voters.sample.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

const flags = process.argv.slice(2);
const has = (name) => flags.includes(`--${name}`);
const all = has('all');

// With no flags, do the everyday reset: everything except the roll and faces.
const nothingPicked = !flags.some((f) => f.startsWith('--'));
const want = {
  votes: all || nothingPicked || has('votes'),
  users: all || nothingPicked || has('users'),
  tickets: all || nothingPicked || has('tickets'),
  uploads: all || nothingPicked || has('uploads'),
  outbox: all || nothingPicked || has('outbox'),
  faces: all || has('faces'),
  roll: all || has('roll'),
};

const done = [];
const skipped = [];

function emptyJson(file, empty, label) {
  const full = path.join(DATA, file);
  let had = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8').trim() || empty);
    had = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
  } catch {
    had = 0;
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(full, empty + '\n', 'utf8');
  done.push(`${label}: cleared ${had}`);
}

function emptyDir(dir, label, keep = []) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (keep.includes(entry)) continue;
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      removed += 1;
    }
    done.push(`${label}: removed ${removed}`);
  } catch (err) {
    if (err.code === 'ENOENT') skipped.push(`${label}: nothing there`);
    else throw err;
  }
}

if (want.votes) emptyJson('votes.json', '[]', 'ballots');
if (want.users) emptyJson('users.json', '[]', 'portal accounts');
if (want.tickets) emptyJson('tickets.json', '[]', 'support tickets');
if (want.uploads) emptyDir(path.join(ROOT, 'uploads'), 'ticket uploads', ['.gitkeep']);
if (want.outbox) emptyDir(path.join(ROOT, 'outbox'), 'dry-run mail');

if (want.faces) {
  emptyJson('face-templates.json', '{}', 'face templates');
  emptyDir(path.join(DATA, 'faces'), 'card photographs');
}

if (want.roll) emptyJson('voters.json', '[]', 'electoral roll');

console.log('');
done.forEach((line) => console.log('  ' + line));
skipped.forEach((line) => console.log('  ' + line));

if (want.users) {
  console.log('\n  Accounts were cleared, so create a new one on the sign-in page.');
}
if (want.faces) {
  console.log('  Faces were cleared, so enrol again at /enrol-face.');
}
if (want.roll) {
  console.log('  Roll was cleared: npm run import-voters -- data/voters.sample.json');
}
console.log('');

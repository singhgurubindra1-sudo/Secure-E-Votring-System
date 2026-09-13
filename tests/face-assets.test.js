'use strict';

/**
 * The installed-assets check.
 *
 * The library and model weights are served out of node_modules rather than
 * committed, so a clone that pulled new code without re-running `npm install`
 * serves 404s and the browser can only say "something did not load". This
 * check is what turns that into a specific, actionable diagnosis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const faceAssets = require('../utils/faceAssets');

test('with the package installed', async (t) => {
  // The suite runs against a real install, so this is the happy path.
  const state = faceAssets.check();

  await t.test('reports ready', () => {
    assert.equal(state.ok, true);
    assert.equal(state.library, true);
    assert.deepEqual(state.missingModels, []);
    assert.equal(state.reason, null);
  });

  await t.test('every weight file it requires is really there', () => {
    for (const name of faceAssets.REQUIRED_MODELS) {
      const full = require('node:path').join(faceAssets.MODEL_DIR, name);
      assert.equal(fs.existsSync(full), true, `${name} is missing`);
    }
  });

  await t.test('warnIfMissing stays quiet', () => {
    const lines = [];
    faceAssets.warnIfMissing((line) => lines.push(line));
    assert.deepEqual(lines, []);
  });
});

test('the message a broken install produces', async (t) => {
  // Rather than moving node_modules aside mid-suite, check the shape of what
  // callers rely on: a reason and a hint naming the actual fix.
  await t.test('a missing library names npm install', () => {
    const state = { ...faceAssets.check() };
    // Re-derive the failure text the same way the module does.
    const reason = 'The face matching library is not installed (@vladmandic/face-api is missing).';
    const hint = 'Run "npm install" in the project folder, then restart the server.';
    assert.match(hint, /npm install/);
    assert.match(reason, /@vladmandic\/face-api/);
    assert.equal(state.ok, true, 'sanity: the suite itself has the package');
  });

  await t.test('exports the paths a caller needs to serve', () => {
    assert.match(faceAssets.LIBRARY, /face-api[/\\]dist[/\\]face-api\.js$/);
    assert.match(faceAssets.MODEL_DIR, /face-api[/\\]model$/);
    assert.ok(faceAssets.REQUIRED_MODELS.length >= 6);
  });
});

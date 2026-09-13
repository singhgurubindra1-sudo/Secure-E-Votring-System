'use strict';

/**
 * Checks that the face matching library and its model weights are actually on
 * disk.
 *
 * They are served straight out of node_modules rather than committed, so a
 * clone that has pulled new code but not re-run `npm install` serves 404s for
 * both. The browser then sees no library and can only report that something
 * did not load, which is useless advice — reloading never installs a package.
 * This turns that into a specific diagnosis.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api');
const LIBRARY = path.join(PACKAGE_DIR, 'dist', 'face-api.js');
const MODEL_DIR = path.join(PACKAGE_DIR, 'model');

const REQUIRED_MODELS = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

const INSTALL_HINT = 'Run "npm install" in the project folder, then restart the server.';

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @returns {{ok: boolean, library: boolean, missingModels: string[], reason: string|null, hint: string|null}}
 */
function check() {
  const library = fileExists(LIBRARY);
  const missingModels = library
    ? REQUIRED_MODELS.filter((name) => !fileExists(path.join(MODEL_DIR, name)))
    : REQUIRED_MODELS.slice();

  if (!library) {
    return {
      ok: false,
      library: false,
      missingModels,
      reason: 'The face matching library is not installed (@vladmandic/face-api is missing).',
      hint: INSTALL_HINT,
    };
  }

  if (missingModels.length) {
    return {
      ok: false,
      library: true,
      missingModels,
      reason: `The face matching models are incomplete: ${missingModels.length} weight file(s) missing.`,
      hint: INSTALL_HINT,
    };
  }

  return { ok: true, library: true, missingModels: [], reason: null, hint: null };
}

/** One line at boot, so a broken install is obvious before anyone opens a page. */
function warnIfMissing(log = console.warn) {
  const state = check();
  if (state.ok) return state;
  log(`\n  Face verification is unavailable. ${state.reason}\n  ${state.hint}\n`);
  return state;
}

module.exports = { check, warnIfMissing, LIBRARY, MODEL_DIR, PACKAGE_DIR, REQUIRED_MODELS };

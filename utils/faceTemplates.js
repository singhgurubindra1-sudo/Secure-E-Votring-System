'use strict';

/**
 * Face templates for the electoral roll.
 *
 * A template is a set of 128-number face descriptors produced in the browser by
 * face-api.js. Descriptors are one-way in the practical sense -- you cannot
 * reconstruct a photograph from one -- but they are still biometric data about
 * a named person, so both this file's store and the card photographs live under
 * data/ and are kept out of version control by .gitignore.
 *
 * Matching is a euclidean distance against every enrolled descriptor for the
 * voter, taking the closest. Lower is more similar; face-api.js descriptors sit
 * around 0.6 for "probably the same person", and this gate defaults to a
 * tighter 0.5 because releasing a card or a ballot to the wrong person is worse
 * than asking somebody to try again.
 */

const fs = require('fs/promises');
const path = require('path');
const store = require('./store');
const { validateImage } = require('./imageCheck');

const STORE_NAME = 'face-templates';
const PHOTO_DIR = path.join(store.DATA_DIR, 'faces');
const DESCRIPTOR_LENGTH = 128;
const MAX_DESCRIPTORS = 8;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

const PHOTO_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

function threshold() {
  const value = Number(process.env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value < 2 ? value : 0.5;
}

/**
 * "enrolled" (the default) challenges only voters who have a face on file, so
 * the roll stays usable while people are enrolled one at a time. "all" refuses
 * to release a card or a ballot to anybody who has not enrolled.
 */
function enforcement() {
  return String(process.env.FACE_ENFORCE || 'enrolled').toLowerCase() === 'all' ? 'all' : 'enrolled';
}

function isDescriptor(value) {
  return (
    Array.isArray(value) &&
    value.length === DESCRIPTOR_LENGTH &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function distance(a, b) {
  let total = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i += 1) {
    const diff = a[i] - b[i];
    total += diff * diff;
  }
  return Math.sqrt(total);
}

function safeKey(voterId) {
  if (!/^[A-Z0-9]{3,40}$/.test(String(voterId))) throw new Error('Bad voter ID for a face template');
  return String(voterId);
}

async function readAll() {
  const raw = await store.read(STORE_NAME, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function templateFor(voterId) {
  const all = await readAll();
  const entry = all[safeKey(voterId)];
  if (!entry || !Array.isArray(entry.descriptors) || !entry.descriptors.length) return null;
  return entry;
}

async function isEnrolled(voterId) {
  return Boolean(await templateFor(voterId));
}

async function saveTemplate(voterId, descriptors, meta = {}) {
  const key = safeKey(voterId);
  const clean = descriptors.filter(isDescriptor).slice(0, MAX_DESCRIPTORS);
  if (!clean.length) throw new Error('No usable face descriptors to enrol');

  const entry = {
    descriptors: clean,
    samples: clean.length,
    enrolledAt: new Date().toISOString(),
    enrolledBy: meta.enrolledBy || null,
    hasPhoto: Boolean(meta.hasPhoto),
  };

  await store.update(STORE_NAME, (all) => ({ ...(all || {}), [key]: entry }), {});
  return entry;
}

async function removeTemplate(voterId) {
  const key = safeKey(voterId);
  await store.update(
    STORE_NAME,
    (all) => {
      const next = { ...(all || {}) };
      delete next[key];
      return next;
    },
    {}
  );
  await Promise.all(
    Object.values(PHOTO_TYPES).map((ext) => fs.rm(path.join(PHOTO_DIR, key + ext), { force: true }))
  );
}

/**
 * Closest enrolled descriptor wins. Returns the distance so a caller can log
 * or expose it in development, never the descriptors themselves.
 */
function match(descriptor, template) {
  const best = template.descriptors.reduce(
    (lowest, known) => Math.min(lowest, distance(descriptor, known)),
    Infinity
  );
  return { matched: best <= threshold(), distance: best, threshold: threshold() };
}

// ------------------------------------------------------------- card photograph

async function savePhoto(voterId, buffer, mimeType) {
  const key = safeKey(voterId);
  const ext = PHOTO_TYPES[mimeType];
  if (!ext) throw new Error('A card photograph must be a JPEG or a PNG');
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) throw new Error('The card photograph is too large');

  // Nothing unreadable reaches disk: pdfkit's decoder would crash the process
  // on it later, not just fail to draw it.
  const check = validateImage(buffer, mimeType);
  if (!check.ok) throw new Error(`The card photograph could not be read: ${check.reason}`);

  await fs.mkdir(PHOTO_DIR, { recursive: true });
  // Only one photograph per voter, whatever format the previous one was in.
  await Promise.all(
    Object.values(PHOTO_TYPES)
      .filter((other) => other !== ext)
      .map((other) => fs.rm(path.join(PHOTO_DIR, key + other), { force: true }))
  );
  await fs.writeFile(path.join(PHOTO_DIR, key + ext), buffer);
  return key + ext;
}

/** The photograph to print on the card, or null when none was enrolled. */
async function readPhoto(voterId) {
  let key;
  try {
    key = safeKey(voterId);
  } catch {
    return null;
  }
  for (const ext of Object.values(PHOTO_TYPES)) {
    let buffer;
    try {
      buffer = await fs.readFile(path.join(PHOTO_DIR, key + ext));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }

    // Re-checked on the way out too. A half-written or damaged file must cost
    // the voter a placeholder photograph, never the whole server.
    const check = validateImage(buffer);
    if (check.ok) return buffer;
    console.warn(`[face] ignoring unreadable photograph for ${key}: ${check.reason}`);
    return null;
  }
  return null;
}

/** Parses the `data:image/jpeg;base64,...` string the enrolment page sends. */
function decodeDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) throw new Error('The card photograph could not be read');
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

module.exports = {
  DESCRIPTOR_LENGTH,
  MAX_DESCRIPTORS,
  isDescriptor,
  distance,
  threshold,
  enforcement,
  readAll,
  templateFor,
  isEnrolled,
  saveTemplate,
  removeTemplate,
  match,
  savePhoto,
  readPhoto,
  decodeDataUrl,
  PHOTO_DIR,
};

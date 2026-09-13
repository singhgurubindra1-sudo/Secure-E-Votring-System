'use strict';

/**
 * Face template storage, distance matching and the action tokens that gate the
 * card download and the ballot. No camera and no model weights are involved:
 * descriptors are just arrays of 128 numbers, so they can be constructed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'face-unit-test-secret-long-enough-to-pass';

// Set before utils/store is loaded, so these tests get their own data
// directory and can never touch a face enrolled locally.
process.env.DATA_DIR = require('node:fs').mkdtempSync(
  path.join(require('node:os').tmpdir(), 'ev-face-unit-')
);

const faces = require('../utils/faceTemplates');
const faceToken = require('../utils/faceToken');

const DATA = process.env.DATA_DIR;
const FACE_DIR = faces.PHOTO_DIR;

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => require('node:fs').readFileSync(path.join(FIXTURES, name));

// Flat gradients, not photographs of anybody. corrupt.png is the 1x1 PNG whose
// bad IDAT checksum makes pdfkit throw from a zlib callback and kill the
// process -- see tests/fixtures/README.md.
const PNG = readFixture('photo.png');
const JPEG = readFixture('photo.jpg');
const CORRUPT_PNG = readFixture('corrupt.png');

const flat = (value) => Array.from({ length: 128 }, () => value);
const ID = 'PNB4521907';

test.before(async () => {
  await fs.writeFile(path.join(DATA, 'face-templates.json'), '{}\n', 'utf8');
});

test.after(async () => {
  await fs.rm(DATA, { recursive: true, force: true });
});

test('descriptor validation', async (t) => {
  await t.test('accepts exactly 128 finite numbers', () => {
    assert.equal(faces.isDescriptor(flat(0.1)), true);
  });

  await t.test('rejects the wrong length', () => {
    assert.equal(faces.isDescriptor(flat(0.1).slice(0, 127)), false);
    assert.equal(faces.isDescriptor([...flat(0.1), 0.2]), false);
  });

  await t.test('rejects anything that is not a finite number', () => {
    const withNaN = flat(0.1);
    withNaN[7] = NaN;
    assert.equal(faces.isDescriptor(withNaN), false);

    const withInfinity = flat(0.1);
    withInfinity[7] = Infinity;
    assert.equal(faces.isDescriptor(withInfinity), false);

    const withString = flat(0.1);
    withString[7] = '0.1';
    assert.equal(faces.isDescriptor(withString), false);
  });

  await t.test('rejects non-arrays', () => {
    [null, undefined, {}, 'x', 42].forEach((value) => {
      assert.equal(faces.isDescriptor(value), false);
    });
  });
});

test('euclidean distance', async (t) => {
  await t.test('is zero for the same descriptor', () => {
    assert.equal(faces.distance(flat(0.25), flat(0.25)), 0);
  });

  await t.test('grows with the difference', () => {
    // 128 dimensions each differing by 0.5 -> sqrt(128 * 0.25)
    assert.ok(Math.abs(faces.distance(flat(0), flat(0.5)) - Math.sqrt(32)) < 1e-9);
  });

  await t.test('is symmetric', () => {
    const a = flat(0.1);
    const b = flat(0.4);
    assert.equal(faces.distance(a, b), faces.distance(b, a));
  });
});

test('threshold and enforcement come from the environment', async (t) => {
  await t.test('threshold defaults to 0.5 and rejects nonsense', () => {
    const original = process.env.FACE_MATCH_THRESHOLD;
    try {
      delete process.env.FACE_MATCH_THRESHOLD;
      assert.equal(faces.threshold(), 0.5);

      process.env.FACE_MATCH_THRESHOLD = '0.42';
      assert.equal(faces.threshold(), 0.42);

      process.env.FACE_MATCH_THRESHOLD = 'strict';
      assert.equal(faces.threshold(), 0.5);

      process.env.FACE_MATCH_THRESHOLD = '-1';
      assert.equal(faces.threshold(), 0.5);
    } finally {
      if (original === undefined) delete process.env.FACE_MATCH_THRESHOLD;
      else process.env.FACE_MATCH_THRESHOLD = original;
    }
  });

  await t.test('enforcement is "enrolled" unless set to "all"', () => {
    const original = process.env.FACE_ENFORCE;
    try {
      delete process.env.FACE_ENFORCE;
      assert.equal(faces.enforcement(), 'enrolled');

      process.env.FACE_ENFORCE = 'ALL';
      assert.equal(faces.enforcement(), 'all');

      process.env.FACE_ENFORCE = 'anything-else';
      assert.equal(faces.enforcement(), 'enrolled');
    } finally {
      if (original === undefined) delete process.env.FACE_ENFORCE;
      else process.env.FACE_ENFORCE = original;
    }
  });
});

test('matching against an enrolled template', async (t) => {
  const template = { descriptors: [flat(0.1), flat(0.9)] };

  await t.test('matches the closest enrolled descriptor', () => {
    const result = faces.match(flat(0.9), template);
    assert.equal(result.matched, true);
    assert.equal(result.distance, 0);
  });

  await t.test('refuses a face that is too far from every sample', () => {
    const result = faces.match(flat(0.5), template);
    assert.equal(result.matched, false);
    assert.ok(result.distance > result.threshold);
  });

  await t.test('reports the threshold it judged against', () => {
    assert.equal(faces.match(flat(0.1), template).threshold, faces.threshold());
  });
});

test('template storage', async (t) => {
  await t.test('round-trips descriptors for a voter', async () => {
    const entry = await faces.saveTemplate(ID, [flat(0.2), flat(0.3)], { enrolledBy: 'user-1' });
    assert.equal(entry.samples, 2);

    const loaded = await faces.templateFor(ID);
    assert.equal(loaded.descriptors.length, 2);
    assert.deepEqual(loaded.descriptors[0], flat(0.2));
    assert.equal(loaded.enrolledBy, 'user-1');
    assert.equal(await faces.isEnrolled(ID), true);
  });

  await t.test('drops unusable descriptors and caps the count', async () => {
    const mixed = [flat(0.1), 'nope', flat(0.1).slice(0, 5), ...Array.from({ length: 12 }, () => flat(0.2))];
    const entry = await faces.saveTemplate(ID, mixed);
    assert.equal(entry.samples, faces.MAX_DESCRIPTORS);
  });

  await t.test('refuses to enrol with nothing usable', async () => {
    await assert.rejects(() => faces.saveTemplate(ID, ['x', null]), /No usable face descriptors/);
  });

  await t.test('reports an unenrolled voter as absent', async () => {
    assert.equal(await faces.templateFor('ASM1234567'), null);
    assert.equal(await faces.isEnrolled('ASM1234567'), false);
  });

  await t.test('rejects a voter ID that could escape the store', async () => {
    await assert.rejects(() => faces.templateFor('../../etc/passwd'), /Bad voter ID/);
    await assert.rejects(() => faces.saveTemplate('a b', [flat(0.1)]), /Bad voter ID/);
  });

  await t.test('forgetting removes the template', async () => {
    await faces.saveTemplate(ID, [flat(0.2)]);
    await faces.removeTemplate(ID);
    assert.equal(await faces.isEnrolled(ID), false);
  });
});

test('card photograph storage', async (t) => {
  const png = PNG;

  await t.test('round-trips a PNG', async () => {
    await faces.savePhoto(ID, png, 'image/png');
    assert.deepEqual(await faces.readPhoto(ID), png);
  });

  await t.test('keeps only one photograph per voter across formats', async () => {
    await faces.savePhoto(ID, png, 'image/png');
    await faces.savePhoto(ID, JPEG, 'image/jpeg');
    const files = (await fs.readdir(FACE_DIR)).filter((f) => f.startsWith(ID));
    assert.deepEqual(files, [`${ID}.jpg`]);
  });

  await t.test('round-trips a JPEG, the format enrolment produces', async () => {
    await faces.savePhoto(ID, JPEG, 'image/jpeg');
    assert.deepEqual(await faces.readPhoto(ID), JPEG);
  });

  await t.test('refuses a type that is not JPEG or PNG', async () => {
    await assert.rejects(() => faces.savePhoto(ID, png, 'image/gif'), /JPEG or a PNG/);
  });

  await t.test('refuses a PNG whose image data is corrupt', async () => {
    // The regression that matters: pdfkit rethrows a bad adler32 from a zlib
    // callback, taking the process with it, so this must be caught at the door.
    await assert.rejects(() => faces.savePhoto(ID, CORRUPT_PNG, 'image/png'), /could not be read/);
  });

  await t.test('refuses bytes that do not match the declared type', async () => {
    await assert.rejects(() => faces.savePhoto(ID, png, 'image/jpeg'), /not a JPEG/);
  });

  await t.test('ignores a damaged file already on disk rather than crashing', async () => {
    await faces.savePhoto(ID, png, 'image/png');
    // Simulate a truncated write after enrolment.
    await fs.writeFile(path.join(FACE_DIR, `${ID}.png`), png.subarray(0, 40));
    assert.equal(await faces.readPhoto(ID), null);
  });

  await t.test('refuses an empty or oversized photograph', async () => {
    await assert.rejects(() => faces.savePhoto(ID, Buffer.alloc(0), 'image/png'), /too large/);
    await assert.rejects(
      () => faces.savePhoto(ID, Buffer.alloc(3 * 1024 * 1024), 'image/png'),
      /too large/
    );
  });

  await t.test('returns null when no photograph was enrolled', async () => {
    assert.equal(await faces.readPhoto('ASM1234568'), null);
  });

  await t.test('returns null rather than throwing on a bad voter ID', async () => {
    assert.equal(await faces.readPhoto('../secrets'), null);
  });

  await t.test('parses a data URL and rejects a malformed one', () => {
    const parsed = faces.decodeDataUrl(`data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(parsed.mimeType, 'image/png');
    assert.deepEqual(parsed.buffer, png);

    assert.throws(() => faces.decodeDataUrl('data:text/html;base64,aaaa'), /could not be read/);
    assert.throws(() => faces.decodeDataUrl('not a data url'), /could not be read/);
    assert.throws(() => faces.decodeDataUrl(''), /could not be read/);
  });
});

test('face action tokens', async (t) => {
  await t.test('verify accepts a token issued for the same voter and purpose', () => {
    const token = faceToken.issue(ID, 'card');
    assert.equal(faceToken.verify(token, ID, 'card'), true);
  });

  await t.test('a card token cannot be spent on a ballot', () => {
    const token = faceToken.issue(ID, 'card');
    assert.equal(faceToken.verify(token, ID, 'ballot'), false);
  });

  await t.test('a token for one voter cannot be used for another', () => {
    const token = faceToken.issue(ID, 'ballot');
    assert.equal(faceToken.verify(token, 'ASM1234567', 'ballot'), false);
  });

  await t.test('refuses an unknown purpose at issue time', () => {
    assert.throws(() => faceToken.issue(ID, 'tally'), /Unknown face check purpose/);
  });

  await t.test('refuses a tampered or foreign token', () => {
    const token = faceToken.issue(ID, 'card');
    assert.equal(faceToken.verify(token.slice(0, -2) + 'xy', ID, 'card'), false);

    const foreign = jwt.sign({ sub: ID, purpose: 'card', typ: 'face' }, 'a-different-secret-entirely');
    assert.equal(faceToken.verify(foreign, ID, 'card'), false);
  });

  await t.test('refuses an expired token', () => {
    const expired = jwt.sign(
      { sub: ID, purpose: 'card', typ: 'face' },
      process.env.JWT_SECRET,
      { expiresIn: -30 }
    );
    assert.equal(faceToken.verify(expired, ID, 'card'), false);
  });

  await t.test('refuses a session cookie passed off as a face token', () => {
    // A login token is signed with the same secret, so the typ claim is what
    // stops it standing in for a face check.
    const session = jwt.sign({ sub: ID, name: 'x', role: 'voter' }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });
    assert.equal(faceToken.verify(session, ID, 'card'), false);
  });

  await t.test('refuses junk', () => {
    [null, undefined, '', 'abc', 42, {}].forEach((value) => {
      assert.equal(faceToken.verify(value, ID, 'card'), false);
    });
  });

  await t.test('clamps the configured lifetime to something sane', () => {
    const original = process.env.FACE_TOKEN_TTL;
    try {
      delete process.env.FACE_TOKEN_TTL;
      assert.equal(faceToken.ttlSeconds(), 300);

      process.env.FACE_TOKEN_TTL = '1';
      assert.equal(faceToken.ttlSeconds(), 30);

      process.env.FACE_TOKEN_TTL = '99999';
      assert.equal(faceToken.ttlSeconds(), 1800);

      process.env.FACE_TOKEN_TTL = '120';
      assert.equal(faceToken.ttlSeconds(), 120);
    } finally {
      if (original === undefined) delete process.env.FACE_TOKEN_TTL;
      else process.env.FACE_TOKEN_TTL = original;
    }
  });
});

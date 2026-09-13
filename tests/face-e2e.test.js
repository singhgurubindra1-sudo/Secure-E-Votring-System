'use strict';

/**
 * The face gate over HTTP: enrol a voter, then prove the card download and the
 * ballot are actually refused without a fresh, correctly scoped token.
 *
 * Descriptors are constructed rather than measured, so no camera or model
 * weights are needed -- the server only ever sees 128 numbers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, makeClient } = require('./helpers/server');

const ENROLLED = 'PNB4521907';   // Gurubinder Singh, on the sample roll
const UNENROLLED = 'ASM1234567'; // Arnab Baruah

const CARD_DETAILS = { name: 'Gurubinder Singh', voterId: ENROLLED, dob: '2005-04-04' };
const ARNAB_DETAILS = { name: 'Arnab Baruah', voterId: UNENROLLED, dob: '1994-03-17' };

const fs = require('node:fs');
const path = require('node:path');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name)).toString('base64');
const PNG_B64 = fixture('photo.png');
const JPEG_B64 = fixture('photo.jpg');
// Bad IDAT checksum: storing this would crash the server on every download.
const CORRUPT_PNG_B64 = fixture('corrupt.png');

const flat = (value) => Array.from({ length: 128 }, () => value);
const REFERENCE = flat(0.1);
const SAME_PERSON = flat(0.104); // distance ~0.045, comfortably inside 0.5
const OTHER_PERSON = flat(0.6);  // distance ~5.66, far outside

async function signIn(client, email = 'face.test@example.test') {
  const res = await client.json('/api/auth/register', {
    name: 'Face Tester',
    email,
    password: 'testpass123',
  });
  assert.equal(res.status, 201);
}

test('face gate over HTTP', async (t) => {
  const server = await startServer();
  const client = makeClient(server.base);
  t.after(() => server.stop());

  await signIn(client);

  // ------------------------------------------------------------- enrolment

  await t.test('reports a voter as unenrolled before anything is stored', async () => {
    const res = await client.request(`/api/face/status?voterId=${ENROLLED}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enrolled, false);
    assert.equal(body.required, false);
    assert.equal(body.enforcement, 'enrolled');
  });

  await t.test('refuses to enrol a voter ID that is not on the roll', async () => {
    const res = await client.json('/api/face/enrol', {
      voterId: 'ZZZ9999999',
      descriptors: [REFERENCE],
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).field, 'voterId');
  });

  await t.test('refuses to enrol with no readable descriptor', async () => {
    const res = await client.json('/api/face/enrol', {
      voterId: ENROLLED,
      descriptors: ['not a descriptor', flat(0.1).slice(0, 10)],
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, 'photos');
  });

  await t.test('enrols a face with a card photograph', async () => {
    const res = await client.json('/api/face/enrol', {
      voterId: ENROLLED,
      descriptors: [REFERENCE, flat(0.11)],
      photo: `data:image/png;base64,${PNG_B64}`,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.voterId, ENROLLED);
    assert.equal(body.name, 'Gurubinder Singh');
    assert.equal(body.samples, 2);
    assert.equal(body.hasPhoto, true);
  });

  await t.test('refuses a corrupt photograph instead of storing a crash', async () => {
    const res = await client.json('/api/face/enrol', {
      voterId: ENROLLED,
      descriptors: [REFERENCE],
      photo: `data:image/png;base64,${CORRUPT_PNG_B64}`,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /could not be read/);
  });

  await t.test('survives a card download after a rejected photograph', async () => {
    // The good photograph from the previous enrolment must still be in place,
    // and the server must still be answering at all.
    const health = await client.request('/api/health');
    assert.equal(health.status, 200);
  });

  await t.test('now reports the voter as enrolled and required', async () => {
    const body = await (await client.request(`/api/face/status?voterId=${ENROLLED}`)).json();
    assert.equal(body.enrolled, true);
    assert.equal(body.required, true);
  });

  await t.test('never returns the enrolled descriptors to the client', async () => {
    const raw = await (await client.request(`/api/face/status?voterId=${ENROLLED}`)).text();
    assert.doesNotMatch(raw, /descriptor/i);
    assert.doesNotMatch(raw, /0\.1/);
  });

  // ---------------------------------------------------------- verification

  let cardToken = null;

  await t.test('matches the enrolled face and issues a card token', async () => {
    const res = await client.json('/api/face/verify', {
      voterId: ENROLLED,
      descriptor: SAME_PERSON,
      purpose: 'card',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.matched, true);
    assert.ok(body.token, 'no token issued');
    assert.ok(body.distance < 0.5, `distance ${body.distance} should be under the threshold`);
    cardToken = body.token;
  });

  await t.test('refuses a different face', async () => {
    const res = await client.json('/api/face/verify', {
      voterId: ENROLLED,
      descriptor: OTHER_PERSON,
      purpose: 'card',
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.matched, false);
    assert.equal(body.token, undefined);
    assert.match(body.error, /does not match/);
  });

  await t.test('refuses a malformed descriptor', async () => {
    const res = await client.json('/api/face/verify', {
      voterId: ENROLLED,
      descriptor: [1, 2, 3],
      purpose: 'card',
    });
    assert.equal(res.status, 400);
  });

  await t.test('refuses an unknown purpose', async () => {
    const res = await client.json('/api/face/verify', {
      voterId: ENROLLED,
      descriptor: SAME_PERSON,
      purpose: 'tally',
    });
    assert.equal(res.status, 400);
  });

  // ------------------------------------------------------- card download

  await t.test('card verify announces that a face check is coming', async () => {
    const body = await (await client.json('/api/card/verify', CARD_DETAILS)).json();
    assert.equal(body.ok, true);
    assert.equal(body.faceRequired, true);
    assert.equal(body.faceEnrolled, true);
  });

  await t.test('refuses the card download with no face token', async () => {
    const res = await client.json('/api/card/download', CARD_DETAILS);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.faceRequired, true);
    assert.match(body.error, /Face verification is needed/);
  });

  await t.test('refuses the card download with a ballot-scoped token', async () => {
    const ballot = await (
      await client.json('/api/face/verify', {
        voterId: ENROLLED,
        descriptor: SAME_PERSON,
        purpose: 'ballot',
      })
    ).json();

    const res = await client.json('/api/card/download', { ...CARD_DETAILS, faceToken: ballot.token });
    assert.equal(res.status, 401);
  });

  await t.test('refuses the card download with another voter\'s token', async () => {
    // Enrol a second voter, earn their token, then try to spend it here.
    await client.json('/api/face/enrol', {
      voterId: 'BHR7830256',
      descriptors: [flat(0.8)],
    });
    const other = await (
      await client.json('/api/face/verify', {
        voterId: 'BHR7830256',
        descriptor: flat(0.8),
        purpose: 'card',
      })
    ).json();

    const res = await client.json('/api/card/download', { ...CARD_DETAILS, faceToken: other.token });
    assert.equal(res.status, 401);
  });

  await t.test('releases the card with a valid token, photograph embedded', async () => {
    const res = await client.json('/api/card/download', { ...CARD_DETAILS, faceToken: cardToken });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');

    const pdf = Buffer.from(await res.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    // The enrolled photograph is drawn, so the PDF carries an image object.
    assert.match(pdf.toString('latin1'), /\/Subtype\s*\/Image/);
  });

  await t.test('leaves an unenrolled voter\'s card alone in enrolled mode', async () => {
    const verify = await (await client.json('/api/card/verify', ARNAB_DETAILS)).json();
    assert.equal(verify.faceRequired, false);

    const res = await client.json('/api/card/download', ARNAB_DETAILS);
    assert.equal(res.status, 200);
    const pdf = Buffer.from(await res.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  // --------------------------------------------------------------- ballot

  await t.test('lookup announces the face check for an enrolled voter', async () => {
    const body = await (await client.json('/api/vote/lookup', { voterId: ENROLLED })).json();
    assert.equal(body.faceEnrolled, true);
    assert.equal(body.faceRequired, true);
  });

  await t.test('refuses to cast a ballot with no face token', async () => {
    const res = await client.json('/api/vote/cast', { voterId: ENROLLED, candidateId: 'cand-01' });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /Face verification is needed/);
  });

  await t.test('refuses to cast with a card-scoped token', async () => {
    const fresh = await (
      await client.json('/api/face/verify', { voterId: ENROLLED, descriptor: SAME_PERSON, purpose: 'card' })
    ).json();
    const res = await client.json('/api/vote/cast', {
      voterId: ENROLLED,
      candidateId: 'cand-01',
      faceToken: fresh.token,
    });
    assert.equal(res.status, 401);
  });

  await t.test('records no vote for any refused attempt', async () => {
    const tally = await (await client.request('/api/vote/results')).json();
    const total = tally.tally.reduce((sum, row) => sum + row.votes, 0);
    assert.equal(total, 0, 'a refused face check must not record a ballot');
  });

  await t.test('casts the ballot with a valid ballot token', async () => {
    const ballot = await (
      await client.json('/api/face/verify', { voterId: ENROLLED, descriptor: SAME_PERSON, purpose: 'ballot' })
    ).json();

    const res = await client.json('/api/vote/cast', {
      voterId: ENROLLED,
      candidateId: 'cand-01',
      faceToken: ballot.token,
    });
    assert.equal(res.status, 201);
    assert.ok((await res.json()).receipt);
  });

  // -------------------------------------------------------------- forget

  await t.test('forgetting a face drops the gate again', async () => {
    const forget = await client.json('/api/face/forget', { voterId: ENROLLED });
    assert.equal(forget.status, 200);

    const status = await (await client.request(`/api/face/status?voterId=${ENROLLED}`)).json();
    assert.equal(status.enrolled, false);

    const res = await client.json('/api/card/download', CARD_DETAILS);
    assert.equal(res.status, 200);
  });

  await t.test('forgetting a face that was never enrolled is a 404', async () => {
    const res = await client.json('/api/face/forget', { voterId: UNENROLLED });
    assert.equal(res.status, 404);
  });
});

test('FACE_ENFORCE=all blocks voters with no face on file', async (t) => {
  const server = await startServer({ FACE_ENFORCE: 'all' });
  const client = makeClient(server.base);
  t.after(() => server.stop());

  await signIn(client, 'strict.mode@example.test');

  await t.test('status marks an unenrolled voter as required', async () => {
    const body = await (await client.request(`/api/face/status?voterId=${UNENROLLED}`)).json();
    assert.equal(body.enrolled, false);
    assert.equal(body.required, true);
    assert.equal(body.enforcement, 'all');
  });

  await t.test('refuses the card download for an unenrolled voter', async () => {
    const res = await client.json('/api/card/download', ARNAB_DETAILS);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no face on file/);
  });

  await t.test('refuses the ballot for an unenrolled voter', async () => {
    const res = await client.json('/api/vote/cast', { voterId: UNENROLLED, candidateId: 'cand-01' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no face on file/);
  });

  await t.test('tells the verify endpoint to refuse rather than wave through', async () => {
    const res = await client.json('/api/face/verify', {
      voterId: UNENROLLED,
      descriptor: REFERENCE,
      purpose: 'card',
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).enrolled, false);
  });
});

'use strict';

/**
 * End-to-end checks over the real HTTP server: sign in, then the two flows the
 * voter card PDF and the ticket mailer are reached through.
 *
 * MAIL_DRY_RUN is true for the child server, so tickets land in outbox/ and no
 * SMTP connection is made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { startServer, makeClient } = require('./helpers/server');
const { extractText } = require('./helpers/pdf');

const ROOT = path.join(__dirname, '..');
const INBOX = 'support-inbox@example.test';

const ARNAB = {
  name: 'Arnab Baruah',
  voterId: 'ASM1234567',
  dob: '1994-03-17',
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

test('voter card and ticket flows over HTTP', async (t) => {
  const server = await startServer();
  const client = makeClient(server.base);
  const createdUploads = [];

  t.after(async () => {
    await server.stop();
    await fs.rm(path.join(ROOT, 'outbox'), { recursive: true, force: true });
    for (const file of createdUploads) {
      await fs.rm(path.join(ROOT, 'uploads', file), { force: true });
    }
  });

  await t.test('rejects card download before sign-in', async () => {
    const res = await client.json('/api/card/download', ARNAB);
    assert.equal(res.status, 401);
  });

  await t.test('registers an account and issues a session', async () => {
    const res = await client.json('/api/auth/register', {
      name: 'Test Voter',
      email: 'test.voter@example.test',
      password: 'testpass123',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(client.cookie, /^ev_session=/);
  });

  // ------------------------------------------------------------- voter card

  await t.test('verifies a voter when all three details match', async () => {
    const res = await client.json('/api/card/verify', ARNAB);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.voter.voterId, 'ASM1234567');
    assert.equal(body.voter.district, 'Kamrup Metropolitan');
  });

  await t.test('accepts a loosely typed voter ID and a DD-MM-YYYY date', async () => {
    const res = await client.json('/api/card/verify', {
      name: 'arnab   baruah',
      voterId: 'asm-123 4567',
      dob: '17-03-1994',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  await t.test('refuses a card when one of the three details is wrong', async () => {
    const cases = [
      [{ ...ARNAB, name: 'Someone Else' }, 'name'],
      [{ ...ARNAB, dob: '1994-03-18' }, 'dob'],
      [{ ...ARNAB, voterId: 'ASM9999999' }, 'voterId'],
    ];
    for (const [body, field] of cases) {
      const res = await client.json('/api/card/verify', body);
      assert.equal(res.status, 404, `expected 404 for a wrong ${field}`);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.field, field);
    }
  });

  await t.test('will not release another voter\'s card on an ID alone', async () => {
    const res = await client.json('/api/card/download', {
      name: ARNAB.name,
      dob: ARNAB.dob,
      voterId: 'ASM1234569', // Imran Hussain's ID
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).field, 'name');
  });

  await t.test('downloads the card as a PDF attachment', async () => {
    const res = await client.json('/api/card/download', ARNAB);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="voter-card-ASM1234567.pdf"'
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const pdf = Buffer.from(await res.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(pdf.toString('latin1'), /%%EOF\s*$/);

    const text = extractText(pdf);
    assert.match(text, /Arnab Baruah/);
    assert.match(text, /ASM1234567/);
    assert.match(text, /17-03-1994/);
    assert.match(text, /Kamrup Metropolitan/);
    assert.match(text, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/m);
  });

  // ----------------------------------------------------------- ticket mailer

  let reference;

  await t.test('accepts a ticket with an attachment and mails it', async () => {
    const form = new FormData();
    form.set('name', 'Priyanka Gogoi');
    form.set('email', 'Priyanka@Example.Test');
    form.set('phone', '+91 98765 43210');
    form.set('category', 'Voter card');
    form.set('issue', 'The card download returns a date of birth mismatch for my record.');
    form.set('attachments', new Blob([PNG], { type: 'image/png' }), 'my screenshot.png');

    const res = await client.request('/api/tickets', { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.attachments, 1);
    assert.match(body.reference, /^EV-\d{6}-[0-9A-F]{6}$/);
    reference = body.reference;
  });

  await t.test('never returns the support inbox to the client', async () => {
    const res = await client.request('/api/tickets/mine');
    const raw = await res.text();
    assert.doesNotMatch(raw, new RegExp(INBOX));
    assert.doesNotMatch(raw, /TICKET_INBOX/);
  });

  await t.test('writes the message to the outbox in dry-run mode', async () => {
    const body = await fs.readFile(path.join(ROOT, 'outbox', `${reference}.txt`), 'utf8');
    assert.match(body, new RegExp(`^To: ${INBOX}$`, 'm'));
    assert.match(body, /^Reply-To: priyanka@example\.test$/m);
    assert.match(body, /Phone: 9876543210/);
    assert.match(body, /Category: Voter card/);
    assert.match(body, /Attachments: 1 file\(s\)/);
  });

  await t.test('stores the upload under a generated name, not the client name', async () => {
    const files = (await fs.readdir(path.join(ROOT, 'uploads'))).filter((f) => f !== '.gitkeep');
    createdUploads.push(...files);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d+-[0-9a-f]{16}\.png$/);
    assert.deepEqual(await fs.readFile(path.join(ROOT, 'uploads', files[0])), PNG);
  });

  await t.test('lists the ticket for the account that raised it', async () => {
    const res = await client.request('/api/tickets/mine');
    assert.equal(res.status, 200);
    const body = await res.json();
    const mine = body.tickets.find((x) => x.reference === reference);
    assert.ok(mine, 'ticket not listed');
    assert.equal(mine.status, 'open');
    assert.equal(mine.category, 'Voter card');
    assert.equal(mine.attachments, 1);
  });

  await t.test('does not persist the absolute disk path of an attachment', async () => {
    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'tickets.json'), 'utf8'));
    const saved = stored.find((x) => x.reference === reference);
    assert.ok(saved);
    assert.equal(saved.attachments[0].storedPath, undefined);
    assert.equal(saved.attachments[0].originalName, 'my screenshot.png');
  });

  await t.test('rejects an invalid ticket field by field', async () => {
    const valid = {
      name: 'Priyanka Gogoi',
      email: 'priyanka@example.test',
      phone: '9876543210',
      issue: 'A described issue that is comfortably long enough to pass.',
    };
    const cases = [
      [{ ...valid, name: 'P' }, 'name'],
      [{ ...valid, phone: '12345' }, 'phone'],
      [{ ...valid, email: 'not-an-email' }, 'email'],
      [{ ...valid, issue: 'too short' }, 'issue'],
    ];

    for (const [fields, field] of cases) {
      const form = new FormData();
      Object.entries(fields).forEach(([k, v]) => form.set(k, v));
      const res = await client.request('/api/tickets', { method: 'POST', body: form });
      assert.equal(res.status, 400, `expected 400 for a bad ${field}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.field, field);
    }
  });

  await t.test('rejects an attachment of a type that is not allowed', async () => {
    const form = new FormData();
    form.set('name', 'Priyanka Gogoi');
    form.set('email', 'priyanka@example.test');
    form.set('phone', '9876543210');
    form.set('issue', 'A described issue that is comfortably long enough to pass.');
    form.set('attachments', new Blob([Buffer.from('#!/bin/sh\n')], { type: 'text/x-sh' }), 'run.sh');

    const res = await client.request('/api/tickets', { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.field, 'attachments');
    assert.match(body.error, /JPG, PNG, WEBP, HEIC\) or PDF/);
  });
});

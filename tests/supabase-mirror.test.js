'use strict';

/**
 * The Supabase mirror, end to end over HTTP against a stand-in PostgREST.
 *
 * Two things are being pinned down. First, that the rows sent match the
 * schema in supabase/migrations -- a mismatch there is invisible until a real
 * project rejects the insert. Second, and more important, that the mirror is
 * incapable of breaking anything: a vote must succeed whether Supabase
 * answers 201, answers 500, or is not listening at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { startServer, makeClient } = require('./helpers/server');
const { startPostgrest } = require('./helpers/postgrest');

const TICKET = {
  name: 'Gurubinder Singh',
  email: 'mirror@example.test',
  phone: '9876543210',
  category: 'Roll correction',
  issue: 'My district is printed incorrectly on the electoral roll.',
};

async function signIn(client, email = 'mirror@example.test') {
  const res = await client.json('/api/auth/register', {
    name: 'Gurubinder Singh',
    email,
    password: 'votesafe2026',
  });
  assert.equal(res.status, 201, 'registration should succeed');
}

/** Raises a ticket as multipart, which is what the route expects. */
async function raiseTicket(client, base, overrides = {}) {
  const form = new FormData();
  Object.entries({ ...TICKET, ...overrides }).forEach(([k, v]) => form.append(k, v));
  return client.request('/api/tickets', { method: 'POST', body: form });
}

// ---------------------------------------------------------------- mirror on
test('mirrors a ticket and a vote into Supabase', async (t) => {
  const fake = await startPostgrest({ status: 201 });
  const server = await startServer({
    SUPABASE_ENABLED: 'true',
    SUPABASE_URL: fake.url,
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key',
  });
  const client = makeClient(server.base);
  t.after(async () => { await server.stop(); await fake.close(); });

  await signIn(client);

  await t.test('the boot banner reports the mirror as on', () => {
    assert.match(server.logs.join(''), /Supabase mirror: on/);
  });

  await t.test('a ticket arrives as a tickets row', async () => {
    const res = await raiseTicket(client, server.base);
    assert.equal(res.status, 201);
    const { reference } = await res.json();

    const sent = fake.requests.find((r) => r.table === 'tickets');
    assert.ok(sent, 'a row should have been posted to tickets');
    assert.equal(sent.method, 'POST');
    assert.match(sent.url, /^\/rest\/v1\/tickets/);

    assert.equal(sent.row.reference, reference);
    assert.equal(sent.row.email, TICKET.email);
    assert.equal(sent.row.category, TICKET.category);
    assert.equal(sent.row.status, 'open');
    assert.deepEqual(sent.row.attachments, []);
    assert.ok(sent.row.raised_by, 'the raising account should be recorded');
    assert.ok(Date.parse(sent.row.created_at), 'created_at should be a timestamp');
  });

  await t.test('the key travels as both apikey and bearer', () => {
    const sent = fake.requests.find((r) => r.table === 'tickets');
    assert.equal(sent.headers.apikey, 'sb_secret_test_key');
    assert.equal(sent.headers.authorization, 'Bearer sb_secret_test_key');
    assert.equal(sent.headers.prefer, 'return=minimal');
  });

  await t.test('a vote arrives as a votes row, with no voter identity on it', async () => {
    const res = await client.json('/api/vote/cast', {
      voterId: 'ASM1234567',
      candidateId: 'cand-02',
    });
    assert.equal(res.status, 201);
    const { receipt } = await res.json();

    const sent = fake.requests.find((r) => r.table === 'votes');
    assert.ok(sent, 'a row should have been posted to votes');

    assert.equal(sent.row.candidate_id, 'cand-02');
    assert.equal(sent.row.receipt, receipt);
    assert.match(sent.row.voter_key, /^[0-9a-f]{64}$/, 'voter_key must be a sha256 digest');
    assert.ok(Date.parse(sent.row.cast_at));

    // The whole point of the schema: the row must not carry the voter.
    const serialised = JSON.stringify(sent.row);
    assert.doesNotMatch(serialised, /ASM1234567/, 'the raw voter ID must never be mirrored');
    assert.deepEqual(
      Object.keys(sent.row).sort(),
      ['candidate_id', 'cast_at', 'district', 'receipt', 'state', 'voter_key'],
      'no column beyond the schema should be sent'
    );
  });

  await t.test('the mirrored columns are exactly what the migration declares', async () => {
    const sql = await fs.readFile(
      path.join(__dirname, '..', 'supabase', 'migrations', '20260917121537_create_votes_and_tickets.sql'),
      'utf8'
    );
    const votes = fake.requests.find((r) => r.table === 'votes');
    const tickets = fake.requests.find((r) => r.table === 'tickets');

    for (const column of Object.keys(votes.row)) {
      assert.match(sql, new RegExp(`\\n  ${column}\\s`), `votes.${column} should exist in the migration`);
    }
    for (const column of Object.keys(tickets.row)) {
      assert.match(sql, new RegExp(`\\n  ${column}\\s`), `tickets.${column} should exist in the migration`);
    }
  });
});

// --------------------------------------------------------- mirror misbehaving
test('a broken mirror never breaks the portal', async (t) => {
  const fake = await startPostgrest({ status: 500, body: { message: 'boom' } });
  const server = await startServer({
    SUPABASE_ENABLED: 'true',
    SUPABASE_URL: fake.url,
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key',
    SUPABASE_TIMEOUT_MS: '700',
  });
  const client = makeClient(server.base);
  t.after(async () => { await server.stop(); await fake.close(); });

  await signIn(client, 'broken@example.test');

  await t.test('a vote still succeeds when Supabase returns 500', async () => {
    const res = await client.json('/api/vote/cast', { voterId: 'ASM1234568', candidateId: 'cand-01' });
    assert.equal(res.status, 201, 'the ballot must be accepted regardless');
    const body = await res.json();
    assert.ok(body.receipt);

    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'votes.json'), 'utf8'));
    assert.equal(stored.length, 1, 'the authoritative store still holds the ballot');
  });

  await t.test('a ticket still succeeds when Supabase returns 500', async () => {
    const res = await raiseTicket(client, server.base);
    assert.equal(res.status, 201);
    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'tickets.json'), 'utf8'));
    assert.equal(stored.length, 1);
  });

  await t.test('the failure is reported rather than swallowed', () => {
    assert.match(server.logs.join(''), /\[supabase\].*NOT mirrored/);
  });

  await t.test('a vote still succeeds when Supabase hangs past the timeout', async () => {
    fake.respondWith({ status: 201, body: null, delayMs: 3000 });
    const started = Date.now();
    const res = await client.json('/api/vote/cast', { voterId: 'ASM1234569', candidateId: 'cand-03' });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 201);
    assert.ok(elapsed < 2500, `the timeout should cap the wait, took ${elapsed}ms`);
    assert.match(server.logs.join(''), /timed out after 700ms/);
  });

  await t.test('a duplicate is called out as a disagreement, not a generic error', async () => {
    fake.respondWith({ status: 409, body: { code: '23505', message: 'duplicate key value' }, delayMs: 0 });
    const res = await client.json('/api/vote/cast', { voterId: 'BHR7830256', candidateId: 'cand-01' });
    assert.equal(res.status, 201, 'the file store is authoritative and accepted it');
    assert.match(server.logs.join(''), /already present -- file store and database disagree/);
  });
});

test('a vote still succeeds when Supabase is not listening at all', async (t) => {
  // A port nothing is bound to: the connection is refused outright.
  const server = await startServer({
    SUPABASE_ENABLED: 'true',
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key',
    SUPABASE_TIMEOUT_MS: '900',
  });
  const client = makeClient(server.base);
  t.after(() => server.stop());

  await signIn(client, 'refused@example.test');
  const res = await client.json('/api/vote/cast', { voterId: 'ASM1234567', candidateId: 'cand-04' });
  assert.equal(res.status, 201);

  const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'votes.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.match(server.logs.join(''), /\[supabase\] vote .* NOT mirrored/);
});

// -------------------------------------------------------------- mirror off
test('with the mirror off nothing is sent and nothing is logged', async (t) => {
  const fake = await startPostgrest({ status: 201 });
  const server = await startServer({
    SUPABASE_ENABLED: 'false',
    SUPABASE_URL: fake.url,
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key',
  });
  const client = makeClient(server.base);
  t.after(async () => { await server.stop(); await fake.close(); });

  await signIn(client, 'off@example.test');
  assert.equal((await raiseTicket(client, server.base)).status, 201);
  assert.equal((await client.json('/api/vote/cast', { voterId: 'ASM1234567', candidateId: 'cand-01' })).status, 201);

  assert.equal(fake.requests.length, 0, 'nothing should have been posted');
  assert.match(server.logs.join(''), /Supabase mirror: off \(SUPABASE_ENABLED is not "true"\)/);
  assert.doesNotMatch(server.logs.join(''), /\[supabase\]/);
});

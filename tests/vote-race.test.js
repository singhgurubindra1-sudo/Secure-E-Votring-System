'use strict';

/**
 * Two ballots for the same voter, cast at the same instant.
 *
 * hasVoted() reads the store before either request writes, so both get past
 * it. What actually prevents a double vote is the guard inside the mutator
 * store.update runs under a per-file lock. That guard has always worked -- but
 * it used to work silently: the losing request was handed 201 and a receipt
 * for a ballot that was never written, so a voter could hold a receipt no
 * count would ever contain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { startServer, makeClient } = require('./helpers/server');

test('simultaneous ballots for one voter: one counted, one refused', async (t) => {
  const server = await startServer();
  const client = makeClient(server.base);
  t.after(() => server.stop());

  assert.equal(
    (await client.json('/api/auth/register', {
      name: 'Gurubinder Singh',
      email: 'race@example.test',
      password: 'votesafe2026',
    })).status,
    201
  );

  const cast = () => client.json('/api/vote/cast', { voterId: 'ASM1234567', candidateId: 'cand-01' });
  const results = await Promise.all([cast(), cast(), cast()]);
  const statuses = results.map((r) => r.status).sort();

  // A Response body can be read exactly once, so the accepted one is drained
  // here and shared rather than re-read in each assertion.
  const accepted = [];
  for (const res of results) {
    if (res.status === 201) accepted.push(await res.json());
  }

  await t.test('exactly one ballot is accepted', () => {
    assert.equal(statuses.filter((s) => s === 201).length, 1, `got ${statuses.join(', ')}`);
  });

  await t.test('the losers are refused, not quietly dropped', () => {
    assert.equal(statuses.filter((s) => s === 409).length, 2, `got ${statuses.join(', ')}`);
  });

  await t.test('only one ballot reached the store', async () => {
    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'votes.json'), 'utf8'));
    assert.equal(stored.length, 1);
  });

  await t.test('every receipt handed out corresponds to a stored ballot', async () => {
    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'votes.json'), 'utf8'));
    const receipts = new Set(stored.map((v) => v.receipt));

    for (const body of accepted) {
      assert.ok(body.receipt, 'a 201 should carry a receipt');
      assert.ok(receipts.has(body.receipt), `receipt ${body.receipt} was issued but never stored`);
    }
  });

  await t.test('the recorded time matches the time reported to the voter', async () => {
    const stored = JSON.parse(await fs.readFile(path.join(server.dataDir, 'votes.json'), 'utf8'));
    assert.equal(
      accepted[0].castAt,
      stored[0].castAt,
      'the stored time and the reported time used to be two separate new Date() calls'
    );
  });

  await t.test('the tally counts one vote', async () => {
    const body = await (await client.request('/api/vote/results')).json();
    assert.equal(body.totalVotes, 1);
    assert.equal(body.tally.reduce((sum, row) => sum + row.votes, 0), 1);
  });
});

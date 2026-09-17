'use strict';

/**
 * Mirrors votes and tickets into Supabase.
 *
 * The JSON file store stays authoritative. This is a copy, written after the
 * real write has already succeeded, and it is deliberately incapable of
 * failing a request: if Supabase is slow, down, misconfigured or returns
 * nonsense, a voter still casts their ballot and still gets their receipt.
 * Every function here resolves; none of them throw.
 *
 * It speaks to PostgREST over plain fetch rather than @supabase/supabase-js.
 * An insert is one POST, so the client library would add a few megabytes of
 * dependency to save nothing, and this project already avoids carrying code it
 * does not need.
 */

const DEFAULT_TIMEOUT = 5000;

function setting(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function baseUrl() {
  return setting('SUPABASE_URL').replace(/\/+$/, '');
}

function secret() {
  return setting('SUPABASE_SERVICE_ROLE_KEY');
}

/** On unless explicitly switched on AND given somewhere to write to. */
function enabled() {
  return setting('SUPABASE_ENABLED').toLowerCase() === 'true' && Boolean(baseUrl() && secret());
}

/** Why the mirror is off, for the boot banner. Null when it is on. */
function disabledReason() {
  if (setting('SUPABASE_ENABLED').toLowerCase() !== 'true') return 'SUPABASE_ENABLED is not "true"';
  if (!baseUrl()) return 'SUPABASE_URL is empty';
  if (!secret()) return 'SUPABASE_SERVICE_ROLE_KEY is empty';
  return null;
}

function timeout() {
  const raw = Number(setting('SUPABASE_TIMEOUT_MS', String(DEFAULT_TIMEOUT)));
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 500), 30000) : DEFAULT_TIMEOUT;
}

function headers() {
  const key = secret();
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    // Nothing here reads the row back, and not returning it keeps ballot
    // contents out of a response body that might end up in a log.
    prefer: 'return=minimal',
  };
}

/**
 * POSTs one row.
 *
 * Resolves to { ok, status, duplicate, error }. `duplicate` marks Postgres
 * error 23505, which for votes means the unique voter_key already held a
 * ballot -- worth knowing about rather than treating as a generic failure.
 */
async function insert(table, row) {
  if (!enabled()) return { ok: false, skipped: true, status: 0, duplicate: false, error: 'mirror off' };

  const url = `${baseUrl()}/rest/v1/${encodeURIComponent(table)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(timeout()),
    });

    if (res.status === 201 || res.status === 200 || res.status === 204) {
      return { ok: true, status: res.status, duplicate: false, error: null };
    }

    // PostgREST reports the Postgres error code in a JSON body. Read it if it
    // is there, but never let a surprise body shape become an exception.
    let code = '';
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      code = String(body.code || '');
      message = body.message || body.error || message;
    } catch {
      /* a non-JSON error body is still just a failure */
    }

    return {
      ok: false,
      status: res.status,
      duplicate: code === '23505',
      error: `${message}${code ? ` (${code})` : ''}`,
    };
  } catch (err) {
    const reason = err && err.name === 'TimeoutError'
      ? `timed out after ${timeout()}ms`
      : (err && err.message) || 'request failed';
    return { ok: false, status: 0, duplicate: false, error: reason };
  }
}

/** Shapes a stored vote for the votes table. Snake case, and nothing more. */
function voteRow(vote) {
  return {
    voter_key: vote.voterKey,
    candidate_id: vote.candidateId,
    district: vote.district || null,
    state: vote.state || null,
    receipt: vote.receipt,
    cast_at: vote.castAt,
  };
}

/** Shapes a stored ticket. The absolute disk path is already gone by here. */
function ticketRow(ticket) {
  return {
    reference: ticket.reference,
    name: ticket.name,
    email: ticket.email,
    phone: ticket.phone || null,
    category: ticket.category,
    issue: ticket.issue,
    raised_by: ticket.raisedBy || null,
    status: ticket.status || 'open',
    attachments: (ticket.attachments || []).map((a) => ({
      originalName: a.originalName,
      storedName: a.storedName,
      mimeType: a.mimeType,
      size: a.size,
    })),
    created_at: ticket.createdAt,
  };
}

/**
 * Mirrors a row and reports the outcome to the console.
 *
 * Called with the write already safely on disk, so the only thing left to do
 * about a failure is say so. A duplicate vote is logged loudly because it
 * means the file store and the database disagree about who has voted.
 */
async function mirror(kind, table, row, label) {
  const result = await insert(table, row);
  if (result.skipped) return result;

  if (result.ok) {
    console.log(`[supabase] ${kind} ${label} mirrored`);
  } else if (result.duplicate) {
    console.warn(`[supabase] ${kind} ${label} already present -- file store and database disagree`);
  } else {
    console.warn(`[supabase] ${kind} ${label} NOT mirrored: ${result.error}`);
  }
  return result;
}

const mirrorVote = (vote) => mirror('vote', 'votes', voteRow(vote), vote.receipt);
const mirrorTicket = (ticket) => mirror('ticket', 'tickets', ticketRow(ticket), ticket.reference);

/** Reachability check for the setup script. Reads nothing back. */
async function ping(table) {
  if (!enabled()) return { ok: false, skipped: true, error: disabledReason() };
  try {
    const res = await fetch(`${baseUrl()}/rest/v1/${encodeURIComponent(table)}?select=id&limit=1`, {
      headers: headers(),
      signal: AbortSignal.timeout(timeout()),
    });
    if (res.ok) return { ok: true, status: res.status, error: null };

    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.message || body.hint || message;
    } catch { /* keep the status */ }
    return { ok: false, status: res.status, error: message };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || 'request failed' };
  }
}

module.exports = {
  enabled,
  disabledReason,
  insert,
  mirrorVote,
  mirrorTicket,
  voteRow,
  ticketRow,
  ping,
  timeout,
};

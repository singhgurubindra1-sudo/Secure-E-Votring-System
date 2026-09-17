'use strict';
/**
 * Reports whether the Supabase settings in .env are usable, without ever
 * printing the key itself.
 *
 * Supabase issues two generations of keys and they look nothing alike:
 * the current ones are prefixed strings (sb_secret_... / sb_publishable_...),
 * the legacy ones are JWTs whose payload carries a "role". Both are still
 * accepted by the API, so both are recognised here. The common mistake is
 * reaching for the publishable key: with row level security enabled and no
 * policies, that key reads nothing at all and the failure looks like an empty
 * database rather than an auth error.
 */

require('dotenv').config();

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const enabled = String(process.env.SUPABASE_ENABLED || '').toLowerCase() === 'true';

const problems = [];
const notes = [];

// ---------------------------------------------------------------------- url
if (!url) {
  problems.push('SUPABASE_URL is empty.');
} else if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) {
  problems.push(`SUPABASE_URL does not look like a project URL: ${url}`);
} else {
  notes.push(`URL        ${url}`);
}

// ---------------------------------------------------------------------- key
function describeKey(value) {
  if (!value) return { ok: false, label: 'missing' };
  if (value.startsWith('sb_secret_')) return { ok: true, label: 'secret key (current format)' };
  if (value.startsWith('sb_publishable_')) {
    return { ok: false, label: 'PUBLISHABLE key — this is the wrong one' };
  }
  if (value.startsWith('eyJ')) {
    try {
      const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
      if (claims.role === 'service_role') {
        return { ok: true, label: 'service_role JWT (legacy format)' };
      }
      return { ok: false, label: `"${claims.role}" JWT — this is the wrong one` };
    } catch {
      return { ok: false, label: 'looks like a JWT but the payload will not decode' };
    }
  }
  return { ok: false, label: 'unrecognised — not a Supabase key' };
}

const verdict = describeKey(key);
notes.push(`Key        ${verdict.label} (${key.length} characters)`);
if (!verdict.ok) {
  problems.push(
    key
      ? 'SUPABASE_SERVICE_ROLE_KEY is not a secret key. Take the one marked "secret" from Project Settings > API Keys.'
      : 'SUPABASE_SERVICE_ROLE_KEY is empty.'
  );
}

notes.push(`Enabled    ${enabled ? 'yes' : 'no (the portal will not contact Supabase)'}`);

// -------------------------------------------------------------------- output
// --------------------------------------------------------------- live probe
// Settings that merely look right are not worth much: a revoked key, a paused
// project or a missing table all pass every check above. This actually asks.
async function probe() {
  const mirror = require('../utils/supabaseMirror');

  if (!mirror.enabled()) {
    return [`Reachability  not tested (${mirror.disabledReason()})`];
  }

  const lines = [];
  for (const table of ['votes', 'tickets']) {
    const result = await mirror.ping(table);
    if (result.ok) {
      lines.push(`public.${table.padEnd(8)} reachable`);
    } else {
      lines.push(`public.${table.padEnd(8)} FAILED - ${result.error}`);
      problems.push(`Could not read public.${table}: ${result.error}`);
    }
  }
  return lines;
}

(async () => {
  console.log('\n  Supabase configuration\n');
  notes.forEach((line) => console.log('  ' + line));

  if (verdict.ok && url) {
    console.log('');
    (await probe()).forEach((line) => console.log('  ' + line));
  }

  if (problems.length) {
    console.log('\n  Problems:');
    problems.forEach((line) => console.log('  - ' + line));
    console.log('');
    process.exit(1);
  }

  console.log('\n  Looks good.\n');
})();

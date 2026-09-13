'use strict';

/** Collapse whitespace and cap length so nothing unbounded reaches storage. */
function clean(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Voter IDs are compared case-insensitively with spaces and dashes removed. */
function normalizeVoterId(value) {
  return clean(value, 40).toUpperCase().replace(/[\s-]/g, '');
}

/** Names are compared case-insensitively on a single-spaced form. */
function normalizeName(value) {
  return clean(value, 120).toLowerCase();
}

/** Accepts YYYY-MM-DD or DD-MM-YYYY (also with / or .) and returns YYYY-MM-DD. */
function normalizeDob(value) {
  const raw = clean(value, 20).replace(/[./]/g, '-');
  let y, m, d;

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    [y, m, d] = raw.split('-').map(Number);
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(raw)) {
    [d, m, y] = raw.split('-').map(Number);
  } else {
    return '';
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  if (!valid) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** YYYY-MM-DD -> DD-MM-YYYY for display. */
function displayDob(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '');
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean(value, 254));
}

/** Indian mobile numbers: 10 digits starting 6-9, optional +91 / 0 prefix. */
function normalizePhone(value) {
  const digits = clean(value, 20).replace(/\D/g, '');
  const local = digits.replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(local) ? local : '';
}

function ageOn(isoDob, isoOn = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDob)) return null;
  const [by, bm, bd] = isoDob.split('-').map(Number);
  const [ny, nm, nd] = isoOn.split('-').map(Number);
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age;
}

module.exports = {
  clean,
  normalizeVoterId,
  normalizeName,
  normalizeDob,
  displayDob,
  isEmail,
  normalizePhone,
  ageOn,
};

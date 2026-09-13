#!/usr/bin/env node
'use strict';

/**
 * Load voter records into data/voters.json.
 *
 *   node scripts/import-voters.js path/to/roll.csv
 *   node scripts/import-voters.js path/to/roll.json
 *
 * CSV headers are matched loosely, so any of these work for one column:
 *   "Sl. No." / slNo, Name / name, "Voter Id Number" / voterId,
 *   State / state, District / district, "Date of Birth" / dob
 *
 * Dates may be YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'voters.json');

const HEADERS = {
  slno: 'slNo', sl: 'slNo', srno: 'slNo', serial: 'slNo', serialno: 'slNo',
  name: 'name', votername: 'name', fullname: 'name',
  voterid: 'voterId', voteridnumber: 'voterId', voteridno: 'voterId',
  epic: 'voterId', epicno: 'voterId', epicnumber: 'voterId',
  state: 'state',
  district: 'district',
  dob: 'dob', dateofbirth: 'dob', birthdate: 'dob',
};

/** "Sl. No." / "Voter Id Number" / "date_of_birth" all collapse to a lookup key. */
const key = (header) => HEADERS[String(header).toLowerCase().replace(/[^a-z0-9]/g, '')] || null;

/** Minimal CSV reader that understands quoted fields and embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i += 1; }
        else quoted = false;
      } else value += char;
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(value); value = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(value); rows.push(row); row = []; value = ''; continue; }
    value += char;
  }

  if (value !== '' || row.length) { row.push(value); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Returns YYYY-MM-DD, or '' when the date is not a real calendar day.
 * "31-02-1988" has the right shape but February has no 31st, so it is rejected
 * rather than passed through.
 */
function normalizeDate(raw) {
  const value = String(raw || '').trim().replace(/[./]/g, '-');
  let y, m, d;

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
    [y, m, d] = value.split('-').map(Number);
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(value)) {
    [d, m, y] = value.split('-').map(Number);
  } else {
    return '';
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  const real =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  if (!real) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => key(h.trim()));
  const unknown = rows[0].filter((h, i) => !headers[i] && h.trim());
  if (unknown.length) console.warn(`  Ignoring unrecognised columns: ${unknown.join(', ')}`);

  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((field, i) => {
      if (field) record[field] = String(cells[i] ?? '').trim();
    });
    return record;
  });
}

function tidy(record, index) {
  return {
    slNo: Number(record.slNo) || index + 1,
    name: String(record.name || '').replace(/\s+/g, ' ').trim(),
    voterId: String(record.voterId || '').toUpperCase().replace(/[\s-]/g, ''),
    state: String(record.state || '').trim(),
    district: String(record.district || '').trim(),
    dob: normalizeDate(record.dob),
  };
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/import-voters.js <file.csv|file.json>');
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`No such file: ${input}`);
    process.exit(1);
  }

  const text = fs.readFileSync(input, 'utf8');
  const raw = input.toLowerCase().endsWith('.json') ? JSON.parse(text) : fromCsv(text);

  if (!Array.isArray(raw)) {
    console.error('Expected the JSON file to hold an array of records.');
    process.exit(1);
  }

  const records = raw.map(tidy);

  const problems = [];
  const seen = new Set();
  records.forEach((r, i) => {
    const where = `row ${i + 1}`;
    if (!r.name) problems.push(`${where}: missing name`);
    if (!r.voterId) problems.push(`${where}: missing voter ID`);
    else if (seen.has(r.voterId)) problems.push(`${where}: duplicate voter ID ${r.voterId}`);
    else seen.add(r.voterId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dob)) {
      const original = raw[i] && (raw[i].dob ?? raw[i]['Date of Birth'] ?? raw[i].DOB);
      problems.push(`${where}: unreadable date of birth "${original ?? ''}"`);
    }
  });

  if (problems.length) {
    console.warn(`\n  ${problems.length} problem(s) found:`);
    problems.slice(0, 20).forEach((p) => console.warn(`   - ${p}`));
    if (problems.length > 20) console.warn(`   ... and ${problems.length - 20} more`);
    console.warn('');
  }

  fs.writeFileSync(OUT, JSON.stringify(records, null, 2) + '\n', 'utf8');
  console.log(`  Imported ${records.length} voter record(s) into data/voters.json`);
  if (problems.length) console.log('  Fix the problems above and run the import again.');
}

main();

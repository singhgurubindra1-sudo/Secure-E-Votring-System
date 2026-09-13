'use strict';

const express = require('express');
const store = require('../utils/store');
const { requireAuth } = require('../middleware/auth');
const { clean, normalizeVoterId, normalizeName, displayDob } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

/**
 * Accepts either of these shapes per record and normalises them:
 *   { slNo, name, voterId, state, district, dob }
 *   { "Sl. No.": 1, "Name": "...", "Voter Id Number": "...", ... }
 */
function normalizeRecord(raw, index) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== '') {
        return String(raw[key]).trim();
      }
    }
    return '';
  };

  const dobRaw = pick('dob', 'DOB', 'dateOfBirth', 'Date of Birth', 'date_of_birth');
  let dob = dobRaw;
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(dobRaw)) {
    const [d, m, y] = dobRaw.split(/[-/.]/);
    dob = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return {
    slNo: Number(pick('slNo', 'sl_no', 'Sl. No.', 'SL No', 'serial')) || index + 1,
    name: pick('name', 'Name', 'voterName'),
    // Stored stripped of spaces and dashes so the table, the card PDF and the
    // ballot all show the same form no matter how the source data was typed.
    voterId: normalizeVoterId(pick('voterId', 'voter_id', 'Voter Id Number', 'Voter ID', 'epic', 'EPIC')),
    state: pick('state', 'State'),
    district: pick('district', 'District'),
    dob,
    dobDisplay: displayDob(dob),
  };
}

async function loadRoll() {
  const raw = await store.read('voters', []);
  return Array.isArray(raw) ? raw.map(normalizeRecord) : [];
}

/** Find one voter by ID. Used by the card and ballot flows. */
async function findByVoterId(voterId) {
  const target = normalizeVoterId(voterId);
  if (!target) return null;
  const roll = await loadRoll();
  return roll.find((v) => normalizeVoterId(v.voterId) === target) || null;
}

/**
 * GET /api/voters
 * Query: name, voterId, state, district, page, pageSize, sort
 */
router.get('/', async (req, res, next) => {
  try {
    const nameQuery = normalizeName(req.query.name || '');
    const idQuery = normalizeVoterId(req.query.voterId || '');
    const stateQuery = normalizeName(req.query.state || '');
    const districtQuery = normalizeName(req.query.district || '');

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 25));

    let rows = await loadRoll();
    const total = rows.length;

    if (nameQuery) rows = rows.filter((v) => normalizeName(v.name).includes(nameQuery));
    if (idQuery) rows = rows.filter((v) => normalizeVoterId(v.voterId).includes(idQuery));
    if (stateQuery) rows = rows.filter((v) => normalizeName(v.state).includes(stateQuery));
    if (districtQuery) rows = rows.filter((v) => normalizeName(v.district).includes(districtQuery));

    const sort = clean(req.query.sort, 20);
    const direction = String(req.query.order).toLowerCase() === 'desc' ? -1 : 1;
    if (['name', 'voterId', 'state', 'district', 'dob', 'slNo'].includes(sort)) {
      rows = [...rows].sort((a, b) => {
        if (sort === 'slNo') return (a.slNo - b.slNo) * direction;
        return String(a[sort]).localeCompare(String(b[sort]), 'en', { sensitivity: 'base' }) * direction;
      });
    }

    const matched = rows.length;
    const start = (page - 1) * pageSize;

    res.json({
      ok: true,
      total,
      matched,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(matched / pageSize)),
      rows: rows.slice(start, start + pageSize),
    });
  } catch (err) {
    next(err);
  }
});

/** Distinct states and districts, for the filter dropdowns. */
router.get('/facets', async (req, res, next) => {
  try {
    const roll = await loadRoll();
    const states = [...new Set(roll.map((v) => v.state).filter(Boolean))].sort();
    const districts = [...new Set(roll.map((v) => v.district).filter(Boolean))].sort();
    res.json({ ok: true, states, districts });
  } catch (err) {
    next(err);
  }
});

/** GET /api/voters/:voterId - single record lookup. */
router.get('/:voterId', async (req, res, next) => {
  try {
    const voter = await findByVoterId(req.params.voterId);
    if (!voter) {
      return res.status(404).json({ ok: false, error: 'No voter found with that ID number.' });
    }
    res.json({ ok: true, voter });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.loadRoll = loadRoll;
module.exports.findByVoterId = findByVoterId;

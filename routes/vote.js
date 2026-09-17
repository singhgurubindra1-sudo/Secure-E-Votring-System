'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const store = require('../utils/store');
const { findByVoterId } = require('./voters');
const { requireAuth } = require('../middleware/auth');
const faces = require('../utils/faceTemplates');
const supabase = require('../utils/supabaseMirror');
const faceToken = require('../utils/faceToken');
const { clean, normalizeVoterId, ageOn } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again in 15 minutes.' },
});

/**
 * Votes are stored against a one-way fingerprint of the voter ID, not the ID
 * itself. That is enough to stop the same person voting twice while leaving no
 * stored link between a person and the candidate they chose.
 */
function fingerprint(voterId) {
  const pepper = process.env.JWT_SECRET || 'evoting-local-secret';
  return crypto.createHmac('sha256', pepper).update(normalizeVoterId(voterId)).digest('hex');
}

async function hasVoted(voterId) {
  const votes = await store.read('votes', []);
  return votes.some((v) => v.voterKey === fingerprint(voterId));
}

/**
 * POST /api/vote/lookup
 * Returns the credentials the confirmation dialog shows before a ballot opens.
 */
router.post('/lookup', limiter, async (req, res, next) => {
  try {
    const voterId = clean(req.body.voterId, 40);
    if (!voterId) {
      return res.status(400).json({ ok: false, field: 'voterId', error: 'Enter your voter ID number.' });
    }

    const voter = await findByVoterId(voterId);
    if (!voter) {
      return res.status(404).json({ ok: false, field: 'voterId', error: 'No voter found with that ID number.' });
    }

    const age = ageOn(voter.dob);
    const alreadyVoted = await hasVoted(voter.voterId);
    const faceEnrolled = await faces.isEnrolled(voter.voterId);

    res.json({
      ok: true,
      faceEnrolled,
      faceRequired: faceEnrolled || faces.enforcement() === 'all',
      voter: {
        name: voter.name,
        dob: voter.dob,
        dobDisplay: voter.dobDisplay,
        state: voter.state,
        district: voter.district,
        voterId: voter.voterId,
      },
      eligible: age === null || age >= 18,
      age,
      alreadyVoted,
    });
  } catch (err) {
    next(err);
  }
});

/** The ballot for a district. Falls back to the national list when unset. */
router.get('/ballot', async (req, res, next) => {
  try {
    const candidates = await store.read('candidates', []);
    const district = clean(req.query.district, 80).toLowerCase();
    const scoped = candidates.filter(
      (c) => !c.district || c.district.toLowerCase() === district
    );
    res.json({ ok: true, candidates: scoped.length ? scoped : candidates });
  } catch (err) {
    next(err);
  }
});

/** POST /api/vote/cast - records the vote and returns a receipt. */
router.post('/cast', limiter, async (req, res, next) => {
  try {
    const voterId = clean(req.body.voterId, 40);
    const candidateId = clean(req.body.candidateId, 60);

    const voter = await findByVoterId(voterId);
    if (!voter) {
      return res.status(404).json({ ok: false, error: 'No voter found with that ID number.' });
    }

    const age = ageOn(voter.dob);
    if (age !== null && age < 18) {
      return res.status(403).json({ ok: false, error: 'This voter is under 18 and cannot vote.' });
    }

    // Checked before the ballot is looked at, so a failed face check never
    // reaches the point of recording anything.
    const enrolled = await faces.isEnrolled(voter.voterId);
    if (enrolled || faces.enforcement() === 'all') {
      if (!enrolled) {
        return res.status(403).json({
          ok: false,
          faceRequired: true,
          faceEnrolled: false,
          error: 'This voter has no face on file. Enrol a photograph before casting a ballot.',
        });
      }
      if (!faceToken.verify(req.body.faceToken, voter.voterId, 'ballot')) {
        return res.status(401).json({
          ok: false,
          faceRequired: true,
          faceEnrolled: true,
          error: 'Face verification is needed before a ballot can be cast.',
        });
      }
    }

    const candidates = await store.read('candidates', []);
    const candidate = candidates.find((c) => c.id === candidateId);
    if (!candidate) {
      return res.status(400).json({ ok: false, error: 'Select a candidate from the ballot.' });
    }

    if (await hasVoted(voter.voterId)) {
      return res.status(409).json({ ok: false, error: 'A vote has already been recorded for this voter ID.' });
    }

    const receipt = crypto.randomBytes(9).toString('hex').toUpperCase().replace(/(.{6})(?=.)/g, '$1-');
    const ballot = {
      voterKey: fingerprint(voter.voterId),
      candidateId: candidate.id,
      district: voter.district,
      state: voter.state,
      receipt,
      castAt: new Date().toISOString(),
    };

    // store.update runs its mutator under a per-file lock, so this guard --
    // not the hasVoted() check above -- is what actually makes double voting
    // impossible. hasVoted() only exists to answer with a clean 409 before any
    // work is done.
    const stored = await store.update('votes', (list) => {
      if (list.some((v) => v.voterKey === ballot.voterKey)) return list;
      return [...list, ballot];
    });

    // If the guard fired, this request lost a race with an identical one and
    // nothing was written. Returning 201 with a receipt for a ballot that does
    // not exist would hand the voter a receipt they could never redeem.
    if (!stored.some((v) => v.receipt === receipt)) {
      return res.status(409).json({ ok: false, error: 'A vote has already been recorded for this voter ID.' });
    }

    // The ballot is safely on disk. Mirroring is a copy and cannot fail the
    // request; supabaseMirror never throws and logs its own outcome.
    await supabase.mirrorVote(ballot);

    res.status(201).json({
      ok: true,
      receipt,
      candidate: { id: candidate.id, name: candidate.name, party: candidate.party },
      castAt: ballot.castAt,
    });
  } catch (err) {
    next(err);
  }
});

/** Aggregate tallies only. No individual vote is ever exposed. */
router.get('/results', async (req, res, next) => {
  try {
    const [votes, candidates] = await Promise.all([
      store.read('votes', []),
      store.read('candidates', []),
    ]);
    const tally = candidates.map((c) => ({
      id: c.id,
      name: c.name,
      party: c.party,
      votes: votes.filter((v) => v.candidateId === c.id).length,
    }));
    res.json({ ok: true, totalVotes: votes.length, tally: tally.sort((a, b) => b.votes - a.votes) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

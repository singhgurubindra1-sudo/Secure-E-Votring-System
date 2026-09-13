'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { findByVoterId } = require('./voters');
const { requireAuth } = require('../middleware/auth');
const { streamVoterCard } = require('../utils/voterCardPdf');
const faces = require('../utils/faceTemplates');
const faceToken = require('../utils/faceToken');
const { normalizeName, normalizeDob, clean } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many card requests. Try again in 15 minutes.' },
});

/**
 * All three details must match the roll before a card is released. Matching on
 * the voter ID alone would let anyone print a card for any ID they can guess.
 */
async function verify(body) {
  const name = clean(body.name, 120);
  const dob = normalizeDob(body.dob);
  const voterIdRaw = clean(body.voterId, 40);

  if (!name) return { error: 'Enter the name printed on the roll.', field: 'name' };
  if (!voterIdRaw) return { error: 'Enter your voter ID number.', field: 'voterId' };
  if (!dob) return { error: 'Enter a valid date of birth.', field: 'dob' };

  const voter = await findByVoterId(voterIdRaw);
  if (!voter) return { error: 'No voter found with that ID number.', field: 'voterId' };

  if (normalizeName(voter.name) !== normalizeName(name)) {
    return { error: 'The name does not match this voter ID.', field: 'name' };
  }
  if (voter.dob !== dob) {
    return { error: 'The date of birth does not match this voter ID.', field: 'dob' };
  }

  return { voter };
}

/** Check the three details without producing a file, so the form can show errors inline. */
router.post('/verify', limiter, async (req, res, next) => {
  try {
    const result = await verify(req.body);
    if (result.error) return res.status(404).json({ ok: false, ...result });

    const enrolled = await faces.isEnrolled(result.voter.voterId);
    res.json({
      ok: true,
      voter: result.voter,
      faceRequired: enrolled || faces.enforcement() === 'all',
      faceEnrolled: enrolled,
    });
  } catch (err) {
    next(err);
  }
});

/** Verify again, then stream the PDF. */
router.post('/download', limiter, async (req, res, next) => {
  try {
    const result = await verify(req.body);
    if (result.error) return res.status(404).json({ ok: false, ...result });

    const { voter } = result;

    // A voter with a face on file must prove it on camera every download. When
    // enforcement is "all", a voter with no face on file cannot download at all.
    const enrolled = await faces.isEnrolled(voter.voterId);
    if (enrolled || faces.enforcement() === 'all') {
      if (!enrolled) {
        return res.status(403).json({
          ok: false,
          faceRequired: true,
          faceEnrolled: false,
          error: 'This voter has no face on file. Enrol a photograph before downloading a card.',
        });
      }
      if (!faceToken.verify(req.body.faceToken, voter.voterId, 'card')) {
        return res.status(401).json({
          ok: false,
          faceRequired: true,
          faceEnrolled: true,
          error: 'Face verification is needed before the card can be downloaded.',
        });
      }
    }

    const photo = await faces.readPhoto(voter.voterId);

    const fileName = `voter-card-${voter.voterId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    streamVoterCard(voter, res, { photo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

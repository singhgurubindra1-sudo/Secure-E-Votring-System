'use strict';

/**
 * Face enrolment and verification.
 *
 * Descriptors are computed in the browser; this router makes the decision. The
 * browser is told only "matched" or "did not match" plus a fresh action token,
 * never the enrolled descriptors, so a caller cannot walk the template out of
 * the API. Verification is rate limited because repeated guesses against a
 * distance threshold are the obvious attack.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const faces = require('../utils/faceTemplates');
const faceToken = require('../utils/faceToken');
const faceAssets = require('../utils/faceAssets');
const { findByVoterId } = require('./voters');
const { requireAuth } = require('../middleware/auth');
const { clean, normalizeVoterId } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many face checks. Try again in 15 minutes.' },
});

const enrolLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many enrolment attempts. Try again later.' },
});

const showDistance = () => process.env.NODE_ENV !== 'production';

/**
 * GET /api/face/assets
 * Whether the library and model weights are actually installed, so a page can
 * report the real reason instead of "something did not load".
 */
router.get('/assets', (req, res) => {
  const state = faceAssets.check();
  res.json({
    ok: state.ok,
    library: state.library,
    modelsMissing: state.missingModels.length,
    reason: state.reason,
    hint: state.hint,
  });
});

/**
 * GET /api/face/status?voterId=...
 * Lets a page decide whether to run a camera check before the real action.
 */
router.get('/status', async (req, res, next) => {
  try {
    const voterId = normalizeVoterId(req.query.voterId || '');
    if (!voterId) return res.status(400).json({ ok: false, field: 'voterId', error: 'Enter a voter ID number.' });

    const voter = await findByVoterId(voterId);
    if (!voter) return res.status(404).json({ ok: false, field: 'voterId', error: 'No voter found with that ID number.' });

    const enrolled = await faces.isEnrolled(voter.voterId);
    res.json({
      ok: true,
      voterId: voter.voterId,
      enrolled,
      // "all" means an unenrolled voter is blocked rather than waved through.
      required: enrolled || faces.enforcement() === 'all',
      enforcement: faces.enforcement(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/face/verify { voterId, descriptor, purpose }
 * On a match, returns a short-lived token the card and ballot routes require.
 */
router.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const voterId = normalizeVoterId(req.body.voterId || '');
    const purpose = clean(req.body.purpose, 20);
    const { descriptor } = req.body;

    if (!faceToken.PURPOSES.has(purpose)) {
      return res.status(400).json({ ok: false, error: 'Unknown verification purpose.' });
    }
    if (!voterId) {
      return res.status(400).json({ ok: false, field: 'voterId', error: 'Enter a voter ID number.' });
    }
    if (!faces.isDescriptor(descriptor)) {
      return res.status(400).json({ ok: false, error: 'The camera did not produce a usable face reading. Try again.' });
    }

    const voter = await findByVoterId(voterId);
    if (!voter) {
      return res.status(404).json({ ok: false, field: 'voterId', error: 'No voter found with that ID number.' });
    }

    const template = await faces.templateFor(voter.voterId);
    if (!template) {
      if (faces.enforcement() === 'all') {
        return res.status(403).json({
          ok: false,
          enrolled: false,
          error: 'This voter has no face on file. Enrol a photograph before using this service.',
        });
      }
      // Nothing to compare against, so there is nothing to prove.
      return res.json({ ok: true, enrolled: false, matched: false, token: null });
    }

    const result = faces.match(descriptor, template);
    if (!result.matched) {
      return res.status(401).json({
        ok: false,
        enrolled: true,
        matched: false,
        error: 'The face on camera does not match the photograph on file for this voter ID.',
        ...(showDistance() ? { distance: Number(result.distance.toFixed(4)), threshold: result.threshold } : {}),
      });
    }

    res.json({
      ok: true,
      enrolled: true,
      matched: true,
      token: faceToken.issue(voter.voterId, purpose),
      expiresIn: faceToken.ttlSeconds(),
      ...(showDistance() ? { distance: Number(result.distance.toFixed(4)), threshold: result.threshold } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/face/enrol { voterId, descriptors, photo }
 * Records the reference face for a voter and the photograph printed on the card.
 *
 * Any signed-in account can reach this, which is only acceptable because the
 * portal has no administrator role yet -- see the note in the README.
 */
router.post('/enrol', enrolLimiter, async (req, res, next) => {
  try {
    const voterId = normalizeVoterId(req.body.voterId || '');
    const { descriptors, photo } = req.body;

    if (!voterId) {
      return res.status(400).json({ ok: false, field: 'voterId', error: 'Enter a voter ID number.' });
    }
    const voter = await findByVoterId(voterId);
    if (!voter) {
      return res.status(404).json({ ok: false, field: 'voterId', error: 'No voter found with that ID number.' });
    }

    const usable = Array.isArray(descriptors) ? descriptors.filter(faces.isDescriptor) : [];
    if (!usable.length) {
      return res.status(400).json({
        ok: false,
        field: 'photos',
        error: 'No face could be read from those photographs. Use clear, front-facing pictures of one person.',
      });
    }

    let hasPhoto = false;
    if (photo) {
      try {
        const { mimeType, buffer } = faces.decodeDataUrl(photo);
        await faces.savePhoto(voter.voterId, buffer, mimeType);
        hasPhoto = true;
      } catch (err) {
        return res.status(400).json({ ok: false, field: 'photos', error: err.message });
      }
    }

    const entry = await faces.saveTemplate(voter.voterId, usable, {
      enrolledBy: req.user.sub,
      hasPhoto,
    });

    res.status(201).json({
      ok: true,
      voterId: voter.voterId,
      name: voter.name,
      samples: entry.samples,
      hasPhoto,
      message: `Face enrolled for ${voter.name} from ${entry.samples} photograph(s).`,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/face/forget { voterId } - removes a template and its photograph. */
router.post('/forget', enrolLimiter, async (req, res, next) => {
  try {
    const voterId = normalizeVoterId(req.body.voterId || '');
    if (!voterId) {
      return res.status(400).json({ ok: false, field: 'voterId', error: 'Enter a voter ID number.' });
    }
    if (!(await faces.isEnrolled(voterId))) {
      return res.status(404).json({ ok: false, error: 'No face is enrolled for that voter ID.' });
    }
    await faces.removeTemplate(voterId);
    res.json({ ok: true, voterId, message: 'Face template and photograph deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

'use strict';

/**
 * A short-lived, signed proof that a face check passed.
 *
 * The browser cannot mint one of these: the server issues it only after a
 * descriptor has matched an enrolled template, and it is scoped to one voter ID
 * and one action ("card" or "ballot"), so a token earned for a card download
 * cannot be replayed to cast a ballot. It expires in minutes, which keeps the
 * window for reusing a captured token small.
 */

const jwt = require('jsonwebtoken');
const { secret } = require('../middleware/auth');

const PURPOSES = new Set(['card', 'ballot']);

function ttlSeconds() {
  const value = Number(process.env.FACE_TOKEN_TTL);
  if (!Number.isFinite(value)) return 300;
  return Math.min(1800, Math.max(30, Math.trunc(value)));
}

function issue(voterId, purpose) {
  if (!PURPOSES.has(purpose)) throw new Error('Unknown face check purpose: ' + purpose);
  return jwt.sign({ sub: String(voterId), purpose, typ: 'face' }, secret(), {
    expiresIn: ttlSeconds(),
  });
}

/**
 * True only when the token is valid, unexpired, and was issued for exactly this
 * voter and this action.
 */
function verify(token, voterId, purpose) {
  if (typeof token !== 'string' || !token) return false;
  try {
    const claims = jwt.verify(token, secret());
    return (
      claims.typ === 'face' &&
      claims.purpose === purpose &&
      claims.sub === String(voterId)
    );
  } catch {
    return false;
  }
}

module.exports = { issue, verify, ttlSeconds, PURPOSES };

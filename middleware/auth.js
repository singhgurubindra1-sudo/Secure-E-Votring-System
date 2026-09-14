'use strict';

const jwt = require('jsonwebtoken');

const COOKIE = 'ev_session';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 16) {
    throw new Error('JWT_SECRET is missing or too short. Set it in .env');
  }
  return value;
}

function hours() {
  return Math.max(1, Number(process.env.SESSION_HOURS || 8));
}

function issueSession(res, user) {
  const token = jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role || 'voter' },
    secret(),
    { expiresIn: `${hours()}h` }
  );

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: hours() * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/', sameSite: 'strict' });
}

function readSession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, secret());
  } catch {
    return null;
  }
}

/** Blocks the request unless a valid session cookie is present. */
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({
      ok: false,
      // Marks this as an expired session rather than any other 401 -- a face
      // that does not match also answers 401, and the two need different
      // handling in the browser.
      sessionExpired: true,
      error: 'Your session has ended. Sign in again.',
    });
  }
  req.user = session;
  next();
}

/** Serves the sign-in page instead of a protected HTML page. */
function requirePage(req, res, next) {
  if (!readSession(req)) return res.redirect('/?next=' + encodeURIComponent(req.originalUrl));
  next();
}

module.exports = { issueSession, clearSession, readSession, requireAuth, requirePage, secret, COOKIE };

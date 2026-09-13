'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const store = require('../utils/store');
const { clean, isEmail } = require('../utils/validate');
const { issueSession, clearSession, readSession, requireAuth } = require('../middleware/auth');

const router = express.Router();

const signInLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Wait 10 minutes and try again.' },
});

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Use at least 8 characters.';
  }
  if (password.length > 128) return 'Use 128 characters or fewer.';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return 'Include at least one letter and one number.';
  }
  return null;
}

router.post('/register', signInLimiter, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const email = clean(req.body.email, 254).toLowerCase();
    const { password } = req.body;

    if (name.length < 2) {
      return res.status(400).json({ ok: false, field: 'name', error: 'Enter your full name.' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ ok: false, field: 'email', error: 'Enter a valid email address.' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ ok: false, field: 'password', error: problem });

    const users = await store.read('users');
    if (users.some((u) => u.email === email)) {
      return res.status(409).json({ ok: false, field: 'email', error: 'An account already uses this email.' });
    }

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      role: 'voter',
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString(),
    };

    await store.update('users', (list) => [...list, user]);
    issueSession(res, user);
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', signInLimiter, async (req, res, next) => {
  try {
    const email = clean(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const users = await store.read('users');
    const user = users.find((u) => u.email === email);

    // Always run a hash comparison so a missing account and a wrong password
    // take the same amount of time.
    const hash = user ? user.passwordHash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const matches = await bcrypt.compare(password, hash);

    if (!user || !matches) {
      return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' });
    }

    issueSession(res, user);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role } });
});

router.get('/status', (req, res) => {
  const session = readSession(req);
  res.json({ ok: true, signedIn: Boolean(session), user: session ? { name: session.name, email: session.email } : null });
});

module.exports = router;

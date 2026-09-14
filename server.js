'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { requirePage, readSession } = require('./middleware/auth');
const faceAssets = require('./utils/faceAssets');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Bind every interface by default. Node would pick '::' on its own, but
// Codespaces and Docker only notice a forwarded port when the listening
// socket is unambiguous, and a container with IPv6 off makes '::' one.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.JWT_SECRET) {
  console.error('\n  Missing JWT_SECRET. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'wasm-unsafe-eval' lets TensorFlow.js compile its WASM kernels for
        // face matching. It does not permit eval() of JavaScript.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
  })
);

app.use('/api/face/enrol', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Slow down and try again.' },
}));

// ---------------------------------------------------------------- API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/voters', require('./routes/voters'));
app.use('/api/card', require('./routes/card'));
app.use('/api/vote', require('./routes/vote'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/face', require('./routes/face'));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'e-voting', time: new Date().toISOString() });
});

// ------------------------------------------------------- Face matching assets
const FACE_API_DIR = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api');
// The library build and the model weights are fixed for a given installed
// version, so they are worth caching hard -- the recognition net alone is
// 6.3 MB and re-fetching it on every visit is the slowest part of a check.
const vendorCache = { maxAge: '30d', immutable: true };

app.use('/vendor/face-api', express.static(path.join(FACE_API_DIR, 'dist'), vendorCache));
app.use('/models', express.static(path.join(FACE_API_DIR, 'model'), vendorCache));

// three.js for the forest backdrop. The whole build directory is served
// because three.module.js imports three.core.js beside it by relative path,
// and script-src is 'self' -- a CDN copy would be refused.
app.use(
  '/vendor/three',
  express.static(path.join(__dirname, 'node_modules', 'three', 'build'), vendorCache)
);

// -------------------------------------------------------------------- Pages
const page = (file) => path.join(PUBLIC_DIR, file);

app.get('/', (req, res) => {
  if (readSession(req)) return res.redirect('/dashboard');
  res.sendFile(page('index.html'));
});

const protectedPages = {
  '/dashboard': 'dashboard.html',
  '/voter-list': 'voter-list.html',
  '/voter-card': 'voter-card.html',
  '/e-vote': 'e-vote.html',
  '/raise-ticket': 'raise-ticket.html',
  '/enrol-face': 'enrol-face.html',
};

Object.entries(protectedPages).forEach(([route, file]) => {
  app.get(route, requirePage, (req, res) => res.sendFile(page(file)));
});

// Static assets. HTML is served through the routes above so that the session
// check cannot be skipped by requesting the file directly.
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    extensions: [],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'That endpoint does not exist.' });
  }
  res.status(404).sendFile(page('404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Something went wrong on our side. Try again.' });
});

/**
 * Inside a Codespace, `localhost` is the container, not the machine holding the
 * browser, so printing it sends people to a dead address. GitHub sets these two
 * variables in every Codespace, so the real forwarded URL can be printed instead.
 */
function publicUrl() {
  const name = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (name && domain) return `https://${name}-${PORT}.${domain}`;
  return `http://localhost:${PORT}`;
}

app.listen(PORT, HOST, () => {
  console.log(`\n  E-Voting portal running at ${publicUrl()}`);
  if (process.env.CODESPACE_NAME) {
    console.log(`  (inside the Codespace itself: http://localhost:${PORT})`);
  }
  console.log(`  Mail mode: ${String(process.env.MAIL_DRY_RUN).toLowerCase() === 'true' ? 'dry run (written to /outbox)' : 'live SMTP'}`);

  // Served out of node_modules, so a pull without an install breaks this
  // silently unless it is called out here.
  const face = faceAssets.check();
  console.log(`  Face matching: ${face.ok ? 'ready' : 'UNAVAILABLE'}`);
  if (!face.ok) {
    console.log(`\n  ${face.reason}\n  ${face.hint}`);
  }
  console.log('');
});

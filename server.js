'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { requirePage, readSession } = require('./middleware/auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);
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
        scriptSrc: ["'self'"],
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'e-voting', time: new Date().toISOString() });
});

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

app.listen(PORT, () => {
  console.log(`\n  E-Voting portal running at http://localhost:${PORT}`);
  console.log(`  Mail mode: ${String(process.env.MAIL_DRY_RUN).toLowerCase() === 'true' ? 'dry run (written to /outbox)' : 'live SMTP'}\n`);
});

'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const supabase = require('../utils/supabaseMirror');
const store = require('../utils/store');
const { sendTicket } = require('../utils/mailer');
const { requireAuth } = require('../middleware/auth');
const { clean, isEmail, normalizePhone } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

// Overridable for the same reason DATA_DIR is: concurrent test files each
// asserting on the contents of one shared uploads/ directory cannot both be
// right.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err);
    }
  },
  // Never trust the client filename on disk. The original is kept in metadata
  // and used only as the email attachment name.
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED[file.mimetype] || ''}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'attachments'));
  },
}).array('attachments', MAX_FILES);

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Ticket limit reached for this hour. Try again later.' },
});

function reference() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `EV-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function discard(files = []) {
  await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
}

function handleUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: 'Each file must be 10 MB or smaller.',
        LIMIT_FILE_COUNT: `Attach up to ${MAX_FILES} files.`,
        LIMIT_UNEXPECTED_FILE: 'Attach images (JPG, PNG, WEBP, HEIC) or PDF files only.',
      };
      return res.status(400).json({ ok: false, field: 'attachments', error: messages[err.code] || 'That file could not be accepted.' });
    }
    next(err);
  });
}

router.post('/', limiter, handleUpload, async (req, res, next) => {
  const files = req.files || [];
  try {
    const name = clean(req.body.name, 80);
    const email = clean(req.body.email, 254).toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const issue = clean(req.body.issue, 5000);
    const category = clean(req.body.category, 60) || 'General';

    const fail = (field, error) => res.status(400).json({ ok: false, field, error });

    if (name.length < 2) { await discard(files); return fail('name', 'Enter your full name.'); }
    if (!phone) { await discard(files); return fail('phone', 'Enter a 10-digit mobile number.'); }
    if (!isEmail(email)) { await discard(files); return fail('email', 'Enter a valid email address.'); }
    if (issue.length < 15) { await discard(files); return fail('issue', 'Describe the issue in at least 15 characters.'); }

    const ticket = {
      reference: reference(),
      name,
      email,
      phone,
      category,
      issue,
      raisedBy: req.user.sub,
      createdAt: new Date().toISOString(),
      attachments: files.map((f) => ({
        originalName: clean(f.originalname, 120) || 'attachment',
        storedName: f.filename,
        storedPath: f.path,
        mimeType: f.mimetype,
        size: f.size,
      })),
    };

    await sendTicket(ticket);

    // Persist without the absolute disk path.
    const saved = {
      ...ticket,
      attachments: ticket.attachments.map(({ storedPath, ...rest }) => rest),
      status: 'open',
    };
    await store.update('tickets', (list) => [...list, saved]);

    // Mirrored from the saved shape, so the copy in Supabase carries exactly
    // what is on disk and not the disk path. Cannot fail the request.
    await supabase.mirrorTicket(saved);

    res.status(201).json({
      ok: true,
      reference: ticket.reference,
      attachments: ticket.attachments.length,
      message: 'Your ticket has been sent to the support team.',
    });
  } catch (err) {
    await discard(files);
    if (err && /TICKET_INBOX|SMTP|auth|ECONN|EAUTH|ENOTFOUND/i.test(String(err.message))) {
      return res.status(502).json({
        ok: false,
        error: 'The ticket could not be delivered. Mail delivery is not configured on the server.',
      });
    }
    next(err);
  }
});

/** Tickets raised by the signed-in account. */
router.get('/mine', async (req, res, next) => {
  try {
    const tickets = await store.read('tickets', []);
    res.json({
      ok: true,
      tickets: tickets
        .filter((t) => t.raisedBy === req.user.sub)
        .map((t) => ({
          reference: t.reference,
          category: t.category,
          status: t.status,
          createdAt: t.createdAt,
          attachments: t.attachments.length,
          issue: t.issue.slice(0, 160),
        }))
        .reverse(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

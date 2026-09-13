'use strict';

/**
 * Exercises the live (non dry-run) delivery path against a local SMTP server.
 * Nothing is sent off the machine: MAIL_DRY_RUN is false so the real
 * nodemailer transport runs, but SMTP_HOST points at 127.0.0.1.
 *
 * The transporter is cached on first use inside utils/mailer, so this file
 * configures SMTP before requiring it and keeps the live path to itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { startSmtpServer, parseMessage } = require('./helpers/smtp');

const INBOX = 'support-inbox@example.test';

test('sendTicket over SMTP', async (t) => {
  const smtp = await startSmtpServer();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-mail-'));

  process.env.MAIL_DRY_RUN = 'false';
  process.env.TICKET_INBOX = INBOX;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_PASS = 'app-password';
  process.env.SMTP_FROM = '"E-Voting Support" <sender@example.test>';

  const { sendTicket } = require('../utils/mailer');

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
  const attachmentPath = path.join(tmp, 'stored-1a2b3c.png');
  await fs.writeFile(attachmentPath, pngBytes);

  const ticket = {
    reference: 'EV-260913-AB12CD',
    name: 'Imran Hussain',
    email: 'imran@example.test',
    phone: '9123456780',
    category: 'Ballot',
    // Deliberately hostile, to confirm the HTML body is escaped.
    issue: 'The ballot page broke <script>alert("xss")</script> & showed "5 > 3" after I voted.',
    raisedBy: 'user-7',
    createdAt: '2026-09-13T10:30:00.000Z',
    attachments: [
      {
        originalName: 'screenshot of error.png',
        storedName: 'stored-1a2b3c.png',
        storedPath: attachmentPath,
        mimeType: 'image/png',
        size: pngBytes.length,
      },
    ],
  };

  let result;
  try {
    result = await sendTicket(ticket);
  } finally {
    // Keep teardown off the assertion path.
    t.after(async () => {
      await smtp.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });
  }

  await t.test('reports a live delivery, not a dry run', () => {
    assert.deepEqual(result, { delivered: true, dryRun: false });
  });

  await t.test('hands exactly one message to the SMTP server', () => {
    assert.equal(smtp.messages.length, 1);
  });

  const message = parseMessage(smtp.messages[0].raw);

  await t.test('addresses the envelope to the configured inbox', () => {
    assert.deepEqual(smtp.messages[0].to, [INBOX]);
    assert.equal(smtp.messages[0].from, 'sender@example.test');
  });

  await t.test('sets To, From, Reply-To and Subject headers', () => {
    assert.match(message.headers.to, new RegExp(INBOX));
    assert.match(message.headers.from, /E-Voting Support/);
    assert.match(message.headers.from, /sender@example\.test/);
    assert.match(message.headers['reply-to'], /imran@example\.test/);
    assert.equal(message.headers.subject, '[EV-260913-AB12CD] Ballot - Imran Hussain');
  });

  await t.test('sends a plain-text part carrying every ticket field', () => {
    const text = message.parts.find((p) => p.type.startsWith('text/plain'));
    assert.ok(text, 'no text/plain part');
    const body = text.content.toString('utf8');
    assert.match(body, /Ticket reference: EV-260913-AB12CD/);
    assert.match(body, /Name: Imran Hussain/);
    assert.match(body, /Phone: 9123456780/);
    assert.match(body, /Email: imran@example\.test/);
    assert.match(body, /Category: Ballot/);
    assert.match(body, /Attachments: 1 file\(s\)/);
    assert.match(body, /The ballot page broke/);
  });

  await t.test('escapes the issue text in the HTML part', () => {
    const html = message.parts.find((p) => p.type.startsWith('text/html'));
    assert.ok(html, 'no text/html part');
    const body = html.content.toString('utf8');
    assert.match(body, /&lt;script&gt;/);
    assert.match(body, /&amp;/);
    assert.match(body, /&quot;5 &gt; 3&quot;/);
    assert.doesNotMatch(body, /<script>/);
  });

  await t.test('attaches the stored file under its original name', () => {
    const file = message.parts.find((p) => p.type.startsWith('image/png'));
    assert.ok(file, 'no image/png part');
    assert.match(file.headers['content-disposition'] || '', /screenshot of error\.png/);
    assert.deepEqual(file.content, pngBytes);
  });

  await t.test('does not put the inbox address in the reply-to or body', () => {
    const text = message.parts.find((p) => p.type.startsWith('text/plain'));
    assert.doesNotMatch(text.content.toString('utf8'), new RegExp(INBOX));
    assert.doesNotMatch(message.headers['reply-to'], new RegExp(INBOX));
  });
});

'use strict';

/**
 * Ticket mail delivery.
 *
 * The destination address is read from process.env.TICKET_INBOX and is never
 * returned to the browser, never logged in full, and never included in any API
 * response body. The frontend only ever learns "delivered" or "not delivered".
 */

const fs = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');

// Overridable for the same reason DATA_DIR is: a test run, or a second
// instance, must not write into the outbox a developer is reading.
const OUTBOX = process.env.OUTBOX_DIR
  ? path.resolve(process.env.OUTBOX_DIR)
  : path.join(__dirname, '..', 'outbox');
let cached = null;

function dryRun() {
  return String(process.env.MAIL_DRY_RUN || '').toLowerCase() === 'true';
}

function transporter() {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return cached;
}

/** "gammahyphen@gmail.com" -> "g***n@gmail.com" for safe server-side logging. */
function maskAddress(address) {
  const [user = '', domain = ''] = String(address).split('@');
  if (user.length <= 2) return `***@${domain}`;
  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildTicketEmail(ticket) {
  const rows = [
    ['Ticket reference', ticket.reference],
    ['Raised at', new Date(ticket.createdAt).toUTCString()],
    ['Name', ticket.name],
    ['Phone', ticket.phone],
    ['Email', ticket.email],
    ['Category', ticket.category || 'General'],
    ['Attachments', ticket.attachments.length ? `${ticket.attachments.length} file(s)` : 'None'],
  ];

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nIssue\n-----\n${ticket.issue}\n`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;color:#141b2d">
    <p style="margin:0 0 4px;font-size:13px;color:#5b2e8c;font-weight:600">E-Voting support</p>
    <h2 style="margin:0 0 16px;font-size:20px">Ticket ${escapeHtml(ticket.reference)}</h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows.map(([k, v]) => `
        <tr>
          <td style="padding:7px 12px 7px 0;color:#6b7280;white-space:nowrap;border-bottom:1px solid #e7e5ee">${escapeHtml(k)}</td>
          <td style="padding:7px 0;border-bottom:1px solid #e7e5ee">${escapeHtml(v)}</td>
        </tr>`).join('')}
    </table>
    <h3 style="margin:22px 0 6px;font-size:15px">Issue</h3>
    <div style="white-space:pre-wrap;background:#f5f4f8;border-left:3px solid #5b2e8c;padding:12px 14px;font-size:14px">${escapeHtml(ticket.issue)}</div>
    <p style="margin:22px 0 0;font-size:12px;color:#6b7280">Reply directly to this email to reach ${escapeHtml(ticket.email)}.</p>
  </div>`;

  return { text, html };
}

async function sendTicket(ticket) {
  const to = process.env.TICKET_INBOX;
  if (!to) throw new Error('TICKET_INBOX is not configured');

  const { text, html } = buildTicketEmail(ticket);
  const message = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    replyTo: ticket.email,
    subject: `[${ticket.reference}] ${ticket.category || 'Support'} - ${ticket.name}`,
    text,
    html,
    attachments: ticket.attachments.map((file) => ({
      filename: file.originalName,
      path: file.storedPath,
      contentType: file.mimeType,
    })),
  };

  if (dryRun()) {
    await fs.mkdir(OUTBOX, { recursive: true });
    await fs.writeFile(
      path.join(OUTBOX, `${ticket.reference}.txt`),
      `To: ${to}\nReply-To: ${ticket.email}\nSubject: ${message.subject}\n\n${text}`,
      'utf8'
    );
    console.log(`[mail] dry run - ticket ${ticket.reference} queued for ${maskAddress(to)}`);
    return { delivered: true, dryRun: true };
  }

  await transporter().sendMail(message);
  console.log(`[mail] ticket ${ticket.reference} delivered to ${maskAddress(to)}`);
  return { delivered: true, dryRun: false };
}

module.exports = { sendTicket, maskAddress };

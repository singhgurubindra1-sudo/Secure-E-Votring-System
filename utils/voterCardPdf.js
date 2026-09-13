'use strict';

/**
 * Draws a voter card as a print-ready PDF.
 *
 * Layout: one A4 sheet holding the front and back of an ID-1 sized card
 * (85.6 x 54 mm, the same size as a bank card) with cut guides, so the sheet
 * can be printed and trimmed.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { displayDob } = require('./validate');

const MM = 2.83465;
const CARD_W = 85.6 * MM;
const CARD_H = 54 * MM;

const INK = '#141B2D';
const VIOLET = '#5B2E8C';
const MUTED = '#6B7280';
const LINE = '#D9D6E2';
const WASH = '#F5F4F8';

/** Short tamper-evident code so a printed card can be checked against the roll. */
function verificationCode(voter) {
  const secret = process.env.JWT_SECRET || 'evoting-local-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(`${voter.voterId}|${voter.name}|${voter.dob}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-');
}

function cutMarks(doc, x, y, w, h) {
  doc.save().lineWidth(0.4).strokeColor('#B9B4C7').dash(3, { space: 3 });
  doc.rect(x, y, w, h).stroke();
  doc.undash().restore();
}

function label(doc, text, x, y) {
  doc.font('Helvetica').fontSize(5.6).fillColor(MUTED).text(text, x, y, { lineBreak: false });
}

function value(doc, text, x, y, size = 9) {
  doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(text || '-', x, y, { lineBreak: false });
}

/** Decorative fingerprint-style rings, echoing the indelible ink mark. */
function inkMark(doc, cx, cy, r) {
  doc.save().lineWidth(0.6).strokeColor(VIOLET).opacity(0.22);
  for (let i = 0; i < 5; i += 1) {
    doc.circle(cx, cy, r - i * (r / 6)).stroke();
  }
  doc.opacity(1).restore();
}

function drawFront(doc, x, y, voter, photo) {
  const code = verificationCode(voter);

  doc.save();
  doc.roundedRect(x, y, CARD_W, CARD_H, 6).fillColor('#FFFFFF').fill();
  doc.roundedRect(x, y, CARD_W, CARD_H, 6).lineWidth(0.7).strokeColor(LINE).stroke();

  // Header band
  doc.save();
  doc.roundedRect(x, y, CARD_W, 34, 6).clip();
  doc.rect(x, y, CARD_W, 34).fillColor(INK).fill();
  doc.restore();
  doc.rect(x, y + 32, CARD_W, 2).fillColor(VIOLET).fill();

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
    .text('ELECTORAL PHOTO IDENTITY CARD', x + 12, y + 9, { width: CARD_W - 24, lineBreak: false });
  doc.font('Helvetica').fontSize(6).fillColor('#B6AECD')
    .text('Issued through the Secure E-Voting portal', x + 12, y + 21, { width: CARD_W - 24, lineBreak: false });

  // Photo panel
  const px = x + 12;
  const py = y + 46;
  const pw = 46;
  const ph = 56;
  doc.rect(px, py, pw, ph).fillColor(WASH).fill();

  if (photo) {
    // cover the panel and clip the overflow, so any aspect ratio fills it
    // without the face being squashed.
    doc.save();
    doc.rect(px, py, pw, ph).clip();
    try {
      doc.image(photo, px, py, { cover: [pw, ph], align: 'center', valign: 'center' });
    } catch {
      // An unreadable image must not cost the voter their card.
      doc.rect(px, py, pw, ph).fillColor(WASH).fill();
    }
    doc.restore();
    doc.rect(px, py, pw, ph).lineWidth(0.6).strokeColor(LINE).stroke();
  } else {
    doc.rect(px, py, pw, ph).lineWidth(0.6).strokeColor(LINE).stroke();
    inkMark(doc, px + pw / 2, py + ph / 2 - 4, 15);
    doc.font('Helvetica').fontSize(5).fillColor(MUTED)
      .text('PHOTOGRAPH', px, py + ph - 11, { width: pw, align: 'center', lineBreak: false });
  }

  // Details column
  const dx = px + pw + 14;
  const dw = CARD_W - (dx - x) - 12;
  let dy = py - 2;

  label(doc, 'Name', dx, dy);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
    .text(voter.name, dx, dy + 7, { width: dw, height: 14, ellipsis: true, lineBreak: false });
  dy += 26;

  label(doc, 'Date of birth', dx, dy);
  value(doc, displayDob(voter.dob), dx, dy + 7);

  label(doc, 'State', dx + dw / 2, dy);
  value(doc, voter.state, dx + dw / 2, dy + 7, 8.5);
  dy += 23;

  label(doc, 'District', dx, dy);
  value(doc, voter.district, dx, dy + 7, 8.5);

  // Voter ID strip
  const sy = y + CARD_H - 30;
  doc.rect(x + 1, sy, CARD_W - 2, 22).fillColor(WASH).fill();
  label(doc, 'Voter ID number', x + 12, sy + 4);
  doc.font('Courier-Bold').fontSize(12).fillColor(VIOLET)
    .text(voter.voterId, x + 12, sy + 11, { lineBreak: false });
  doc.font('Helvetica').fontSize(5.4).fillColor(MUTED)
    .text(`VERIFY ${code}`, x + CARD_W - 130, sy + 13, { width: 118, align: 'right', lineBreak: false });

  doc.restore();
  return code;
}

function drawBack(doc, x, y, voter, code) {
  doc.save();
  doc.roundedRect(x, y, CARD_W, CARD_H, 6).fillColor('#FFFFFF').fill();
  doc.roundedRect(x, y, CARD_W, CARD_H, 6).lineWidth(0.7).strokeColor(LINE).stroke();

  doc.rect(x, y + 12, CARD_W, 26).fillColor(INK).fill();

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
    .text('Conditions of use', x + 12, y + 48, { lineBreak: false });

  const notes = [
    'Carry this card to the polling station for in-person verification.',
    'The card is valid only while the holder remains on the electoral roll.',
    'Report a lost card through Raise a ticket on the portal.',
    'Altering any printed detail invalidates the card.',
  ];
  doc.font('Helvetica').fontSize(6.4).fillColor(MUTED);
  notes.forEach((note, i) => {
    doc.text(`\u2022  ${note}`, x + 12, y + 61 + i * 10, { width: CARD_W - 24, lineBreak: false });
  });

  const by = y + CARD_H - 34;
  doc.moveTo(x + 12, by).lineTo(x + CARD_W - 12, by).lineWidth(0.5).strokeColor(LINE).stroke();
  label(doc, 'Verification code', x + 12, by + 6);
  doc.font('Courier-Bold').fontSize(9).fillColor(INK).text(code, x + 12, by + 14, { lineBreak: false });

  label(doc, 'Issued on', x + CARD_W - 120, by + 6);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
    .text(displayDob(new Date().toISOString().slice(0, 10)), x + CARD_W - 120, by + 14, { lineBreak: false });

  doc.restore();
}

/**
 * Streams the finished PDF to res.
 * @param {object} voter { name, voterId, dob, state, district }
 * @param {import('http').ServerResponse} res
 * @param {{ photo?: Buffer|null }} options enrolled photograph, when there is one
 */
function streamVoterCard(voter, res, { photo = null } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const x = (pageW - CARD_W) / 2;

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
    .text('Voter card', 0, 64, { width: pageW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text('Print on card stock and trim along the dotted guides.', 0, 82, { width: pageW, align: 'center' });

  const frontY = 118;
  const backY = frontY + CARD_H + 38;

  cutMarks(doc, x - 6, frontY - 6, CARD_W + 12, CARD_H + 12);
  const code = drawFront(doc, x, frontY, voter, photo);

  cutMarks(doc, x - 6, backY - 6, CARD_W + 12, CARD_H + 12);
  drawBack(doc, x, backY, voter, code);

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(
      `Generated ${new Date().toUTCString()}  \u00b7  Verification ${code}`,
      0, backY + CARD_H + 40, { width: pageW, align: 'center' }
    );

  doc.end();
}

module.exports = { streamVoterCard, verificationCode };

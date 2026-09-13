'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

process.env.MAIL_DRY_RUN = 'true';
process.env.TICKET_INBOX = 'support-inbox@example.test';

const { sendTicket, maskAddress } = require('../utils/mailer');

const OUTBOX = path.join(__dirname, '..', 'outbox');

let counter = 0;
function ticket(overrides = {}) {
  counter += 1;
  return {
    reference: `EV-TEST-${String(counter).padStart(4, '0')}`,
    name: 'Priyanka Gogoi',
    email: 'priyanka@example.test',
    phone: '9876543210',
    category: 'Voter card',
    issue: 'My voter card download fails with a mismatch on my date of birth.',
    raisedBy: 'user-1',
    createdAt: '2026-09-13T10:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

const outboxFile = (ref) => fs.readFile(path.join(OUTBOX, `${ref}.txt`), 'utf8');

test('maskAddress never reveals the full inbox', async (t) => {
  await t.test('keeps only the first and last character of the local part', () => {
    assert.equal(maskAddress('gammahyphen@gmail.com'), 'g***n@gmail.com');
    assert.equal(maskAddress('support-inbox@example.test'), 's***x@example.test');
  });

  await t.test('hides a local part too short to mask safely', () => {
    assert.equal(maskAddress('ab@gmail.com'), '***@gmail.com');
    assert.equal(maskAddress('a@gmail.com'), '***@gmail.com');
  });

  await t.test('does not leak the middle of the address', () => {
    assert.doesNotMatch(maskAddress('gammahyphen@gmail.com'), /ammahyphe/);
  });
});

test('sendTicket in dry-run mode', async (t) => {
  await t.test('reports delivery without touching SMTP', async () => {
    const result = await sendTicket(ticket());
    assert.deepEqual(result, { delivered: true, dryRun: true });
  });

  await t.test('writes the message to the outbox under its reference', async () => {
    const t1 = ticket();
    await sendTicket(t1);
    const body = await outboxFile(t1.reference);
    assert.match(body, /^To: support-inbox@example\.test$/m);
    assert.match(body, /^Reply-To: priyanka@example\.test$/m);
    assert.match(body, new RegExp(`^Subject: \\[${t1.reference}\\] Voter card - Priyanka Gogoi$`, 'm'));
  });

  await t.test('includes every ticket field and the issue text', async () => {
    const t1 = ticket();
    await sendTicket(t1);
    const body = await outboxFile(t1.reference);
    assert.match(body, /Ticket reference: EV-TEST-/);
    assert.match(body, /Raised at: Sun, 13 Sep 2026 10:00:00 GMT/);
    assert.match(body, /Name: Priyanka Gogoi/);
    assert.match(body, /Phone: 9876543210/);
    assert.match(body, /Email: priyanka@example\.test/);
    assert.match(body, /Category: Voter card/);
    assert.match(body, /My voter card download fails/);
  });

  await t.test('falls back to the General category when none is given', async () => {
    const t1 = ticket({ category: '' });
    await sendTicket(t1);
    assert.match(await outboxFile(t1.reference), /Category: General/);
  });

  await t.test('summarises attachments rather than counting an empty list', async () => {
    const none = ticket();
    await sendTicket(none);
    assert.match(await outboxFile(none.reference), /Attachments: None/);

    const some = ticket({
      attachments: [
        { originalName: 'a.png', storedPath: '/tmp/a.png', mimeType: 'image/png' },
        { originalName: 'b.pdf', storedPath: '/tmp/b.pdf', mimeType: 'application/pdf' },
      ],
    });
    await sendTicket(some);
    assert.match(await outboxFile(some.reference), /Attachments: 2 file\(s\)/);
  });

  await t.test('masks the inbox in the server log', async () => {
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await sendTicket(ticket());
    } finally {
      console.log = original;
    }
    const logged = lines.join('\n');
    assert.match(logged, /s\*\*\*x@example\.test/);
    assert.doesNotMatch(logged, /support-inbox@example\.test/);
  });

  await t.test('treats MAIL_DRY_RUN case-insensitively', async () => {
    process.env.MAIL_DRY_RUN = 'TRUE';
    try {
      assert.deepEqual(await sendTicket(ticket()), { delivered: true, dryRun: true });
    } finally {
      process.env.MAIL_DRY_RUN = 'true';
    }
  });
});

test('sendTicket refuses to send with no inbox configured', async () => {
  const original = process.env.TICKET_INBOX;
  delete process.env.TICKET_INBOX;
  try {
    await assert.rejects(() => sendTicket(ticket()), /TICKET_INBOX is not configured/);
  } finally {
    process.env.TICKET_INBOX = original;
  }
});

test.after(async () => {
  await fs.rm(OUTBOX, { recursive: true, force: true });
});

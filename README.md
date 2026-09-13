# Secure E-Voting

An electoral services portal: roll lookup, voter card download, a sealed electronic ballot, and a support desk.

## Running it

```bash
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET`. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then:

```bash
npm start          # http://localhost:3000
npm run dev        # same, with auto-restart on file changes
```

Create an account on the sign-in page. The four services live behind it.

## Loading the electoral roll

The roll ships empty. Import a CSV or JSON file:

```bash
npm run import-voters -- path/to/roll.csv
```

Column headers are matched loosely — punctuation, case and spacing are ignored, so `Sl. No.`, `sl_no` and `slNo` all land in the same field:

| Field | Accepted headers |
| --- | --- |
| `slNo` | Sl. No., Sr No, Serial, slNo |
| `name` | Name, Voter Name, Full Name |
| `voterId` | Voter Id Number, Voter ID, EPIC, EPIC No |
| `state` | State |
| `district` | District |
| `dob` | Date of Birth, DOB, Birth Date |

Dates may be `YYYY-MM-DD`, `DD-MM-YYYY` or `DD/MM/YYYY` and are stored as ISO. Impossible dates are rejected, not silently corrected. Voter IDs are uppercased with spaces and dashes stripped, so `asm-123 4567` and `ASM1234567` are the same record.

The importer reports duplicate voter IDs, missing names and unreadable dates before it finishes. It writes the file either way, so fix the reported rows and run it again.

`data/voters.sample.json` shows the expected shape. To hand-edit instead, write `data/voters.json` directly — no restart needed, the file is read per request.

## Ticket delivery

Tickets go to the address in `TICKET_INBOX`. That value lives in `.env` on the server and never reaches the browser: it is not in any page, any API response, or any client-side file. Server logs mask it.

`MAIL_DRY_RUN=true` skips SMTP and writes each message to `outbox/` so the form can be tested before mail is configured. Set it to `false` for live delivery.

Gmail needs an **App Password** (Google Account → Security → App passwords), not your normal account password.

## Layout

```
server.js              Express app, security middleware, page routes
routes/
  auth.js              register, login, logout, session
  voters.js            roll listing, filters, single lookup
  card.js              three-field verification, PDF download
  vote.js              lookup, ballot, cast, tally
  tickets.js           multipart upload, mail, storage
utils/
  store.js             atomic JSON file store
  validate.js          normalisation and validation helpers
  mailer.js            ticket email composition and delivery
  voterCardPdf.js      voter card PDF drawing
middleware/auth.js     JWT cookie sessions and route guards
public/                pages, stylesheet, page scripts
data/                  JSON data files
scripts/               import-voters.js
```

## Data store

`utils/store.js` is a small JSON-file store. Writes go to a temp file and are renamed over the target, so a crash mid-write cannot leave a truncated file, and writes are queued per file so concurrent requests do not clobber each other.

It is a development store, not a production database. Routes only ever call `read()` and `update()`, so moving to PostgreSQL or MongoDB means rewriting that one file.

## Security notes

- Passwords are bcrypt hashed at cost 12. Sign-in runs a hash comparison even when no account matches, so a missing account and a wrong password take the same time.
- Sessions are JWTs in `httpOnly`, `sameSite=strict` cookies. Set `NODE_ENV=production` to add the `secure` flag.
- Card download requires name, date of birth **and** voter ID to match. Matching on voter ID alone would let anyone print a card for any ID they can guess.
- Votes are stored against an HMAC fingerprint of the voter ID, not the ID itself. That blocks a second ballot while leaving no stored link between a person and their choice.
- Uploads are capped at 10 files of 10 MB, restricted to JPG, PNG, WEBP, HEIC and PDF, and written under generated filenames — the client filename is never used on disk.
- Rate limits apply to sign-in, card download, ballot actions and ticket submission.
- Helmet sets a content security policy that blocks inline scripts.

### Known gap

Portal accounts and voter IDs are not linked. Anyone signed in who knows a valid voter ID can cast that ballot. Binding the two at registration is the next hardening step.

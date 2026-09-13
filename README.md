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

## Face verification

A voter with a face on file must pass a camera check before their card is
released or their ballot is sealed.

### How it runs

1. The browser loads the face models and opens the camera.
2. It watches the stream. A reading is only taken once exactly one face has
   held still for six consecutive samples.
3. **If a second face appears at any point, the check stops.** There is no way
   to tell which person the camera is looking at, so the run is abandoned and
   has to be started again.
4. The 128-number descriptor is posted to the server, which compares it against
   the enrolled template and, on a match, issues a short-lived token.
5. That token is required by `POST /api/card/download` and `POST /api/vote/cast`.

The token is scoped to one voter ID and one action, so a token earned for a card
cannot be spent on a ballot. The check runs immediately before the action it
guards, so the token is only ever seconds old.

### Enrolling a face

Sign in and open **Enrol a face** from the dashboard, or go to `/enrol-face`.
Pick the voter ID and two or three clear, front-facing photographs with only
that person in frame. The pictures are read in the browser; only the resulting
measurements and one cropped portrait reach the server.

The portrait is printed in the photograph panel on the card. Voters with no
photograph on file keep the placeholder.

### Where the biometric data lives

| What | Where | In git? |
| --- | --- | --- |
| Face descriptors | `data/face-templates.json` | **No** |
| Card photographs | `data/faces/<voterId>.jpg` | **No** |

Both are in `.gitignore`. A descriptor cannot be turned back into a
photograph, but it still identifies a named person, so it stays on the machine
that enrolled it — this repository is public. Enrol on each machine that needs
the check; there is no import step by design.

`POST /api/face/forget` deletes a voter's template and photograph.

### Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `FACE_MATCH_THRESHOLD` | `0.5` | Maximum distance that still counts as a match. Lower is stricter. |
| `FACE_ENFORCE` | `enrolled` | `enrolled` challenges only voters with a face on file. `all` refuses a card or ballot to anyone not enrolled. |
| `FACE_TOKEN_TTL` | `300` | Seconds a passed check stays valid. |

`FACE_ENFORCE=enrolled` is the default so the roll stays usable while people are
enrolled one at a time. It does mean a voter who has never enrolled is not
challenged — switch to `all` once everyone on the roll has a face on file.

### What this is not

- **The descriptor is computed in the browser.** The server decides the match
  and owns the token, so the decision cannot be faked by editing the page — but
  a crafted request could post a descriptor that was never measured by a
  camera. Making that impossible means matching server-side against a video
  frame the client cannot choose.
- **There is no anti-spoof liveness check.** Holding a photograph up to the
  camera will pass. Defeating that needs blink, depth or challenge-response
  detection, none of which is implemented. The single-face rule stops a second
  *person* joining, not a printed picture.
- **False rejections are real.** Face matching is less accurate for some faces
  than others, and a gate on a ballot means a false reject is somebody unable
  to vote. Keep a manual route open.
- **Enrolment is not restricted to an administrator.** Any signed-in account can
  enrol or delete any voter's face, because the portal has no admin role yet.
  That is the most important gap to close before this is used for anything real.

## Layout

```
server.js              Express app, security middleware, page routes
routes/
  auth.js              register, login, logout, session
  voters.js            roll listing, filters, single lookup
  card.js              three-field verification, PDF download
  vote.js              lookup, ballot, cast, tally
  tickets.js           multipart upload, mail, storage
  face.js              face enrolment, verification, action tokens
utils/
  store.js             atomic JSON file store
  validate.js          normalisation and validation helpers
  mailer.js            ticket email composition and delivery
  voterCardPdf.js      voter card PDF drawing
  faceTemplates.js     descriptor storage, distance matching, card photos
  faceToken.js         short-lived proof that a face check passed
  imageCheck.js        PNG/JPEG validation before pdfkit sees an image
middleware/auth.js     JWT cookie sessions and route guards
public/                pages, stylesheet, page scripts
  js/face-verify.js    camera, single-face rule, descriptor capture
  js/face-gate.js      the dialog both guarded actions share
data/                  JSON data files (biometric files are gitignored)
tests/                 node:test suites and image fixtures
scripts/               import-voters.js
```

## Tests

```bash
npm test
```

Runs on the built-in `node:test` runner, no extra dependencies. Each suite that
needs a server boots one against its own temporary `DATA_DIR`, so the
repository's `data/` is never read or written and suites can run concurrently.

The face suites construct descriptors as plain arrays of 128 numbers, so no
camera or model weights are involved in testing the gate.

## Data store

`utils/store.js` is a small JSON-file store. Writes go to a temp file and are renamed over the target, so a crash mid-write cannot leave a truncated file, and writes are queued per file so concurrent requests do not clobber each other.

It is a development store, not a production database. Routes only ever call `read()` and `update()`, so moving to PostgreSQL or MongoDB means rewriting that one file.

## Security notes

- Passwords are bcrypt hashed at cost 12. Sign-in runs a hash comparison even when no account matches, so a missing account and a wrong password take the same time.
- Sessions are JWTs in `httpOnly`, `sameSite=strict` cookies. Set `NODE_ENV=production` to add the `secure` flag.
- Card download requires name, date of birth **and** voter ID to match. Matching on voter ID alone would let anyone print a card for any ID they can guess.
- Votes are stored against an HMAC fingerprint of the voter ID, not the ID itself. That blocks a second ballot while leaving no stored link between a person and their choice.
- Uploads are capped at 10 files of 10 MB, restricted to JPG, PNG, WEBP, HEIC and PDF, and written under generated filenames — the client filename is never used on disk.
- Rate limits apply to sign-in, card download, ballot actions, ticket submission, face checks and face enrolment.
- Helmet sets a content security policy that blocks inline scripts. Face matching needs `'wasm-unsafe-eval'` for TensorFlow's kernels; that permits WASM compilation, not `eval()` of JavaScript.
- A face check issues a signed token scoped to one voter ID and one action, valid for minutes. Neither guarded route accepts anything else as proof.
- Face descriptors are never returned by the API, so a caller cannot read a template back out to tune guesses against the distance threshold.
- Card photographs are structurally validated before they are stored. pdfkit's PNG decoder rethrows a bad deflate stream from inside a zlib callback, which cannot be caught at the call site and would take the process down on every download — so unreadable images are rejected at enrolment instead.

### Known gaps

- **Portal accounts and voter IDs are not linked.** Anyone signed in who knows a valid voter ID can cast that ballot, subject to the face check when one is enrolled. Binding the two at registration is the next hardening step.
- **There is no administrator role.** Any signed-in account can enrol or delete any voter's face. This is the most important gap to close before the face gate means anything.
- **Face descriptors are measured in the browser.** The server decides the match, but a crafted request can post a descriptor no camera produced. See *What this is not* above.

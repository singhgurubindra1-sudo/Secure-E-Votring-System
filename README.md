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
   Detections smaller than `FACE_MIN_SIZE` of the frame are ignored, so
   background clutter cannot falsely trip the second-person rule.
5. That token is required by `POST /api/card/download` and `POST /api/vote/cast`.

The token is scoped to one voter ID and one action, so a token earned for a card
cannot be spent on a ballot. The check runs immediately before the action it
guards, so the token is only ever seconds old.

### If the page says the library did not load

The matching library and its model weights are served straight out of
`node_modules` rather than committed, so **pulling new code is not enough — run
`npm install` and restart.** The server says which it is at startup:

```
  Face matching: ready
```

or, when it is not installed:

```
  Face matching: UNAVAILABLE

  The face matching library is not installed (@vladmandic/face-api is missing).
  Run "npm install" in the project folder, then restart the server.
```

`GET /api/face/assets` reports the same thing over HTTP.

### Enrolling a face

**No face is enrolled until an administrator does it, and until then no camera
check runs.** `data/face-templates.json` is not in the repository, so a fresh
clone has no faces on file. Both guarded pages say so plainly when the voter
has none — look for the amber "no camera check will run" notice.

Enrolment is an administrative action, not a voter-facing one: there is no
enrolment page in the portal. A signed-in session posts to
`POST /api/face/enrol` with the voter ID, one or more 128-value face
descriptors and an optional cropped portrait:

```json
{ "voterId": "PNB4521907", "descriptors": [[0.12, -0.04, ...]], "photo": "data:image/jpeg;base64,..." }
```

Descriptors are computed from photographs by the same face-api model the live
check uses, so the raw pictures never have to leave the machine that holds
them. The portrait is printed in the photograph panel on the card; voters with
no photograph on file keep the placeholder.

`npm run reset` keeps enrolled faces on purpose. Only `--faces` or `--all`
clears them, and that cannot be undone without enrolling again.

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
| `FACE_INPUT_SIZE` | `320` | Frame size the detector works at. Smaller is faster. |
| `FACE_SCORE_THRESHOLD` | `0.3` | How sure the detector must be it sees a face. Lower this if it keeps saying "no face found". |
| `FACE_STABLE_SAMPLES` | `2` | Consecutive single-face reads before the measurement. |
| `FACE_MIN_SIZE` | `0.15` | Smallest face, as a fraction of frame height, that counts as a person. |
| `FACE_CAPTURE_TIMEOUT` | `20000` | Milliseconds before the check gives up. |

The browser reads the detector settings from the server, so these can be
changed in `.env` and take effect on the next page load — no code edit.

### If the sign-in expires mid-check

The camera check no longer navigates away when the session runs out. The dialog
stays open with the reason and two options: **Sign in again**, which returns to
the same page afterwards, and **Try again**. The card and ballot pages report an
expired session inline with a sign-in link rather than bouncing.

An expired session and a face that does not match both answer HTTP 401, so the
session case is marked with <code>sessionExpired: true</code> to tell them apart.

### How long the check takes

The detector defaults were chosen by timing TinyFaceDetector over the six
sample faces that ship with the library:

| `inputSize` | Faces found | Time per pass (CPU) |
| --- | --- | --- |
| 224 @ 0.5 | 3 of 6 | 454 ms |
| 320 @ 0.3 | **6 of 6** | **959 ms** |
| 416 @ 0.5 | 6 of 6 | 1737 ms |

`416` was no more accurate than `320` and took nearly twice as long, and a
score threshold of `0.5` started missing faces outright — which is what a
headscarf, glasses or dim indoor light look like to the detector.

The camera and the models now open together. The detector and landmark
networks are about 540 KB and are all the detection loop needs; the recognition
network is 6.3 MB and is only awaited at the moment a descriptor is wanted.
Waiting for all three before asking for the camera left the panel blank for
over five seconds. Both guarded pages also start the downloads on load, and the
weights are served <code>immutable</code> with a 30-day cache, so the second
visit costs nothing. Pressing the button to a live camera measures about
**3.1 seconds** on a cold cache.

The check also makes two passes rather than three: a cheap small-input pass
counts faces until one holds steady, then one full pass measures it, and
because that pass asks for *all* faces it returns the count and the
measurement from the same frame. End to end that is about **2.7 seconds on a
CPU backend**, and less where WebGL is available.

If it still feels slow, lower `FACE_INPUT_SIZE` to `224` and
`FACE_STABLE_SAMPLES` to `1`. If it fails to see you, lower
`FACE_SCORE_THRESHOLD` to `0.2`.

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

## Look and feel

The portal is dressed as a public service rather than a product, in the idiom
that government sites have converged on: a banner that says what the site is
before anything else, a solid masthead with a seal, breadcrumbs, service cards
that state who each service is for and what it needs, and a footer that repeats
all of it. The palette is an official navy, with the flag's saffron and green
kept for the tricolour rule and the emblem and used nowhere else.

### Two 3D backdrops

Both are drawn in WebGL, and both are **procedural** — there are no model or
texture files anywhere in the repository. Everything is geometry plus
canvas-drawn textures, so the only downloaded asset is three.js itself.

**Sign-in: the monument hall.** A bronze memorial bust of Dr B. R. Ambedkar
stands on an inscribed marble plinth in a colonnade, with a ballot box beside
it and ballot papers turning slowly through the light. The page names the
figure and the clause beside it, because it is a real person and a real part
of the Constitution rather than decoration.

The bust is a **deliberate stylisation, not a portrait likeness.** It is built
the way a memorial reads at a distance — the swept-back hair over a high
forehead, the round spectacles, the suit and tie, the volume of the
Constitution at the plinth, the name cut into the stone. Two things were
learnt building it:

- A flat extruded silhouette cannot look sculpted. Its front face has one
  normal across the whole surface, so it shades evenly however it is lit and
  reads as a cut-out. The head is therefore real volume — cranium over jaw,
  brow ridge, nose — and it is that curvature which makes it look cast.
- A metal with no `scene.environment` is nearly black. `metalness` means
  "show me what is around you", and direct lights alone leave nothing to
  show. A painted equirectangular sketch of the room is what turns the
  material from plastic into bronze.

**After sign-in: the tricolour.** The national flag, at 3:2 with a 24-spoke
Ashoka Chakra, flying in bright open air, the cloth moved by two crossing
waves damped to nothing at the hoist. This one is pale on purpose: the working
screens carry forms, tables and a ballot, so the backdrop is light enough that
ordinary dark text sits on it unaided.

### Three things that matter as much as how it looks

- **The scene stops while the face check runs.** TensorFlow.js wants the same
  GPU, and the camera check is the part that has to stay quick. Measured: with
  the backdrop on, the page's own animation frames during a check drop from
  317 to 84, and the check itself is no slower.
- **It respects `prefers-reduced-motion`** — one still frame, no animation,
  no page transition.
- **It can be switched off**, from the button in the bottom corner, and the
  choice is remembered per browser. Every scene rule is scoped to
  `[data-scene="on"]`, so switching off — or a browser without WebGL — gets
  the flat design untouched and fully usable.

Panels over the sign-in hall become frosted glass and the headline gets a
scrim, because readability wins over atmosphere on a screen somebody has to
fill in.

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
  js/scene-core.js     renderer, render loop, opt-out, page transition
  js/scene-monument.js the Ambedkar monument hall behind sign-in
  js/scene-tricolour.js the flag flying behind every page after it
  js/scene-mount.js    picks the scene for the page and offers the switch
data/                  JSON data files (biometric files are gitignored)
tests/                 node:test suites and image fixtures
scripts/               import-voters.js, reset.js
```

## Resetting between tests

```bash
npm run reset              # ballots, accounts, tickets, uploads, dry-run mail
npm run reset -- --votes   # just the ballots, to vote again
npm run reset -- --faces   # just the enrolled faces and card photographs
npm run reset -- --all     # everything above, plus the electoral roll
```

The default run deliberately **keeps the roll and any enrolled face**, so
testing a second ballot does not mean enrolling again. `npm run reset --
--votes` is the one to use after hitting *"A vote has already been recorded for
this voter ID"*.

After `--all`, put the roll back with
`npm run import-voters -- data/voters.sample.json`.

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

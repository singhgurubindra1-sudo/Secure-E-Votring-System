import { $, $$, api, busy, mountSession, escapeHtml, setFieldError, clearFieldErrors, toast } from './app.js';
import { runFaceCheck } from './face-gate.js';
import { warmUp } from './face-verify.js';

mountSession();
warmUp();

const form = $('#lookupForm');
const errorBox = form.querySelector('[data-form-error]');

const credsDialog = $('#credsDialog');
const credsBody = $('#credsBody');
const credsWarning = $('#credsWarning');
const toBallot = $('#toBallot');

const ballotDialog = $('#ballotDialog');
const ballotBody = $('#ballotBody');
const castButton = $('#castVote');

const faceNotice = $('#faceNotice');
const receiptDialog = $('#receiptDialog');
const receiptBody = $('#receiptBody');

let current = null;      // the looked-up voter
let selectedId = null;   // chosen candidate
let faceRequired = false; // whether this voter has a face on file

$$('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

function rows(pairs) {
  return pairs
    .map(([key, value, cls = '']) => `<div><span class="k">${key}</span><span class="v ${cls}">${value}</span></div>`)
    .join('');
}

/** Step 1: look the voter up and open the credentials dialog. */
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldErrors(form);
  errorBox.hidden = true;

  const voterId = form.elements.voterId.value.trim().toUpperCase();
  const restore = busy(form.querySelector('button[type="submit"]'), 'Checking the roll');

  try {
    const data = await api('/api/vote/lookup', { method: 'POST', body: { voterId }, redirectOn401: false });
    current = data;
    faceRequired = Boolean(data.faceRequired);

    credsBody.innerHTML = rows([
      ['Name', escapeHtml(data.voter.name)],
      ['Date of birth', escapeHtml(data.voter.dobDisplay || data.voter.dob)],
      ['State', escapeHtml(data.voter.state)],
      ['District', escapeHtml(data.voter.district)],
      ['Voter ID number', escapeHtml(data.voter.voterId), 'epic'],
    ]);

    let warning = '';
    if (data.alreadyVoted) warning = 'A vote has already been recorded for this voter ID. A second ballot cannot be cast.';
    else if (!data.eligible) warning = 'This voter is under 18 and is not yet eligible to vote.';

    credsWarning.textContent = warning;
    credsWarning.hidden = !warning;
    toBallot.disabled = Boolean(warning);
    toBallot.textContent = warning ? 'Ballot unavailable' : 'Yes, continue to ballot';

    // Say which it is, rather than showing nothing when no face is on file.
    if (warning) {
      faceNotice.hidden = true;
    } else if (faceRequired) {
      faceNotice.className = 'notice notice--info';
      faceNotice.innerHTML =
        '<span>A camera face check runs before your ballot is sealed. Make sure you are alone in frame.</span>';
      faceNotice.hidden = false;
    } else {
      faceNotice.className = 'notice notice--warn';
      faceNotice.innerHTML =
        '<span>No reference photograph is on file for this voter ID, so ' +
        '<strong>no camera check will run</strong>. Raise a ticket if you expected one.</span>';
      faceNotice.hidden = false;
    }

    credsDialog.showModal();
  } catch (err) {
    if (err.sessionExpired) {
      const back = encodeURIComponent(location.pathname + location.search);
      errorBox.innerHTML =
        '<span>Your sign-in expired. <a href="/?next=' + back + '">Sign in again</a> to continue — ' +
        'you will come back to this page.</span>';
      errorBox.hidden = false;
    } else if (err.field) setFieldError(form, err.field, err.message);
    else { errorBox.textContent = err.message; errorBox.hidden = false; }
  } finally {
    restore();
  }
});

/** Step 2: load the ballot for the voter's district. */
toBallot.addEventListener('click', async () => {
  const restore = busy(toBallot, 'Opening ballot');
  try {
    const { candidates } = await api('/api/vote/ballot?district=' + encodeURIComponent(current.voter.district));

    if (!candidates.length) {
      toast('No candidates have been published for this district yet.', 'bad');
      return;
    }

    selectedId = null;
    castButton.disabled = true;
    ballotBody.innerHTML = candidates.map((candidate) => `
      <label class="ballot__row" style="border-bottom:1px solid var(--line-soft);cursor:pointer;grid-template-columns:1fr auto;padding:14px 4px">
        <span class="ballot__body">
          <h3 style="font-size:15.5px">${escapeHtml(candidate.name)}</h3>
          <p>${escapeHtml(candidate.party)}${candidate.symbol ? ` &middot; ${escapeHtml(candidate.symbol)}` : ''}</p>
        </span>
        <input type="radio" name="candidate" value="${escapeHtml(candidate.id)}" style="width:20px;height:20px;accent-color:var(--ink-violet)">
      </label>`).join('');

    credsDialog.close();
    ballotDialog.showModal();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    restore();
  }
});

ballotBody.addEventListener('change', (event) => {
  if (event.target.name === 'candidate') {
    selectedId = event.target.value;
    castButton.disabled = false;
  }
});

/** Step 3: cast the vote and show the receipt. */
castButton.addEventListener('click', async () => {
  if (!selectedId) return;

  let faceToken = null;
  if (faceRequired) {
    try {
      faceToken = await runFaceCheck({ voterId: current.voter.voterId, purpose: 'ballot' });
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
  }

  const restore = busy(castButton, 'Sealing ballot');

  try {
    const data = await api('/api/vote/cast', {
      method: 'POST',
      body: { voterId: current.voter.voterId, candidateId: selectedId, faceToken },
    });

    receiptBody.innerHTML = rows([
      ['Receipt code', escapeHtml(data.receipt), 'epic'],
      ['Recorded at', escapeHtml(new Date(data.castAt).toLocaleString())],
      ['Constituency', escapeHtml(current.voter.district)],
      ['Status', '<span class="pill pill--good">Counted</span>'],
    ]);

    ballotDialog.close();
    receiptDialog.showModal();
    form.reset();
    current = null;
    faceRequired = false;
  } catch (err) {
    toast(err.message, 'bad');
    restore();
    return;
  }
  restore();
});

import { $, api, busy, mountSession, escapeHtml, setFieldError, clearFieldErrors, toast } from './app.js';
import { runFaceCheck } from './face-gate.js';
import { warmUp } from './face-verify.js';

mountSession();
warmUp();

let faceRequired = false;

const form = $('#cardForm');
const faceState = $('#faceState');
const preview = $('#preview');
const previewBody = $('#previewBody');
const errorBox = form.querySelector('[data-form-error]');
const okBox = form.querySelector('[data-form-ok]');

/**
 * Spells out the face-check state. Without this a voter with no reference
 * photograph on file just gets a card with no camera step and no idea why.
 */
function showFaceState(data) {
  if (data === null) {
    faceState.hidden = true;
    return;
  }
  if (data.faceRequired) {
    faceState.className = 'notice notice--info';
    faceState.innerHTML =
      '<span>A camera face check runs before the card is released. Make sure you are alone in frame.</span>';
  } else {
    faceState.className = 'notice notice--warn';
    faceState.innerHTML =
      '<span>No reference photograph is on file for this voter ID, so ' +
      '<strong>no camera check will run</strong>. Raise a ticket if you expected one.</span>';
  }
  faceState.hidden = false;
}

function notify({ error = '', success = '' } = {}) {
  // textContent, so a message can never inject markup; handleError sets
  // innerHTML itself for the one case that needs a link.
  errorBox.textContent = error;
  errorBox.hidden = !error;
  okBox.textContent = success;
  okBox.hidden = !success;
}

function payload() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.voterId = String(data.voterId || '').trim().toUpperCase();
  data.name = String(data.name || '').trim();
  return data;
}

function showPreview(voter) {
  previewBody.innerHTML = [
    ['Name', escapeHtml(voter.name), ''],
    ['Date of birth', escapeHtml(voter.dobDisplay || voter.dob), ''],
    ['Voter ID number', escapeHtml(voter.voterId), 'epic'],
    ['State', escapeHtml(voter.state), ''],
    ['District', escapeHtml(voter.district), ''],
  ].map(([key, value, cls]) => `<div><span class="k">${key}</span><span class="v ${cls}">${value}</span></div>`).join('');
  preview.hidden = false;
}

function handleError(err) {
  preview.hidden = true;
  showFaceState(null);

  if (err.sessionExpired) {
    const back = encodeURIComponent(location.pathname + location.search);
    errorBox.innerHTML =
      '<span>Your sign-in expired. <a href="/?next=' + back + '">Sign in again</a> to continue — ' +
      'you will come back to this page.</span>';
    errorBox.hidden = false;
    okBox.hidden = true;
    return;
  }
  if (err.field) {
    setFieldError(form, err.field, err.message);
    notify();
  } else {
    notify({ error: err.message });
  }
}

$('#verify').addEventListener('click', async (event) => {
  clearFieldErrors(form);
  notify();
  const restore = busy(event.currentTarget, 'Checking');
  try {
    const data = await api('/api/card/verify', { method: 'POST', body: payload(), redirectOn401: false });
    faceRequired = Boolean(data.faceRequired);
    showPreview(data.voter);
    showFaceState(data);
    notify({ success: 'Details match the roll. You can download the card.' });
  } catch (err) {
    handleError(err);
  } finally {
    restore();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldErrors(form);
  notify();

  const button = $('#download');
  const body = payload();

  // Ask the server whether a face check is due rather than trusting a flag set
  // by an earlier click -- the voter may have come straight here.
  let restore = busy(button, 'Checking details');
  try {
    const check = await api('/api/card/verify', { method: 'POST', body, redirectOn401: false });
    faceRequired = Boolean(check.faceRequired);
    showPreview(check.voter);
    showFaceState(check);
  } catch (err) {
    restore();
    handleError(err);
    return;
  }
  restore();

  if (faceRequired) {
    try {
      body.faceToken = await runFaceCheck({ voterId: body.voterId, purpose: 'card' });
    } catch (err) {
      notify({ error: err.message });
      return;
    }
  }

  restore = busy(button, 'Preparing PDF');

  try {
    const response = await api('/api/card/download', { method: 'POST', body, raw: true });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || 'The card could not be produced.'), { field: data.field });
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voter-card-${body.voterId}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    notify({ success: 'Voter card downloaded.' });
    toast('Voter card downloaded', 'good');
  } catch (err) {
    handleError(err);
  } finally {
    restore();
  }
});

form.addEventListener('input', () => {
  preview.hidden = true;
  faceRequired = false;
  showFaceState(null);
  notify();
});

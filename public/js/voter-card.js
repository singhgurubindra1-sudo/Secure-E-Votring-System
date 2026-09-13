import { $, api, busy, mountSession, escapeHtml, setFieldError, clearFieldErrors, toast } from './app.js';

mountSession();

const form = $('#cardForm');
const preview = $('#preview');
const previewBody = $('#previewBody');
const errorBox = form.querySelector('[data-form-error]');
const okBox = form.querySelector('[data-form-ok]');

function notify({ error = '', success = '' } = {}) {
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
    const { voter } = await api('/api/card/verify', { method: 'POST', body: payload() });
    showPreview(voter);
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
  const restore = busy(button, 'Preparing PDF');

  try {
    const response = await api('/api/card/download', { method: 'POST', body: payload(), raw: true });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || 'The card could not be produced.'), { field: data.field });
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voter-card-${payload().voterId}.pdf`;
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

form.addEventListener('input', () => { preview.hidden = true; notify(); });

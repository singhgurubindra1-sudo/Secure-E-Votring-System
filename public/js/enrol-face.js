import { $, api, busy, mountSession, escapeHtml, setFieldError, clearFieldErrors, toast } from './app.js';
import { describeImageFile, cropFace, ensureLibrary } from './face-verify.js';

mountSession();

const form = $('#enrolForm');
const fileInput = $('#e-photos');
const voterInput = $('#e-voterId');
const results = $('#results');
const enrolBtn = $('#enrolBtn');
const forgetBtn = $('#forgetBtn');
const statusPanel = $('#statusPanel');
const statusBody = $('#statusBody');
const errorBox = form.querySelector('[data-form-error]');
const okBox = form.querySelector('[data-form-ok]');

// Descriptors for the photographs that read cleanly, plus the portrait that
// will be printed on the card.
let staged = [];
let cardPhoto = null;

function notify({ error = '', success = '' } = {}) {
  errorBox.textContent = error;
  errorBox.hidden = !error;
  okBox.textContent = success;
  okBox.hidden = !success;
}

function voterId() {
  return voterInput.value.trim().toUpperCase().replace(/[\s-]/g, '');
}

async function refreshStatus() {
  const id = voterId();
  if (!id) {
    statusPanel.hidden = true;
    return;
  }
  try {
    const data = await api('/api/face/status?voterId=' + encodeURIComponent(id));
    statusBody.innerHTML = [
      ['Voter ID', escapeHtml(data.voterId), 'epic'],
      ['Face on file', data.enrolled ? 'Yes' : 'No', ''],
      ['Check required', data.required ? 'Yes' : 'No', ''],
      ['Enforcement', escapeHtml(data.enforcement), ''],
    ]
      .map(([k, v, cls]) => `<div><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`)
      .join('');
    statusPanel.hidden = false;
  } catch {
    statusPanel.hidden = true;
  }
}

fileInput.addEventListener('change', async () => {
  clearFieldErrors(form);
  notify();
  staged = [];
  cardPhoto = null;
  results.innerHTML = '';
  results.hidden = true;
  enrolBtn.disabled = true;

  const files = [...fileInput.files].slice(0, 8);
  if (!files.length) return;

  // Fail once, clearly, rather than repeating the same error per photograph.
  try {
    await ensureLibrary();
  } catch (err) {
    notify({ error: err.message });
    return;
  }

  results.hidden = false;
  const restore = busy(enrolBtn, 'Reading photographs');

  // Read them one at a time; the models are heavy and parallel runs thrash.
  for (const file of files) {
    const figure = document.createElement('figure');
    figure.className = 'enrol__card';
    figure.innerHTML = `<img alt="">
      <figcaption>${escapeHtml(file.name)}<br>reading…</figcaption>`;
    results.appendChild(figure);

    const preview = URL.createObjectURL(file);
    figure.querySelector('img').src = preview;

    try {
      const outcome = await describeImageFile(file);
      if (outcome.ok) {
        staged.push(outcome.descriptor);
        if (!cardPhoto) cardPhoto = cropFace(outcome.image, outcome.box);
        figure.classList.add('enrol__card--ok');
        figure.querySelector('figcaption').innerHTML = `${escapeHtml(file.name)}<br>face read`;
      } else {
        figure.classList.add('enrol__card--bad');
        figure.querySelector('figcaption').innerHTML = `${escapeHtml(file.name)}<br>${escapeHtml(outcome.reason)}`;
      }
    } catch (err) {
      figure.classList.add('enrol__card--bad');
      figure.querySelector('figcaption').innerHTML = `${escapeHtml(file.name)}<br>${escapeHtml(err.message)}`;
    }
  }

  restore();
  enrolBtn.disabled = staged.length === 0;

  if (!staged.length) {
    setFieldError(form, 'photos', 'No face could be read. Use clear, front-facing pictures of one person.');
  } else {
    notify({ success: `${staged.length} of ${files.length} photograph(s) read. Ready to enrol.` });
  }
});

voterInput.addEventListener('change', refreshStatus);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldErrors(form);
  notify();

  if (!voterId()) {
    setFieldError(form, 'voterId', 'Enter the voter ID number.');
    return;
  }
  if (!staged.length) {
    setFieldError(form, 'photos', 'Choose photographs first.');
    return;
  }

  const restore = busy(enrolBtn, 'Enrolling');
  try {
    const data = await api('/api/face/enrol', {
      method: 'POST',
      body: { voterId: voterId(), descriptors: staged, photo: cardPhoto },
    });
    notify({ success: data.message });
    toast('Face enrolled', 'good');
    await refreshStatus();
  } catch (err) {
    if (err.field) setFieldError(form, err.field, err.message);
    else notify({ error: err.message });
  } finally {
    restore();
  }
});

forgetBtn.addEventListener('click', async () => {
  clearFieldErrors(form);
  notify();
  if (!voterId()) {
    setFieldError(form, 'voterId', 'Enter the voter ID number.');
    return;
  }

  const restore = busy(forgetBtn, 'Deleting');
  try {
    const data = await api('/api/face/forget', { method: 'POST', body: { voterId: voterId() } });
    notify({ success: data.message });
    await refreshStatus();
  } catch (err) {
    notify({ error: err.message });
  } finally {
    restore();
  }
});

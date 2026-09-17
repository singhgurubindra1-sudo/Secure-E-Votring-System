import { $, api, busy, mountSession, escapeHtml, formatBytes, setFieldError, clearFieldErrors, toast } from './app.js';

mountSession();

const form = $('#ticketForm');
const dropzone = $('#dropzone');
const fileInput = $('#t-files');
const filelist = $('#filelist');
const issue = $('#t-issue');
const issueCount = $('#issueCount');
const errorBox = form.querySelector('[data-form-error]');
const okBox = form.querySelector('[data-form-ok]');
const mine = $('#mine');
const mineBody = $('#mineBody');

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

/** Files are held here rather than in the input, so individual ones can be removed. */
let chosen = [];

function notify({ error = '', success = '' } = {}) {
  errorBox.textContent = error;
  errorBox.hidden = !error;
  okBox.textContent = success;
  okBox.hidden = !success;
}

function renderFiles() {
  filelist.innerHTML = chosen.map((file, index) => {
    const isImage = file.type.startsWith('image/');
    const thumb = isImage
      ? `<img src="${URL.createObjectURL(file)}" alt="">`
      : `<span class="thumb">PDF</span>`;
    return `<li>
      ${thumb}
      <span class="meta">
        <b>${escapeHtml(file.name)}</b>
        <span>${formatBytes(file.size)}</span>
      </span>
      <button type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </li>`;
  }).join('');
}

function addFiles(files) {
  setFieldError(form, 'attachments', '');
  const rejected = [];

  for (const file of files) {
    if (chosen.length >= MAX_FILES) { rejected.push(`${file.name} (over the ${MAX_FILES}-file limit)`); continue; }
    if (!ALLOWED.includes(file.type)) { rejected.push(`${file.name} (unsupported type)`); continue; }
    if (file.size > MAX_BYTES) { rejected.push(`${file.name} (over 10 MB)`); continue; }
    if (chosen.some((f) => f.name === file.name && f.size === file.size)) continue;
    chosen.push(file);
  }

  renderFiles();
  if (rejected.length) {
    const box = form.querySelector('[data-error-for="attachments"]');
    box.textContent = `Skipped: ${rejected.join(', ')}`;
    box.classList.add('is-shown');
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});

['dragenter', 'dragover'].forEach((type) => {
  dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('is-over'); });
});
['dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('is-over'); });
});

dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

filelist.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  chosen.splice(Number(button.dataset.remove), 1);
  renderFiles();
});

issue.addEventListener('input', () => { issueCount.textContent = issue.value.length; });

form.addEventListener('reset', () => {
  setTimeout(() => {
    chosen = [];
    renderFiles();
    clearFieldErrors(form);
    notify();
    issueCount.textContent = '0';
  }, 0);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldErrors(form);
  notify();

  const data = new FormData();
  data.append('name', form.elements.name.value.trim());
  data.append('phone', form.elements.phone.value.trim());
  data.append('email', form.elements.email.value.trim());
  data.append('category', form.elements.category.value);
  data.append('issue', form.elements.issue.value.trim());
  chosen.forEach((file) => data.append('attachments', file, file.name));

  const restore = busy(form.querySelector('button[type="submit"]'), 'Sending');

  try {
    const result = await api('/api/tickets', { method: 'POST', body: data });
    form.reset();
    chosen = [];
    renderFiles();
    issueCount.textContent = '0';
    notify({ success: `Ticket ${result.reference} sent. Support will reply to your email address.` });
    toast(`Ticket ${result.reference} sent`, 'good');
    loadMine();
  } catch (err) {
    if (err.field) setFieldError(form, err.field, err.message);
    else notify({ error: err.message });
  } finally {
    restore();
  }
});

async function loadMine() {
  try {
    const { tickets } = await api('/api/tickets/mine');
    if (!tickets.length) { mine.hidden = true; return; }

    mineBody.innerHTML = tickets.slice(0, 5).map((ticket) => `
      <div style="display:flex;gap:14px;justify-content:space-between;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line-soft)">
        <div style="min-width:0">
          <div style="font-family:var(--mono);font-size:13px;color:var(--gov)">${escapeHtml(ticket.reference)}</div>
          <div style="font-size:13.5px;color:var(--muted);margin-top:2px">${escapeHtml(ticket.issue)}${ticket.issue.length >= 160 ? '…' : ''}</div>
        </div>
        <span class="pill pill--good" style="flex:none">${escapeHtml(ticket.status)}</span>
      </div>`).join('');
    mine.hidden = false;
  } catch {
    mine.hidden = true;
  }
}

loadMine();

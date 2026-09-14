/* Shared helpers used by every page. */

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/**
 * JSON request wrapper. Bounces to sign-in when the session has expired,
 * unless the caller passes redirectOn401: false -- a page in the middle of
 * something (the camera check) would rather report it than be yanked away.
 */
export async function api(path, { method = 'GET', body, raw = false, redirectOn401 = true } = {}) {
  const options = { method, headers: {}, credentials: 'same-origin' };

  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);

  if (response.status === 401 && redirectOn401 && !location.pathname.startsWith('/?')) {
    location.href = '/?next=' + encodeURIComponent(location.pathname);
    throw new Error('Session ended');
  }

  if (raw) return response;

  let data = {};
  try { data = await response.json(); } catch { /* empty body */ }

  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || 'Something went wrong. Try again.');
    error.field = data.field;
    error.status = response.status;
    error.sessionExpired = Boolean(data.sessionExpired);
    throw error;
  }
  return data;
}

/** Brief message at the bottom of the screen. */
export function toast(message, tone = '') {
  $$('.toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (tone ? ` toast--${tone}` : '');
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

/** Show an inline error under the input named `field`. */
export function setFieldError(form, field, message) {
  const input = form.elements[field];
  const box = form.querySelector(`[data-error-for="${field}"]`);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (box) {
    box.textContent = message || '';
    box.classList.toggle('is-shown', Boolean(message));
  }
  if (message && input) input.focus();
}

export function clearFieldErrors(form) {
  $$('[data-error-for]', form).forEach((box) => {
    box.textContent = '';
    box.classList.remove('is-shown');
  });
  $$('[aria-invalid]', form).forEach((input) => input.setAttribute('aria-invalid', 'false'));
}

/** Swap a button into a loading state and return a restore function. */
export function busy(button, label = 'Working') {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin" aria-hidden="true"></span>${label}`;
  return () => { button.disabled = false; button.innerHTML = original; };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Wrap query matches in <mark> so search hits are obvious in the table. */
export function highlight(text, query) {
  const safe = escapeHtml(text);
  const needle = String(query || '').trim();
  if (!needle) return safe;
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(pattern, 'gi'), (hit) => `<mark>${hit}</mark>`);
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Fill the header with the signed-in name and wire the sign-out button. */
export async function mountSession() {
  const slot = $('[data-session-name]');
  const signOut = $('[data-signout]');

  try {
    const { user } = await api('/api/auth/me');
    if (slot) slot.textContent = user.name;
  } catch { /* the api helper already redirected */ }

  if (signOut) {
    signOut.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/';
    });
  }
}

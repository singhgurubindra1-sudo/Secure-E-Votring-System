import { $, $$, api, busy, setFieldError, clearFieldErrors } from './app.js';

const panels = {
  'tab-signin': $('#panel-signin'),
  'tab-register': $('#panel-register'),
};

function activate(tabId) {
  $$('[role="tab"]').forEach((tab) => {
    const selected = tab.id === tabId;
    tab.setAttribute('aria-selected', String(selected));
    panels[tab.id].hidden = !selected;
  });
  const first = panels[tabId].querySelector('input');
  if (first) first.focus();
}

$$('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => activate(tab.id)));

function showFormError(form, message) {
  const box = form.querySelector('[data-form-error]');
  box.textContent = message;
  box.hidden = !message;
}

/** Where to land after signing in. Only same-origin paths are honoured. */
function nextPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function wire(form, endpoint, label) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    showFormError(form, '');

    const payload = Object.fromEntries(new FormData(form).entries());
    const restore = busy(form.querySelector('button[type="submit"]'), label);

    try {
      await api(endpoint, { method: 'POST', body: payload });
      location.href = nextPath();
    } catch (err) {
      restore();
      if (err.field) setFieldError(form, err.field, err.message);
      else showFormError(form, err.message);
    }
  });
}

wire(panels['tab-signin'], '/api/auth/login', 'Signing in');
wire(panels['tab-register'], '/api/auth/register', 'Creating account');

if (new URLSearchParams(location.search).get('new') === '1') activate('tab-register');

/**
 * Puts the forest on a page and offers the switch that turns it off.
 *
 * Loaded by every page, so the backdrop and the fly-through between pages are
 * consistent. The interior pages run a thinner forest than the sign-in page:
 * there is a form to read in front of them.
 */

import { mountForest, forestEnabled, setForestEnabled } from './forest.js';

const isSignIn = location.pathname === '/' || location.pathname === '/index.html';

const forest = mountForest({
  // The sign-in page is the shop window; the rest is working screens.
  density: isSignIn ? 1 : 0.6,
  transitions: true,
});

// The switch is offered whether or not the forest is currently on, so it can
// be turned back on again.
const button = document.createElement('button');
button.type = 'button';
button.className = 'forest-toggle';
button.id = 'forestToggle';

function label() {
  button.textContent = forestEnabled() ? 'Forest on' : 'Forest off';
  button.setAttribute('aria-pressed', String(forestEnabled()));
}

label();
button.addEventListener('click', () => {
  setForestEnabled(!forestEnabled());
  if (forest) forest.stop();
  // A reload is the honest way to swap it: the panels restyle wholesale.
  location.reload();
});

document.body.appendChild(button);

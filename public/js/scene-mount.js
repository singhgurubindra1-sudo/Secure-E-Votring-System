/**
 * Picks the backdrop for the page and offers the switch that turns it off.
 *
 * Sign-in gets the monument hall; everything behind the session gets the
 * bright tricolour. Both are loaded lazily so a page never downloads the
 * scene it does not use.
 */

import { mountScene, sceneEnabled, setSceneEnabled } from './scene-core.js';

const isSignIn = location.pathname === '/' || location.pathname === '/index.html';
const root = document.documentElement;

// Claimed up front rather than after three.js arrives. The build is a couple
// of megabytes; waiting for it would show the flat theme first and then
// restyle every panel on the page, which reads as a fault. If anything below
// fails this is set straight back to 'off'.
root.dataset.sceneName = isSignIn ? 'monument' : 'tricolour';
if (sceneEnabled()) root.dataset.scene = 'on';

(async () => {
  if (!sceneEnabled()) {
    root.dataset.scene = 'off';
    return;
  }

  let view = null;
  try {
    const module = isSignIn
      ? await import('./scene-monument.js')
      : await import('./scene-tricolour.js');

    view = mountScene(module, {
      name: isSignIn ? 'monument' : 'tricolour',
      // The hall is the shop window and can afford a heavier look; the working
      // screens keep the camera still enough to read a table against.
      exposure: isSignIn ? 1.05 : 1,
      parallax: isSignIn ? 0.62 : 0.3,
      transitions: true,
    });
  } catch (err) {
    // A missing three.js build, or a browser without WebGL, must leave a
    // perfectly usable flat page rather than a blank canvas.
    root.dataset.scene = 'off';
    console.warn('3D backdrop unavailable:', err && err.message);
    return;
  }

  if (!view) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scene-toggle';
  button.id = 'sceneToggle';

  const label = () => {
    button.textContent = sceneEnabled() ? '3D view on' : '3D view off';
    button.setAttribute('aria-pressed', String(sceneEnabled()));
  };

  label();
  button.addEventListener('click', () => {
    setSceneEnabled(!sceneEnabled());
    view.stop();
    // A reload is the honest way to swap it: the panels restyle wholesale.
    location.reload();
  });

  document.body.appendChild(button);
})();

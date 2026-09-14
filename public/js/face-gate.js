import { $, api } from './app.js';
import { createFaceSession } from './face-verify.js';

/**
 * Drives the face dialog that both the card download and the ballot use.
 *
 * Resolves with the short-lived token the server issues on a match, or rejects
 * with a message fit to show the voter. The check runs immediately before the
 * action it guards, so the token is only ever seconds old when it is spent.
 */

const DONE_TEXT = {
  card: 'Face verified — preparing your card…',
  ballot: 'Face verified — sealing your ballot…',
};

export function runFaceCheck({ voterId, purpose }) {
  const dialog = $('#faceDialog');
  const box = $('#facecheck');
  const text = $('#faceStatusText');
  const video = $('#faceVideo');
  const cancelBtn = $('#faceCancel');
  const retryBtn = $('#faceRetry');
  const signInBtn = $('#faceSignIn');

  if (!dialog || !video) {
    return Promise.reject(new Error('The face check dialog is missing from this page.'));
  }

  return new Promise((resolve, reject) => {
    let session = null;
    let settled = false;

    const setState = (state, message) => {
      box.dataset.state = state;
      if (message) text.textContent = message;
    };

    function teardown() {
      cancelBtn.removeEventListener('click', onCancel);
      retryBtn.removeEventListener('click', onRetry);
      if (signInBtn) signInBtn.removeEventListener('click', onSignIn);
      dialog.removeEventListener('cancel', onCancel);
      if (session) session.stop();
      session = null;
      if (dialog.open) dialog.close();
    }

    function finish(token) {
      if (settled) return;
      settled = true;
      teardown();
      resolve(token);
    }

    function fail(message) {
      if (settled) return;
      settled = true;
      teardown();
      reject(new Error(message));
    }

    function onCancel(event) {
      if (event) event.preventDefault();
      fail('Face verification was cancelled, so nothing was released.');
    }

    function onRetry() {
      retryBtn.hidden = true;
      if (signInBtn) signInBtn.hidden = true;
      if (session) session.stop();
      session = null;
      attempt();
    }

    /** Comes back to this page rather than dumping the voter on the dashboard. */
    function onSignIn() {
      const back = location.pathname + location.search;
      if (session) session.stop();
      location.href = '/?next=' + encodeURIComponent(back);
    }

    async function attempt() {
      setState('loading', 'Loading face matching models…');
      session = createFaceSession({
        video,
        onStatus: ({ state, message }) => setState(state, message),
      });

      try {
        await session.start();
        const descriptor = await session.capture();

        setState('reading', 'Checking against the photograph on file…');
        const result = await api('/api/face/verify', {
          method: 'POST',
          body: { voterId, descriptor, purpose },
          // Handle an expired session here instead of being navigated away
          // with the camera still open.
          redirectOn401: false,
        });

        // No face on file: the server is not gating this voter, so there is
        // nothing to prove and no token to carry.
        if (!result.enrolled) {
          finish(null);
          return;
        }

        setState('matched', DONE_TEXT[purpose] || 'Face verified…');
        // Let the confirmation land before the dialog disappears.
        setTimeout(() => finish(result.token), 450);
      } catch (err) {
        if (session) session.stop();

        if (err.sessionExpired) {
          // Signing in again is the only thing that helps, but the camera
          // check is left on screen so the voter keeps their place.
          setState('failed', 'Your sign-in expired while the camera was open. Sign in again to finish, or try the check once more.');
          if (signInBtn) signInBtn.hidden = false;
          retryBtn.hidden = false;
          return;
        }

        // A wrong face or a second person is worth another try; a missing
        // camera is not, but offering the button costs nothing.
        setState(box.dataset.state === 'aborted' ? 'aborted' : 'failed', err.message);
        retryBtn.hidden = false;
      }
    }

    cancelBtn.addEventListener('click', onCancel);
    retryBtn.addEventListener('click', onRetry);
    if (signInBtn) signInBtn.addEventListener('click', onSignIn);
    dialog.addEventListener('cancel', onCancel);

    retryBtn.hidden = true;
    if (signInBtn) signInBtn.hidden = true;
    setState('idle', 'Starting the camera…');
    dialog.showModal();
    attempt();
  });
}

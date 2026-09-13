import { $, api } from './app.js';
import { createFaceSession } from './face-verify.js';

/**
 * Drives the face dialog that both the card download and the ballot use.
 *
 * Resolves with the short-lived token the server issues on a match, or rejects
 * with a message fit to show the voter. The check runs immediately before the
 * action it guards, so the token is only ever seconds old when it is spent.
 */

const LABELS = {
  card: 'the card can be downloaded',
  ballot: 'the ballot can be cast',
};

export function runFaceCheck({ voterId, purpose }) {
  const dialog = $('#faceDialog');
  const box = $('#facecheck');
  const text = $('#faceStatusText');
  const video = $('#faceVideo');
  const cancelBtn = $('#faceCancel');
  const retryBtn = $('#faceRetry');

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
      if (session) session.stop();
      session = null;
      attempt();
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
        });

        // No face on file: the server is not gating this voter, so there is
        // nothing to prove and no token to carry.
        if (!result.enrolled) {
          finish(null);
          return;
        }

        setState('matched', `Face verified. Releasing ${LABELS[purpose] || 'the action'}…`);
        // Let the confirmation land before the dialog disappears.
        setTimeout(() => finish(result.token), 450);
      } catch (err) {
        // A wrong face or a second person is worth another try; a missing
        // camera is not, but offering the button costs nothing.
        setState(box.dataset.state === 'aborted' ? 'aborted' : 'failed', err.message);
        retryBtn.hidden = false;
      }
    }

    cancelBtn.addEventListener('click', onCancel);
    retryBtn.addEventListener('click', onRetry);
    dialog.addEventListener('cancel', onCancel);

    retryBtn.hidden = true;
    setState('idle', 'Starting the camera…');
    dialog.showModal();
    attempt();
  });
}

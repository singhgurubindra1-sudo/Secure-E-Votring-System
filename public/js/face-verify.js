/**
 * Camera face check, shared by the voter card and the ballot.
 *
 * The flow is: ask for the camera, load the matching models, then watch the
 * stream. A reading is only taken once exactly one face has held still in
 * frame for several consecutive samples. If a second face appears at any point
 * -- before or after the reading -- the run is abandoned immediately and has to
 * be started again, because there is no way to tell which person the camera is
 * actually looking at.
 *
 * The descriptor computed here is sent to the server, which owns the decision.
 * Nothing in this file can grant access on its own.
 */

const MODEL_URL = '/models';
const DETECTOR = { inputSize: 416, scoreThreshold: 0.5 };

// Consecutive single-face samples required before a reading is taken. At the
// sample interval below this is a little under a second of a steady frame.
const STABLE_SAMPLES = 6;
const SAMPLE_MS = 140;
const CAPTURE_TIMEOUT_MS = 30000;

let modelsPromise = null;
let backendPromise = null;

function faceapi() {
  if (!window.faceapi) {
    throw new Error('The face matching library did not load. Reload the page and try again.');
  }
  return window.faceapi;
}

/**
 * Picks a TensorFlow backend before any model is touched.
 *
 * The bundled build registers a WASM backend at the highest priority but does
 * not ship the .wasm binaries alongside it, so leaving the choice to
 * tf.ready() fails with "backend 'wasm' has not yet been initialized". WebGL is
 * the fast path in a real browser; CPU is the slow but dependable fallback.
 */
function initBackend() {
  if (backendPromise) return backendPromise;
  const tf = faceapi().tf;

  backendPromise = (async () => {
    for (const name of ['webgl', 'cpu']) {
      try {
        if (await tf.setBackend(name)) {
          await tf.ready();
          return name;
        }
      } catch {
        // Try the next one.
      }
    }
    throw new Error('This browser has no usable graphics backend for face matching.');
  })().catch((err) => {
    backendPromise = null;
    throw err;
  });

  return backendPromise;
}

/** Loaded once per page and shared by every run. */
function loadModels() {
  if (modelsPromise) return modelsPromise;
  const api = faceapi();
  modelsPromise = initBackend().then(() => Promise.all([
    api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    api.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ])).catch((err) => {
    modelsPromise = null;
    throw new Error('The face matching models could not be loaded. ' + (err.message || ''));
  });
  return modelsPromise;
}

function cameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow the camera for this site, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is already in use by another application. Close it and try again.';
  }
  if (name === 'OverconstrainedError') {
    return 'This camera cannot provide a usable video size.';
  }
  return 'The camera could not be started. ' + ((err && err.message) || '');
}

/**
 * A live face session bound to one <video> element.
 * Callers drive it: start() -> capture() -> stop().
 */
export function createFaceSession({ video, onStatus = () => {} }) {
  let stream = null;
  let watching = false;
  let abortReason = null;

  const status = (state, message) => onStatus({ state, message });

  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot open a camera. Try a recent Chrome, Edge, Firefox or Safari.');
    }

    status('loading', 'Loading face matching models…');
    await loadModels();

    status('camera', 'Waiting for camera permission…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      throw new Error(cameraError(err));
    }

    video.srcObject = stream;
    await video.play().catch(() => {});
    // A frame with zero dimensions cannot be detected against.
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
    }

    abortReason = null;
    status('ready', 'Centre your face in the frame.');
  }

  async function detectAll() {
    const api = faceapi();
    return api.detectAllFaces(video, new api.TinyFaceDetectorOptions(DETECTOR));
  }

  /**
   * Watches for a second person for as long as the caller needs it, and calls
   * onIntrusion once if one turns up. Used after a reading is taken so the
   * ballot cannot be cast with somebody else at the shoulder.
   */
  function watchForIntrusion(onIntrusion) {
    watching = true;
    (async () => {
      while (watching && stream) {
        try {
          const faces = await detectAll();
          if (!watching) return;
          if (faces.length > 1) {
            watching = false;
            abortReason = 'A second person appeared in the frame. Verification was stopped.';
            status('aborted', abortReason);
            onIntrusion(abortReason);
            return;
          }
        } catch {
          // A dropped frame is not a failure; the next sample will catch up.
        }
        await new Promise((r) => setTimeout(r, SAMPLE_MS * 2));
      }
    })();
  }

  function stopWatching() {
    watching = false;
  }

  /**
   * Resolves with a 128-number descriptor once one face has been steady in
   * frame. Rejects if a second face appears, nobody appears, or time runs out.
   */
  async function capture() {
    const api = faceapi();
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    let steady = 0;

    for (;;) {
      if (!stream) throw new Error('The camera was closed before a reading was taken.');
      if (Date.now() > deadline) {
        throw new Error('No steady face was found in time. Check the lighting and try again.');
      }

      let faces;
      try {
        faces = await detectAll();
      } catch {
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
        continue;
      }

      if (faces.length > 1) {
        // The explicit requirement: more than one person stops the check.
        abortReason = `${faces.length} faces are in the frame. Verification stopped — only the voter may be on camera.`;
        status('aborted', abortReason);
        throw new Error(abortReason);
      }

      if (faces.length === 0) {
        steady = 0;
        status('searching', 'No face detected. Centre your face in the frame.');
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
        continue;
      }

      steady += 1;
      if (steady < STABLE_SAMPLES) {
        status('holding', `Hold still… ${steady}/${STABLE_SAMPLES}`);
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
        continue;
      }

      status('reading', 'Reading your face…');
      const result = await api
        .detectSingleFace(video, new api.TinyFaceDetectorOptions(DETECTOR))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!result || !result.descriptor) {
        steady = 0;
        status('searching', 'That reading was unclear. Hold still and try again.');
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
        continue;
      }

      // One last look, in case somebody stepped in during the reading itself.
      const after = await detectAll().catch(() => []);
      if (after.length > 1) {
        abortReason = 'A second person appeared while reading. Verification stopped.';
        status('aborted', abortReason);
        throw new Error(abortReason);
      }

      return Array.from(result.descriptor);
    }
  }

  /** Grabs the current frame as a JPEG data URL, for the card photograph. */
  function snapshot(maxWidth = 600) {
    if (!video.videoWidth) return null;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  function stop() {
    watching = false;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
  }

  return {
    start,
    capture,
    snapshot,
    stop,
    watchForIntrusion,
    stopWatching,
    get aborted() {
      return Boolean(abortReason);
    },
  };
}

/**
 * Decodes a picked file into an <img>.
 *
 * faceapi.fetchImage() would do this, but it fetches the blob: URL, and the
 * content security policy allows blob: for images while connect-src is
 * 'self' only -- so the fetch is refused. Pointing an <img> at the same URL
 * goes through img-src instead and needs no policy change.
 */
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('that file could not be decoded as an image'));
    image.src = url;
  });
}

/**
 * Reads a still image file and returns its descriptor, or null when the picture
 * does not hold exactly one clear face. Used by the enrolment page.
 */
export async function describeImageFile(file) {
  const api = faceapi();
  await loadModels();

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const faces = await api.detectAllFaces(image, new api.TinyFaceDetectorOptions(DETECTOR));

    if (faces.length === 0) return { ok: false, reason: 'no face found' };
    if (faces.length > 1) return { ok: false, reason: `${faces.length} faces found — use a photo of one person` };

    const result = await api
      .detectSingleFace(image, new api.TinyFaceDetectorOptions(DETECTOR))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!result || !result.descriptor) return { ok: false, reason: 'the face was not clear enough' };

    return {
      ok: true,
      descriptor: Array.from(result.descriptor),
      box: result.detection.box,
      image,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Crops to the face with a margin and returns a JPEG data URL for the card.
 */
export function cropFace(image, box, size = 480) {
  const margin = box.width * 0.45;
  const side = Math.max(box.width, box.height) + margin * 2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const sx = Math.max(0, cx - side / 2);
  const sy = Math.max(0, cy - side / 2);
  const sw = Math.min(side, image.width - sx);
  const sh = Math.min(side, image.height - sy);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.88);
}

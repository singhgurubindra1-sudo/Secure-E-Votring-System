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

/**
 * Detector defaults, timed against the six sample faces that ship with the
 * library. inputSize 320 found a face in all six at roughly half the cost of
 * 416, which was no more accurate; scoreThreshold 0.5 began missing faces,
 * which is what a headscarf or dim indoor light looks like to the detector.
 * The server can override all of this from .env -- see loadSettings().
 */
const DEFAULTS = {
  inputSize: 320,
  scoreThreshold: 0.3,
  stableSamples: 2,
  captureTimeoutMs: 20000,
  minFaceRatio: 0.15,
};

// Counting faces needs far less precision than measuring one, so the watch for
// a second person runs smaller and cheaper than the main pass.
const WATCH = { inputSize: 224, scoreThreshold: 0.25 };

let settings = { ...DEFAULTS };
let settingsPromise = null;
let detectorPromise = null;
let recognitionPromise = null;
let backendPromise = null;
let backendName = null;

/** Pulls detector tuning from the server once per page. */
function loadSettings() {
  if (settingsPromise) return settingsPromise;
  settingsPromise = fetch('/api/face/assets', { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body && body.detector) settings = { ...DEFAULTS, ...body.detector };
      return settings;
    })
    .catch(() => settings);
  return settingsPromise;
}

/** The options object the detector wants, built from current settings. */
function detectorOptions() {
  const api = faceapi();
  return new api.TinyFaceDetectorOptions({
    inputSize: settings.inputSize,
    scoreThreshold: settings.scoreThreshold,
  });
}

export function backendInUse() {
  return backendName;
}

/**
 * Drops detections too small to be somebody at the camera.
 *
 * A forgiving score threshold is what makes the detector see a face in poor
 * light, but it also fires on background clutter now and then. Those blobs are
 * small, and left in they would trip the second-person rule on a voter sitting
 * alone -- a false abort is as bad as a missed face. Anyone actually using the
 * camera fills a good part of the frame.
 */
function bigEnough(boxes, frameHeight) {
  if (!frameHeight) return boxes;
  const floor = frameHeight * settings.minFaceRatio;
  return boxes.filter((entry) => {
    const box = entry.box || (entry.detection && entry.detection.box);
    return !box || box.height >= floor;
  });
}

function faceapi() {
  if (!window.faceapi) {
    // Deliberately terse: the real diagnosis needs a server round trip, so
    // callers go through ensureLibrary() first and only hit this as a guard.
    throw new Error(MISSING_LIBRARY);
  }
  return window.faceapi;
}

export const MISSING_LIBRARY = 'The face matching library did not load.';

/**
 * Turns a missing library into an actionable message.
 *
 * The library and its weights are served out of node_modules rather than
 * committed, so the usual cause is a clone that pulled new code without
 * re-running `npm install`. Asking the server which files it can actually see
 * beats telling somebody to reload a page that will never fix it.
 */
export async function ensureLibrary() {
  if (window.faceapi && window.faceapi.nets) return;

  let detail = '';
  try {
    const res = await fetch('/api/face/assets', { headers: { accept: 'application/json' } });
    if (res.ok) {
      const state = await res.json();
      if (!state.ok && state.reason) detail = ` ${state.reason} ${state.hint || ''}`.trimEnd();
    }
  } catch {
    // Offer the generic message rather than swallowing the original failure.
  }

  if (!detail) {
    detail = ' Check that the server is running and reachable, then reload the page.';
  }
  throw new Error(MISSING_LIBRARY + detail);
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
          backendName = name;
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

/**
 * The models load in two groups, because they are needed at different moments.
 *
 * Detection needs the detector and landmark nets, which are about 540 KB
 * together. Measuring a face needs the recognition net, which is 6.3 MB on its
 * own. Waiting for all three before opening the camera meant staring at a
 * blank panel while the big one downloaded; the camera now opens against the
 * small pair while the big one arrives in the background, and it is only
 * awaited at the moment a descriptor is actually wanted.
 */
function loadDetector() {
  if (detectorPromise) return detectorPromise;
  const api = faceapi();
  detectorPromise = Promise.all([initBackend(), loadSettings()])
    .then(() => Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]))
    .catch((err) => {
      detectorPromise = null;
      throw new Error('The face detection models could not be loaded. ' + (err.message || ''));
    });
  return detectorPromise;
}

function loadRecognition() {
  if (recognitionPromise) return recognitionPromise;
  const api = faceapi();
  recognitionPromise = initBackend()
    .then(() => api.nets.faceRecognitionNet.loadFromUri(MODEL_URL))
    .catch((err) => {
      recognitionPromise = null;
      throw new Error('The face matching model could not be loaded. ' + (err.message || ''));
    });
  return recognitionPromise;
}

/** Both groups, for callers that need a descriptor straight away. */
function loadModels() {
  return Promise.all([loadDetector(), loadRecognition()]);
}

/**
 * Starts the downloads without waiting for them.
 *
 * Called as soon as a page that can run a check is opened, so the weights are
 * usually in the browser cache by the time somebody presses the button.
 */
export function warmUp() {
  if (!window.faceapi) return;
  loadDetector().catch(() => {});
  loadRecognition().catch(() => {});
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

    await ensureLibrary();

    // Ask for the camera and fetch the detector at the same time. The
    // permission prompt is the slow part for a person and the download is the
    // slow part for the network; running them together spends one wait, not two.
    status('camera', 'Opening the camera…');
    const cameraReady = navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      })
      .catch((err) => {
        throw new Error(cameraError(err));
      });

    // The big recognition model is not awaited here; capture() waits for it.
    loadRecognition().catch(() => {});

    const [openedStream] = await Promise.all([
      cameraReady,
      loadDetector().then(() => status('camera', 'Starting the camera…')),
    ]);
    stream = openedStream;

    video.srcObject = stream;
    await video.play().catch(() => {});
    // A frame with zero dimensions cannot be detected against.
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
    }

    abortReason = null;
    status('ready', 'Centre your face in the frame.');
  }

  /** Cheap face count, for the "is anybody else here" checks. */
  async function countFaces() {
    const api = faceapi();
    const faces = await api.detectAllFaces(video, new api.TinyFaceDetectorOptions(WATCH));
    return bigEnough(faces, video.videoHeight).length;
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
          const count = await countFaces();
          if (!watching) return;
          if (count > 1) {
            watching = false;
            abortReason = 'A second person appeared in the frame. Verification was stopped.';
            status('aborted', abortReason);
            onIntrusion(abortReason);
            return;
          }
        } catch {
          // A dropped frame is not a failure; the next sample will catch up.
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
  }

  function stopWatching() {
    watching = false;
  }

  /**
   * Resolves with a 128-number descriptor once one face has held the frame.
   *
   * Two passes, not three. A cheap small-input pass just counts faces until one
   * has held steady, then a single full pass measures it -- and because that
   * pass asks for *all* faces, it reports the count and the descriptor
   * together. The earlier version detected, then detected again inside the
   * descriptor call, then counted once more afterwards, which is most of why
   * this took six seconds.
   *
   * A dropped frame decrements the run of good reads rather than resetting it;
   * demanding a clean restart after every blink was the other half.
   */
  async function capture() {
    const api = faceapi();
    const deadline = Date.now() + settings.captureTimeoutMs;
    const needed = settings.stableSamples;
    let steady = 0;
    let everSawFace = false;

    const tooManyFaces = (count, whileReading) => {
      abortReason = whileReading
        ? 'A second person appeared while reading. Verification stopped.'
        : `${count} faces are in the frame. Verification stopped — only the voter may be on camera.`;
      status('aborted', abortReason);
      return new Error(abortReason);
    };

    for (;;) {
      if (!stream) throw new Error('The camera was closed before a reading was taken.');
      if (Date.now() > deadline) {
        throw new Error(
          everSawFace
            ? 'Your face kept slipping out of frame. Hold still, face the camera, and try again.'
            : 'No face was found. Move into better light and fill more of the frame, then try again.'
        );
      }

      // Cheap presence check: counting faces needs far less detail than
      // measuring one, so this runs at a smaller input size.
      let count;
      try {
        count = await countFaces();
      } catch {
        continue; // a dropped frame is not a failure
      }

      if (count > 1) throw tooManyFaces(count, false);

      if (count === 0) {
        steady = Math.max(0, steady - 1);
        status('searching', 'Looking for your face — centre it in the frame.');
        continue;
      }

      everSawFace = true;
      steady += 1;
      if (steady < needed) {
        status('holding', `Hold still… ${steady}/${needed}`);
        continue;
      }

      // One full pass for everything: asking for all faces means the count and
      // the measurement come from the same frame, so nobody can slip in
      // between the two.
      status('reading', 'Reading your face…');
      try {
        await loadRecognition();
      } catch (err) {
        throw new Error(err.message);
      }
      let results;
      try {
        const all = await api
          .detectAllFaces(video, detectorOptions())
          .withFaceLandmarks()
          .withFaceDescriptors();
        results = bigEnough(all, video.videoHeight);
      } catch {
        steady = Math.max(0, needed - 1);
        continue;
      }

      if (results.length > 1) throw tooManyFaces(results.length, true);

      if (results.length === 0 || !results[0].descriptor) {
        // The face is clearly there; the read was poor. Keep most of the credit.
        steady = Math.max(0, needed - 1);
        status('holding', 'That reading was unclear — hold still.');
        continue;
      }

      return Array.from(results[0].descriptor);
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
  await ensureLibrary();
  const api = faceapi();
  await loadModels();

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const faces = await api.detectAllFaces(image, detectorOptions());

    if (faces.length === 0) return { ok: false, reason: 'no face found' };
    if (faces.length > 1) return { ok: false, reason: `${faces.length} faces found — use a photo of one person` };

    const result = await api
      .detectSingleFace(image, detectorOptions())
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

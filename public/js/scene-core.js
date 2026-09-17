import * as THREE from '/vendor/three/three.module.js';

/**
 * Shared plumbing for the two 3D backdrops: the monument hall behind the
 * sign-in page and the tricolour sky behind every page after it.
 *
 * A scene module supplies build() and, optionally, update() and leave(). This
 * file owns everything that is the same either way — the renderer, the render
 * loop, resizing, the reduced-motion and opt-out checks, and the page
 * transition — so neither scene has to repeat it.
 */

const STORE_KEY = 'ev-scene';

export { THREE };

export const prefersReducedMotion = () =>
  Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/** Remembered per browser; a missing or blocked store just means "on". */
export function sceneEnabled() {
  try {
    return localStorage.getItem(STORE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSceneEnabled(on) {
  try {
    localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
  } catch {
    // A private window simply forgets the choice.
  }
}

/** Deterministic pseudo-random, so a scene is the same shape every visit. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A canvas the caller paints, handed back as a texture. */
export function paint(width, height, draw, { repeat = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** Soft round blob: dust motes, haze sprites, lamp glows. */
export function blobTexture(peak = 0.32) {
  return paint(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, `rgba(255,255,255,${peak})`);
    g.addColorStop(0.45, `rgba(255,255,255,${peak * 0.38})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/**
 * Text drawn onto a transparent texture. Used for every engraved line in the
 * scenes: three.js has no font of its own, and a canvas keeps the letterforms
 * crisp without shipping a typeface.
 */
export function textTexture(lines, {
  width = 1024,
  height = 256,
  color = '#e8ddc8',
  background = null,
  font = '600 64px Georgia, "Times New Roman", serif',
  letterSpacing = '0.12em',
  align = 'center',
} = {}) {
  return paint(width, height, (ctx, w, h) => {
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = letterSpacing;
    const rows = Array.isArray(lines) ? lines : [lines];
    const step = h / (rows.length + 1);
    rows.forEach((row, i) => {
      const spec = typeof row === 'string' ? { text: row } : row;
      ctx.font = spec.font || font;
      ctx.fillStyle = spec.color || color;
      const x = align === 'left' ? w * 0.06 : w / 2;
      ctx.fillText(spec.text, x, step * (i + 1));
    });
  });
}

/**
 * Builds a renderer and drives one scene module.
 *
 * Returns null when WebGL is missing, so every caller can fall back to the
 * flat theme instead of showing an empty canvas.
 */
export function createScene(canvas, module, options = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }
  if (!renderer.getContext()) return null;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure ?? 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

  const built = module.build({ scene, camera, renderer, options }) || {};
  const update = built.update || (() => {});
  const leave = built.leave || (() => Promise.resolve());
  // A scene that has a subject to frame gets told the viewport shape, so it
  // can move that subject out of the way of the form on a wide screen and
  // back to the middle on a narrow one.
  const layout = built.layout || (() => {});

  // Pointer parallax. Kept small: the backdrop must never fight the form in
  // front of it for attention.
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (event) => {
    look.tx = (event.clientX / window.innerWidth - 0.5) * 2;
    look.ty = (event.clientY / window.innerHeight - 0.5) * 2;
  };

  let running = false;
  let frame = 0;
  let pausedFor = 0;
  let last = 0;
  const clock = new THREE.Clock();
  const home = camera.position.clone();
  const target = built.target ? built.target.clone() : new THREE.Vector3(0, camera.position.y, 0);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Widescreen crops the top and bottom of a fixed vertical field, so the
    // field opens up as the window gets narrow and the subject stays framed.
    camera.fov = THREE.MathUtils.clamp(52 / Math.min(1.5, Math.max(0.6, w / h)) + 12, 40, 76);
    camera.updateProjectionMatrix();
    layout(w, h, { camera, target });
  }

  function tick() {
    frame = requestAnimationFrame(tick);
    if (pausedFor > 0) return;

    const delta = Math.min(clock.getDelta(), 0.05);
    last += delta;

    look.x += (look.tx - look.x) * Math.min(1, delta * 2.6);
    look.y += (look.ty - look.y) * Math.min(1, delta * 2.6);

    const sway = options.parallax ?? 0.55;
    camera.position.x = home.x + look.x * sway;
    camera.position.y = home.y - look.y * sway * 0.45;
    camera.lookAt(target);

    update(last, delta, look);
    renderer.render(scene, camera);
  }

  return {
    scene,
    camera,
    start() {
      if (running) return;
      running = true;
      resize();
      clock.getDelta();
      if (options.parallax !== 0) window.addEventListener('pointermove', onPointer, { passive: true });
      tick();
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointer);
    },
    /** Played as a link leaves the page; resolves when it is safe to navigate. */
    leave() {
      if (prefersReducedMotion()) return Promise.resolve();
      return leave({ camera, home, target, duration: 0.5 });
    },
    /** Anything that needs the GPU calls pause() then resume(). */
    pause() { pausedFor += 1; },
    resume() { pausedFor = Math.max(0, pausedFor - 1); },
    resize,
    dispose() {
      this.stop();
      renderer.dispose();
    },
  };
}

/**
 * Puts a scene on the page: builds it, holds off while the face dialog is
 * open, and plays the exit before an internal link navigates away.
 */
export function mountScene(module, options = {}) {
  const canvas = document.getElementById('backdrop');
  const root = document.documentElement;
  if (!canvas) return null;

  if (!sceneEnabled()) {
    root.dataset.scene = 'off';
    return null;
  }

  const view = createScene(canvas, module, options);
  if (!view) {
    root.dataset.scene = 'off';
    return null;
  }

  root.dataset.scene = 'on';
  root.dataset.sceneName = options.name || '';
  view.start();

  // The face check runs TensorFlow.js on the same GPU. Rendering a scene
  // underneath it slows the part of the app that most needs to stay fast.
  const dialog = document.getElementById('faceDialog');
  if (dialog) {
    let held = false;
    new MutationObserver(() => {
      if (dialog.open && !held) { view.pause(); held = true; }
      else if (!dialog.open && held) { view.resume(); held = false; }
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }

  const onResize = () => view.resize();
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) view.pause();
    else view.resume();
  });

  if (options.transitions !== false) {
    document.addEventListener('click', async (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;

      const url = new URL(link.href, location.href);
      const sameTab = !link.target || link.target === '_self';
      const internal = url.origin === location.origin && !url.hash;
      // A download link must fire at once: holding it for the transition
      // would delay a file the voter asked for and look like a dead button.
      if (!internal || !sameTab || link.hasAttribute('download')) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      root.dataset.leaving = 'true';
      await view.leave();
      location.href = url.href;
    });
  }

  return view;
}

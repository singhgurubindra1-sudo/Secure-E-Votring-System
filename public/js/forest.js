/**
 * A foggy conifer forest, rendered in WebGL behind the portal.
 *
 * Everything here is procedural. There are no model or texture files: the
 * trees are tapered cylinders with stacked cones, the mist is canvas-drawn
 * radial gradients on drifting planes, and the depth comes from exponential
 * fog rather than from baked lighting. That buys atmosphere rather than
 * photorealism, and it keeps the page free of tens of megabytes of assets.
 *
 * Three things matter as much as how it looks:
 *   - it stops for anyone who asked their system for reduced motion
 *   - it stops while the face check is running, because TensorFlow.js wants
 *     the same GPU and the camera check is the part that must stay quick
 *   - it can be switched off entirely, and the choice is remembered
 */

import * as THREE from '/vendor/three/three.module.js';

const STORE_KEY = 'ev-forest';

/**
 * Dawn mist. The whole illusion rests on one relationship: the air is much
 * lighter than the trees, so every trunk reads as a silhouette and the fog
 * alone separates the near ranks from the far ones. Light trees on grey air --
 * the obvious first guess -- silhouettes against nothing and looks like paper
 * cut-outs.
 */
const AIR = 0xbac7cd;      // the fog, and the horizon
const AIR_DEEP = 0xa9b8bf; // clear colour behind everything
const BARK = 0x14100e;
const NEEDLE = 0x16211b;   // near-black green; fog lightens it with distance
const GROUND = 0x1d231c;

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Remembered per browser; a missing or blocked store just means "on". */
export function forestEnabled() {
  try {
    return localStorage.getItem(STORE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setForestEnabled(on) {
  try {
    localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
  } catch {
    // A private window simply forgets the choice.
  }
}

/** Soft round blob, used as the mist sprite. */
function mistTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.30)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Deterministic pseudo-random, so the forest is the same shape every visit. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createForest(canvas, { density = 1 } = {}) {
  if (!canvas) return null;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    return null; // no WebGL: the page keeps its flat background
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(AIR_DEEP);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(AIR_DEEP);
  // Exponential fog is what does the heavy lifting: it is why the far trees
  // dissolve into flat grey and the near ones read as solid.
  scene.fog = new THREE.FogExp2(AIR, 0.024);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 500);
  // Standing height, among the trunks rather than above them.
  camera.position.set(0, 1.75, 12);

  // ------------------------------------------------------------------ light

  // Deliberately dim. Anything brighter lifts the trunks out of silhouette,
  // and the silhouette is the whole effect.
  scene.add(new THREE.HemisphereLight(0x9fb1b8, GROUND, 0.55));

  // A low sun behind the trees, raking forward. It rims the near trunks and
  // gives the mist something to catch.
  const sun = new THREE.DirectionalLight(0xffedd2, 1.1);
  sun.position.set(-26, 16, -70);
  scene.add(sun);

  // ----------------------------------------------------------------- ground

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900, 60, 60),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  // Gentle undulation, so the floor is not a mirror-flat sheet.
  {
    const pos = ground.geometry.attributes.position;
    const rand = seeded(7);
    for (let i = 0; i < pos.count; i += 1) {
      pos.setZ(i, (rand() - 0.5) * 1.6);
    }
    pos.needsUpdate = true;
    ground.geometry.computeVertexNormals();
  }
  scene.add(ground);

  // ------------------------------------------------------------------ trees

  const TREES = Math.round(330 * density);
  const rand = seeded(20260914);

  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.46, 1, 7, 1, false);
  trunkGeo.translate(0, 0.5, 0); // stand it on the ground, not through it

  const trunks = new THREE.InstancedMesh(
    trunkGeo,
    new THREE.MeshStandardMaterial({ color: BARK, roughness: 0.95, flatShading: true }),
    TREES
  );

  // Four stacked cones per tree, widest at the bottom, for a conifer profile.
  const TIERS = 7;
  // 10 sides rather than 7: at silhouette scale the facet count is the
  // difference between a fir and a paper dart.
  const canopyGeo = new THREE.ConeGeometry(1, 1, 10);
  const canopy = new THREE.InstancedMesh(
    canopyGeo,
    new THREE.MeshStandardMaterial({ color: NEEDLE, roughness: 1, flatShading: true }),
    TREES * TIERS
  );

  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  let canopyIndex = 0;

  // Scattered around a point ahead of the camera, with the square root of a
  // uniform draw for the radius. That keeps the count per unit *area* even --
  // a plain uniform radius crowds everything into the near ranks and leaves
  // the distance bare, which is what makes procedural forests look like a
  // hedge with a gap behind it.
  const FOCUS_Z = -30;
  // Close enough that the front rank has weight, far enough that it reads as
  // a tree rather than an abstract wedge across the lens.
  const NEAR = 13;
  const FAR = 155;

  for (let i = 0; i < TREES; i += 1) {
    const radius = NEAR + Math.sqrt(rand()) * (FAR - NEAR);
    const angle = rand() * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius + FOCUS_Z;

    // Taller further out, so the canopy closes overhead in the distance.
    const height = 13 + rand() * 18 + Math.min(radius, 70) * 0.08;
    const lean = (rand() - 0.5) * 0.05;
    const girth = 0.75 + rand() * 0.6;

    matrix.makeRotationZ(lean);
    matrix.scale(scale.set(girth, height, girth));
    matrix.setPosition(x, -0.5, z);
    trunks.setMatrixAt(i, matrix);

    // Spread is tied to height, because a conifer is tall and narrow -- a
    // fixed spread makes short trees look like bushes and tall ones like
    // spinning tops. Tiers overlap heavily and their heights jitter, so the
    // silhouette is one ragged mass instead of a tidy stack of triangles.
    const widest = height * (0.115 + rand() * 0.03) * girth * 2.2;

    // No per-instance lightening: the fog already lifts distant trees toward
    // the air colour, and doing it twice flattens them into pale cut-outs.
    for (let tier = 0; tier < TIERS; tier += 1) {
      const t = tier / (TIERS - 1);
      const spread = widest * (1 - t * 0.86) * (0.9 + rand() * 0.2);
      const tierHeight = height * (0.30 - t * 0.13) * (0.85 + rand() * 0.3);
      // Some bare trunk below the branches, but the canopy still carries most
      // of the height -- start it too high and the trunk tops band across the
      // frame in a row.
      const base = height * (0.22 + t * 0.66) + (rand() - 0.5) * height * 0.035;

      matrix.makeRotationY(rand() * Math.PI * 2);
      matrix.scale(scale.set(spread, tierHeight, spread));
      matrix.setPosition(x + lean * base, base, z);
      canopy.setMatrixAt(canopyIndex, matrix);
      canopyIndex += 1;
    }
  }

  trunks.instanceMatrix.needsUpdate = true;
  canopy.instanceMatrix.needsUpdate = true;
  scene.add(trunks, canopy);

  // --------------------------------------------------------------- god rays

  // Wide, faint, additive planes angled along the sun direction. Cheap, and
  // they sell the idea that the light is passing through something.
  const rayMaterial = new THREE.MeshBasicMaterial({
    map: mistTexture(),
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  for (let i = 0; i < 5; i += 1) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), rayMaterial);
    ray.scale.set(7 + rand() * 9, 90, 1);
    ray.position.set(-24 + i * 11 + rand() * 6, 22, -46 - rand() * 26);
    ray.rotation.set(0.42, 0.2, 0.34 + rand() * 0.12);
    scene.add(ray);
  }

  // ------------------------------------------------------------------- mist

  const mistMaterial = new THREE.MeshBasicMaterial({
    map: mistTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
    side: THREE.DoubleSide,
    fog: false,
  });

  const mist = [];
  for (let i = 0; i < 16; i += 1) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mistMaterial);
    const scale = 34 + rand() * 60;
    plane.scale.set(scale, scale * 0.5, 1);
    plane.position.set((rand() - 0.5) * 150, 0.6 + rand() * 5, -8 - rand() * 120);
    plane.rotation.z = rand() * Math.PI;
    plane.userData.drift = 0.1 + rand() * 0.35;
    plane.userData.spin = (rand() - 0.5) * 0.02;
    mist.push(plane);
    scene.add(plane);
  }

  // ------------------------------------------------------------------- loop

  const clock = new THREE.Clock();
  const home = camera.position.clone();

  let running = false;
  let frame = null;
  let pausedFor = 0; // reference count: several things may ask for a pause
  let flying = 0;    // 0..1 progress of a page-transition dolly

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function draw(elapsed) {
    // Idle drift, kept small: this sits behind a form somebody has to read.
    const sway = Math.sin(elapsed * 0.11) * 1.5;
    const bob = Math.sin(elapsed * 0.27) * 0.16;

    camera.position.x = home.x + sway;
    camera.position.y = home.y + bob;
    camera.position.z = home.z - flying * 26;
    camera.lookAt(sway * 0.35, 2.8, -30);

    for (const plane of mist) {
      plane.position.x += plane.userData.drift * 0.03;
      plane.rotation.z += plane.userData.spin * 0.01;
      if (plane.position.x > 90) plane.position.x = -90;
      // Face the camera, so the planes never show their edge.
      plane.quaternion.copy(camera.quaternion);
    }

    renderer.render(scene, camera);
  }

  function tick() {
    frame = requestAnimationFrame(tick);
    if (pausedFor > 0) return;
    draw(clock.getElapsedTime());
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    if (prefersReducedMotion()) {
      draw(0); // one still frame, no animation
      return;
    }
    clock.start();
    tick();
  }

  function stop() {
    running = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  /**
   * Pushes the camera through the trees, then resolves so the caller can
   * navigate. Reference-counted pauses are respected: if the face check is
   * open, this returns immediately rather than animating behind it.
   */
  function flyThrough(ms = 620) {
    if (prefersReducedMotion() || pausedFor > 0 || !running) return Promise.resolve();
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const t = Math.min(1, (performance.now() - startedAt) / ms);
        // Ease in: slow to start, then the trunks rush past.
        flying = t * t;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  const onResize = () => { if (running) resize(); };
  const onVisibility = () => {
    if (document.hidden) pausedFor += 1;
    else pausedFor = Math.max(0, pausedFor - 1);
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    start,
    stop,
    flyThrough,
    /** Anything that needs the GPU calls pause() then resume(). */
    pause() { pausedFor += 1; },
    resume() { pausedFor = Math.max(0, pausedFor - 1); },
    dispose() {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose();
    },
  };
}

/**
 * Wires the forest into a page: builds it, holds off while the face dialog is
 * open, and plays the fly-through when a link leaves the page.
 */
export function mountForest({ density = 1, transitions = true } = {}) {
  const canvas = document.getElementById('forest');
  if (!canvas) return null;

  if (!forestEnabled()) {
    document.documentElement.dataset.forest = 'off';
    return null;
  }

  const forest = createForest(canvas, { density });
  if (!forest) {
    document.documentElement.dataset.forest = 'off';
    return null;
  }

  document.documentElement.dataset.forest = 'on';
  forest.start();

  // The face check runs TensorFlow.js on the same GPU. Rendering a forest
  // underneath it slows the part of the app that most needs to stay fast.
  const dialog = document.getElementById('faceDialog');
  if (dialog) {
    let held = false;
    new MutationObserver(() => {
      if (dialog.open && !held) { forest.pause(); held = true; }
      else if (!dialog.open && held) { forest.resume(); held = false; }
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }

  if (transitions) {
    document.addEventListener('click', async (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;

      const url = new URL(link.href, location.href);
      const sameTab = !link.target || link.target === '_self';
      const internal = url.origin === location.origin && !url.hash;
      // A download link must fire at once: holding it for the fly-through
      // would delay a file the voter asked for and look like a dead button.
      const isDownload = link.hasAttribute('download');
      if (!internal || !sameTab || isDownload) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      document.documentElement.dataset.leaving = 'true';
      await forest.flyThrough();
      location.href = url.href;
    });
  }

  return forest;
}

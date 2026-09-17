import { THREE, paint, blobTexture, textTexture, seeded, prefersReducedMotion } from './scene-core.js';

/**
 * The hall behind the sign-in page.
 *
 * A bronze relief of Dr B. R. Ambedkar — who carried universal adult suffrage
 * into the Constitution against the advice of nearly everyone — stands on a
 * marble plinth in a colonnade, with a ballot box beside it and ballot papers
 * drifting through the light.
 *
 * The relief is a deliberate stylisation rather than a portrait likeness: it is
 * built from extruded silhouette layers the way a cast plaque is, and reads
 * through the attributes the memorials all share — the swept-back hair over a
 * high forehead, the round spectacles, the suit and tie, and the volume of the
 * Constitution held at the plinth.
 *
 * Palette note, learnt the hard way on the scene this replaces: the haze has
 * to be lighter than the bronze or the figure silhouettes against nothing and
 * the whole thing reads as grey soup.
 */

const AIR = 0x0e1524;        // fog and the far end of the hall
const AIR_DEEP = 0x080d18;   // clear colour behind everything
const MARBLE = 0xa8a294;
const MARBLE_DARK = 0x6f6a5e;
const BRONZE = 0x7d5a2c;      // cast bronze, not polished brass
const BRONZE_DARK = 0x452f16;
const FLOOR = 0x171b26;

/** Mirrors a half-outline into a closed, symmetric THREE.Shape. */
function symmetric(half) {
  const shape = new THREE.Shape();
  shape.moveTo(half[0][0], half[0][1]);

  const draw = (points) => {
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (p.length === 6) shape.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
      else shape.lineTo(p[0], p[1]);
    }
  };

  draw(half);

  // Walk the same outline back down the other side, x negated and bezier
  // control points reversed so the curve keeps its shape.
  for (let i = half.length - 2; i >= 0; i--) {
    const p = half[i];
    const prev = half[i + 1];
    if (prev.length === 6) shape.bezierCurveTo(-prev[2], prev[3], -prev[0], prev[1], -p[p.length - 2], p[p.length - 1]);
    else shape.lineTo(-p[p.length - 2], p[p.length - 1]);
  }

  shape.closePath();
  return shape;
}

function polygon(points) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  return shape;
}

function extrude(shape, depth, { bevel = 0.012, steps = 1 } = {}) {
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 18,
    steps,
  });
}

/** Veined marble, so the plinth is not a flat grey box. */
function marbleTexture() {
  return paint(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#a6a092';
    ctx.fillRect(0, 0, w, h);
    const rand = seeded(9182);
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(62,58,50,${0.07 + rand() * 0.13})`;
      ctx.lineWidth = 0.6 + rand() * 2.4;
      let x = rand() * w;
      let y = rand() * h;
      ctx.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        x += (rand() - 0.5) * 150;
        y += (rand() - 0.35) * 110;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 2200; i++) {
      ctx.fillStyle = `rgba(${150 + rand() * 60 | 0},${145 + rand() * 60 | 0},${132 + rand() * 60 | 0},.05)`;
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
  }, { repeat: true });
}

/**
 * The bust.
 *
 * The torso is an extruded silhouette, which is all a shoulder line needs to
 * be. The head is not: a flat extrusion has one normal across its whole front
 * face, so it shades evenly and reads as a cut-out no matter how it is lit.
 * The head is therefore built from real volumes — cranium, jaw, brow, nose —
 * and it is the curvature of those that makes it look cast.
 */
function buildRelief() {
  const group = new THREE.Group();

  const bronze = new THREE.MeshStandardMaterial({
    color: BRONZE, metalness: 1, roughness: 0.42,
  });
  const bronzeDeep = new THREE.MeshStandardMaterial({
    color: BRONZE_DARK, metalness: 1, roughness: 0.55,
  });
  const linen = new THREE.MeshStandardMaterial({
    color: 0x9c8f76, metalness: 0.65, roughness: 0.58,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xcfe0f2, metalness: 0.35, roughness: 0.06,
    transparent: true, opacity: 0.2,
  });

  const ball = (sx, sy, sz, x, y, z, material = bronze) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 30, 22), material);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  };

  // ---- torso: shoulders, and nothing more ---------------------------------
  // A bust is about two and a half head-widths across the shoulders, and the
  // shoulder line is close to flat. Curving it into a dome, as a first pass
  // did, turns the whole figure into a blob with a head on top.
  const torso = new THREE.Mesh(extrude(symmetric([
    [-0.80, 0.00],
    [-0.815, 0.26],
    [-0.78, 0.50],
    [-0.755, 0.66, -0.63, 0.755, -0.50, 0.795],
    [-0.34, 0.838, -0.215, 0.862, -0.175, 0.895],
  ]), 0.38, { bevel: 0.03 }), bronze);
  torso.castShadow = true;
  torso.receiveShadow = true;
  torso.position.z = -0.02;
  group.add(torso);

  // ---- neck ---------------------------------------------------------------
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.158, 0.215, 0.66, 22), bronze);
  neck.position.set(0, 1.08, 0.09);
  neck.castShadow = true;
  group.add(neck);

  // ---- head: cranium over a jaw, which is what gives it a profile ---------
  const head = new THREE.Group();
  head.add(ball(0.330, 0.376, 0.352, 0, 1.808, 0.09));
  head.add(ball(0.274, 0.316, 0.305, 0, 1.578, 0.115));
  // Brow ridge. Small, but it is what stops the forehead reading as a dome.
  head.add(ball(0.238, 0.078, 0.14, 0, 1.782, 0.315));
  // Eye mounds. Behind a tinted lens an empty socket reads as a hole, which
  // is unsettling on a face; a little convex form reads as an eye.
  [-1, 1].forEach((side) => head.add(ball(0.058, 0.044, 0.032, side * 0.107, 1.702, 0.305)));
  // Nose, and the shadow under it.
  head.add(ball(0.048, 0.082, 0.062, 0, 1.655, 0.395));
  head.add(ball(0.082, 0.032, 0.04, 0, 1.578, 0.355));
  // Mouth line and chin.
  head.add(ball(0.086, 0.019, 0.03, 0, 1.487, 0.345, bronzeDeep));
  head.add(ball(0.105, 0.075, 0.07, 0, 1.412, 0.30));
  // Ears.
  [-1, 1].forEach((side) => head.add(ball(0.042, 0.082, 0.055, side * 0.295, 1.655, 0.055)));

  // Hair: a spherical cap tipped back off the forehead, so the hairline sits
  // high and swept, the way every memorial has it.
  // Cast a shade rougher than the skin, so the hairline shows as an edge
  // rather than melting into one smooth dome.
  const hairMat = new THREE.MeshStandardMaterial({
    color: 0x5f4423, metalness: 1, roughness: 0.66,
  });
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(1, 30, 18, 0, Math.PI * 2, 0, Math.PI * 0.47),
    hairMat
  );
  cap.scale.set(0.354, 0.426, 0.374);
  cap.position.set(0, 1.812, 0.046);
  cap.rotation.x = -0.26;
  cap.castShadow = true;
  head.add(cap);

  // ---- spectacles ---------------------------------------------------------
  const specs = new THREE.Group();
  [-0.108, 0.108].forEach((cx) => {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.097, 0.0135, 10, 30), bronzeDeep);
    rim.position.set(cx, 1.702, 0.352);
    rim.rotation.y = cx < 0 ? 0.2 : -0.2;
    rim.castShadow = true;
    specs.add(rim);

    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.094, 26), glassMat);
    glass.position.set(cx, 1.702, 0.349);
    glass.rotation.y = cx < 0 ? 0.2 : -0.2;
    specs.add(glass);
  });
  const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.075, 10), bronzeDeep);
  bridge.rotation.z = Math.PI / 2;
  bridge.position.set(0, 1.715, 0.35);
  specs.add(bridge);
  [-1, 1].forEach((side) => {
    const temple = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0095, 0.25, 8), bronzeDeep);
    temple.rotation.set(0, side * 0.42, Math.PI / 2);
    temple.position.set(side * 0.235, 1.712, 0.245);
    specs.add(temple);
  });
  head.add(specs);

  // A slight turn of the head, so the light finds one cheek before the other.
  head.rotation.y = -0.07;
  group.add(head);

  // ---- suit: shirt, tie, lapels ------------------------------------------
  const shirt = new THREE.Mesh(extrude(polygon([
    [-0.12, 0.96], [0.12, 0.96], [0.02, 0.52], [-0.02, 0.52],
  ]), 0.07, { bevel: 0.01 }), linen);
  shirt.position.z = 0.32;
  group.add(shirt);

  const collar = new THREE.Mesh(extrude(polygon([
    [-0.225, 0.925], [-0.105, 0.985], [0.105, 0.985], [0.225, 0.925],
    [0.135, 0.815], [-0.135, 0.815],
  ]), 0.085, { bevel: 0.012 }), bronze);
  collar.position.z = 0.30;
  collar.castShadow = true;
  group.add(collar);

  const tie = new THREE.Mesh(extrude(polygon([
    [-0.048, 0.94], [0.048, 0.94], [0.082, 0.34], [0.00, 0.22], [-0.082, 0.34],
  ]), 0.055, { bevel: 0.01 }), bronzeDeep);
  tie.position.z = 0.38;
  group.add(tie);

  [1, -1].forEach((side) => {
    const lapel = new THREE.Mesh(extrude(polygon([
      [side * 0.155, 0.955], [side * 0.45, 0.78], [side * 0.30, 0.22], [side * 0.09, 0.70],
    ]), 0.09, { bevel: 0.014 }), bronze);
    lapel.position.z = 0.31;
    lapel.castShadow = true;
    group.add(lapel);
  });

  return group;
}

/** The Constitution, resting on the plinth ledge. */
function buildConstitution() {
  const group = new THREE.Group();

  const cover = new THREE.MeshStandardMaterial({
    color: 0x7d2b2b, roughness: 0.62, metalness: 0.12,
    map: textTexture([
      { text: 'THE CONSTITUTION', font: '600 46px Georgia, serif', color: '#e2c887' },
      { text: 'OF INDIA', font: '600 46px Georgia, serif', color: '#e2c887' },
    ], { width: 512, height: 512, background: '#7d2b2b', letterSpacing: '0.10em' }),
  });
  const pages = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.9 });

  const book = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.11, 0.84), [
    cover, cover, cover, pages, cover, cover,
  ]);
  book.castShadow = true;
  group.add(book);

  const block = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.07, 0.80), pages);
  block.position.y = -0.005;
  group.add(block);

  group.scale.setScalar(1.12);
  group.rotation.y = -0.42;
  group.rotation.x = -0.05;
  return group;
}

function buildBallotBox() {
  const group = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.42 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.02, 0.7), steel);
  body.position.y = 0.51;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // The tricolour band, so the box reads as an election object rather than a
  // filing cabinet.
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(0.87, 0.2, 0.71),
    new THREE.MeshStandardMaterial({
      metalness: 0.2, roughness: 0.6,
      map: paint(96, 32, (ctx, w, h) => {
        ['#ff9933', '#ffffff', '#138808'].forEach((c, i) => {
          ctx.fillStyle = c;
          ctx.fillRect(0, (h / 3) * i, w, h / 3);
        });
        ctx.strokeStyle = '#0a3a82';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, h / 7, 0, Math.PI * 2);
        ctx.stroke();
      }),
    })
  );
  band.position.y = 0.30;
  group.add(band);

  // Lid with the slot, and a ballot paper half in.
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.09, 0.76), steel);
  lid.position.y = 1.055;
  lid.castShadow = true;
  group.add(lid);

  const slot = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.02, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95 })
  );
  slot.position.y = 1.10;
  group.add(slot);

  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.88, side: THREE.DoubleSide })
  );
  paper.position.set(0.02, 1.26, 0.01);
  paper.rotation.set(-0.12, 0, 0.16);
  paper.castShadow = true;
  group.add(paper);

  return group;
}

/**
 * An equirectangular sketch of the room, used only as scene.environment.
 *
 * Without one, a metal is almost black: metalness means "show me what is
 * around you", and direct lights alone leave nothing to show. This is what
 * makes the relief read as cast bronze rather than painted plastic.
 */
function hallEnvironment() {
  const texture = paint(512, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.00, '#2b3a55');
    g.addColorStop(0.34, '#4a5876');
    g.addColorStop(0.52, '#7d6a4e');
    g.addColorStop(0.70, '#2a2620');
    g.addColorStop(1.00, '#0d1018');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // The key light and the two hall lamps, as bright patches the bronze can
    // catch as highlights.
    const glow = (x, y, r, color) => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    glow(w * 0.18, h * 0.24, 120, 'rgba(255,222,170,0.95)');
    glow(w * 0.78, h * 0.34, 74, 'rgba(150,180,240,0.55)');
    glow(w * 0.52, h * 0.62, 90, 'rgba(255,180,110,0.30)');
  });
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

export function build({ scene, camera, renderer, options }) {
  const reduced = prefersReducedMotion();

  scene.background = new THREE.Color(AIR_DEEP);
  scene.fog = new THREE.FogExp2(AIR, 0.042);
  scene.environment = hallEnvironment();
  scene.environmentIntensity = 0.85;

  renderer.shadowMap.enabled = !reduced;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  camera.position.set(0, 1.85, 11.0);

  const monument = new THREE.Group();
  scene.add(monument);
  const target = new THREE.Vector3(0, 1.35, 0);
  monument.scale.setScalar(0.98);

  // ---- floor --------------------------------------------------------------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: FLOOR, roughness: 0.34, metalness: 0.5 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.45;
  floor.receiveShadow = true;
  scene.add(floor);

  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 13),
    new THREE.MeshBasicMaterial({
      map: blobTexture(0.5), color: 0xffc98a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, -2.43, 1.2);
  scene.add(pool);

  // ---- plinth -------------------------------------------------------------
  const marbleMap = marbleTexture();
  marbleMap.repeat.set(2, 2);
  const marble = new THREE.MeshStandardMaterial({ color: MARBLE, map: marbleMap, roughness: 0.72, metalness: 0.04 });
  const marbleTrim = new THREE.MeshStandardMaterial({ color: MARBLE_DARK, roughness: 0.66, metalness: 0.06 });

  const plinth = new THREE.Group();
  const tiers = [
    { w: 3.1, h: 0.24, y: -2.33, m: marbleTrim },
    { w: 2.74, h: 0.18, y: -2.12, m: marble },
    { w: 2.16, h: 1.66, y: -1.20, m: marble },
    { w: 2.52, h: 0.20, y: -0.27, m: marbleTrim },
  ];
  tiers.forEach(({ w, h, y, m }) => {
    const tier = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.52), m);
    tier.position.y = y;
    tier.castShadow = true;
    tier.receiveShadow = true;
    plinth.add(tier);
  });

  // Engraved plate. The line is his own, from the Constituent Assembly.
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.62, 0.67),
    new THREE.MeshStandardMaterial({
      transparent: true, roughness: 0.5, metalness: 0.7,
      map: textTexture([
        { text: 'DR. B. R. AMBEDKAR', font: '600 72px Georgia, serif', color: '#7a6a4e' },
        { text: 'ARCHITECT OF THE CONSTITUTION OF INDIA', font: '500 34px Georgia, serif', color: '#8c7d61' },
        { text: '“One man, one vote, one value.”', font: 'italic 500 38px Georgia, serif', color: '#8c7d61' },
      ], { width: 1024, height: 420 }),
    })
  );
  plate.position.set(0, -1.10, 0.575);
  plinth.add(plate);
  monument.add(plinth);

  // ---- the relief ---------------------------------------------------------
  const relief = buildRelief();
  relief.position.y = -0.15;
  monument.add(relief);

  const book = buildConstitution();
  book.position.set(0.79, -0.10, 0.42);
  monument.add(book);

  const ballotBox = buildBallotBox();
  ballotBox.position.set(-1.85, -2.45, 1.9);
  ballotBox.rotation.y = 0.55;
  ballotBox.scale.setScalar(0.74);
  scene.add(ballotBox);

  // ---- colonnade: depth behind the monument -------------------------------
  const columnMat = new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 0.88, metalness: 0.06 });
  const column = new THREE.CylinderGeometry(0.5, 0.58, 8.2, 18, 1, true);
  for (let i = 0; i < 5; i++) {
    const z = -24 - i * 12;
    [-1, 1].forEach((side) => {
      const pillar = new THREE.Mesh(column, columnMat);
      pillar.position.set(side * (7.6 + i * 1.3), 1.65, z);
      scene.add(pillar);
    });
  }

  // ---- lighting -----------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x35507e, 0x120f0c, 0.52));

  const key = new THREE.SpotLight(0xffd9a3, 210, 26, 0.56, 0.72, 1.6);
  key.position.set(-4.4, 7.0, 5.6);
  key.target = relief;
  key.castShadow = !reduced;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0022;
  scene.add(key);
  scene.add(key.target);

  const rim = new THREE.SpotLight(0x86a7e6, 120, 30, 0.7, 0.8);
  rim.position.set(5.2, 5.4, -3.2);
  rim.target = relief;
  scene.add(rim);

  const fill = new THREE.PointLight(0xffc389, 14, 12, 2);
  fill.position.set(0.6, 0.6, 3.6);
  scene.add(fill);

  // Frontal light for the face alone. Without it the brow and the spectacles
  // throw the eyes into shadow and the bust looks hollow.
  const faceLight = new THREE.SpotLight(0xffe6c4, 64, 10, 0.6, 0.9, 1.4);
  faceLight.position.set(0.55, 2.7, 3.9);
  faceLight.target = relief;
  scene.add(faceLight);
  scene.add(faceLight.target);

  // Lamps receding down the hall, to keep the far end from going flat black.
  const lamps = [];
  for (let i = 0; i < 4; i++) {
    const lamp = new THREE.PointLight(0xffb774, 22, 26, 2);
    lamp.position.set(i % 2 ? 4.6 : -4.6, 3.4, -12 - i * 9);
    scene.add(lamp);
    lamps.push(lamp);
  }

  // ---- shaft of light through the haze ------------------------------------
  const shafts = new THREE.Group();
  const shaftMat = new THREE.MeshBasicMaterial({
    map: paint(64, 256, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,214,158,0.12)');
      g.addColorStop(0.55, 'rgba(255,205,150,0.055)');
      g.addColorStop(1, 'rgba(255,200,145,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  [[-4.2, 0.20], [-1.2, -0.12], [2.6, 0.28]].forEach(([x, tilt], i) => {
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(4.2 + i * 0.8, 13), shaftMat);
    shaft.position.set(x, 2.6, -4.5 - i * 1.6);
    shaft.rotation.set(0, 0, tilt);
    shafts.add(shaft);
  });
  scene.add(shafts);

  // ---- dust in the beam ---------------------------------------------------
  const rand = seeded(4721);
  const MOTES = 420;
  const motePos = new Float32Array(MOTES * 3);
  const moteDrift = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (rand() - 0.5) * 20;
    motePos[i * 3 + 1] = rand() * 9 - 2.2;
    motePos[i * 3 + 2] = rand() * 16 - 12;
    moteDrift[i] = 0.06 + rand() * 0.24;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    size: 0.042, map: blobTexture(0.30), color: 0xffd9a6, opacity: 0.6,
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(motes);

  // ---- ballot papers turning slowly through the hall ----------------------
  const papers = [];
  const paperMat = new THREE.MeshStandardMaterial({
    color: 0xeee7d8, roughness: 0.9, side: THREE.DoubleSide,
    map: paint(64, 80, (ctx, w, h) => {
      ctx.fillStyle = '#efe8d9';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(70,64,54,.42)';
      for (let i = 0; i < 5; i++) ctx.fillRect(8, 14 + i * 12, w - 26, 2);
      ctx.strokeStyle = 'rgba(90,40,120,.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w - 22, 26); ctx.lineTo(w - 12, 38);
      ctx.moveTo(w - 12, 26); ctx.lineTo(w - 22, 38);
      ctx.stroke();
    }),
  });
  for (let i = 0; i < 7; i++) {
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.31), paperMat);
    sheet.position.set((rand() - 0.5) * 13, rand() * 6 - 1.5, rand() * 9 - 6);
    sheet.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    papers.push({ mesh: sheet, spin: 0.1 + rand() * 0.3, rise: 0.12 + rand() * 0.2, phase: rand() * 6.3 });
    scene.add(sheet);
  }

  return {
    target,

    /**
     * On a wide screen the form sits on the right, so the monument slides left
     * to sit under the headline instead of behind the card. On a narrow screen
     * the layout stacks and the monument comes back to the middle.
     */
    layout(w, h) {
      // The sign-in layout leaves a clear band between the headline on the
      // left and the card on the right. Everything in the scene has to live
      // inside that band, or it ends up behind type.
      const wide = w / h > 1.05 && w > 900;
      const x = wide ? 0.15 : 0;
      monument.position.x = x;
      target.x = x;
      ballotBox.position.x = wide ? -1.85 : -1.45;
      ballotBox.visible = w > 700;
      shafts.position.x = x;
    },

    update(time) {
      if (!reduced) {
        // Motes rise and wrap, so the beam always has something in it.
        const pos = moteGeo.attributes.position.array;
        for (let i = 0; i < MOTES; i++) {
          pos[i * 3 + 1] += moteDrift[i] * 0.016;
          pos[i * 3] += Math.sin(time * 0.25 + i) * 0.0009;
          if (pos[i * 3 + 1] > 7) pos[i * 3 + 1] = -2.3;
        }
        moteGeo.attributes.position.needsUpdate = true;

        papers.forEach((p, i) => {
          p.mesh.rotation.y += p.spin * 0.006;
          p.mesh.rotation.x += p.spin * 0.0032;
          p.mesh.position.y += p.rise * 0.006;
          p.mesh.position.x += Math.sin(time * 0.4 + p.phase) * 0.0022;
          if (p.mesh.position.y > 6.5) p.mesh.position.y = -2.1;
          lamps[i % lamps.length].intensity = 22 + Math.sin(time * 1.6 + i) * 2.4;
        });

        // A breath of flicker on the key light, as if the hall were lit by
        // something with a filament in it.
        key.intensity = 210 + Math.sin(time * 0.9) * 7 + Math.sin(time * 3.7) * 3;
      }
    },

    /** Walks the camera up to the plinth as the page leaves. */
    leave({ camera: cam, home, duration }) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / (duration * 1000));
          const ease = 1 - Math.pow(1 - k, 3);
          cam.position.z = home.z - ease * 4.6;
          cam.position.y = home.y + ease * 0.5;
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        step();
      });
    },
  };
}

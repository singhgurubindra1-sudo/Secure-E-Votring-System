import { THREE, paint, blobTexture, seeded, prefersReducedMotion } from './scene-core.js';

/**
 * The backdrop for every page after sign-in: a tricolour flying in open,
 * bright air.
 *
 * Deliberately the opposite of the sign-in hall. The working screens carry
 * forms, tables and a ballot, so this scene is pale enough that ordinary dark
 * text sits on it unaided — no scrims, no forced light type, nothing that
 * would make a table harder to read than it is on white.
 */

const SKY_HIGH = 0x8fb8e8;
const SKY_LOW = 0xf6f8fb;
const HAZE = 0xe9eff7;
const SAFFRON = 0xff9933;
const GREEN = 0x138808;
const CHAKRA = 0x000080;

/** The national flag, drawn at 3:2 with a 24-spoke Ashoka Chakra. */
function flagTexture() {
  return paint(900, 600, (ctx, w, h) => {
    const band = h / 3;
    ctx.fillStyle = '#ff9933';
    ctx.fillRect(0, 0, w, band);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, band, w, band);
    ctx.fillStyle = '#138808';
    ctx.fillRect(0, band * 2, w, band);

    // The chakra sits in the white band at three quarters of its height.
    const cx = w / 2;
    const cy = h / 2;
    const r = (band * 0.75) / 2;
    ctx.strokeStyle = '#000080';
    ctx.fillStyle = '#000080';

    ctx.lineWidth = r * 0.075;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.115, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI * 2) / 24;
      // Each spoke is a slim wedge rather than a line, which is how the
      // chakra is actually drawn.
      const tip = r * 0.94;
      const root = r * 0.115;
      const spread = (Math.PI * 2 / 24) * 0.17;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - spread) * root, cy + Math.sin(a - spread) * root);
      ctx.lineTo(cx + Math.cos(a) * tip, cy + Math.sin(a) * tip);
      ctx.lineTo(cx + Math.cos(a + spread) * root, cy + Math.sin(a + spread) * root);
      ctx.closePath();
      ctx.fill();

      // The small bead between each pair of spokes.
      const b = a + Math.PI / 24;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(b) * r * 0.80, cy + Math.sin(b) * r * 0.80, r * 0.045, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function buildSky() {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(180, 32, 20),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      fog: false,
      map: paint(8, 512, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0.00, '#6ea3dd');
        g.addColorStop(0.34, '#a9cbee');
        g.addColorStop(0.60, '#dce9f7');
        g.addColorStop(0.78, '#f7f9fc');
        g.addColorStop(1.00, '#eef2f7');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }),
    })
  );
  return sky;
}

export function build({ scene, camera, renderer, options }) {
  const reduced = prefersReducedMotion();

  scene.background = new THREE.Color(SKY_LOW);
  scene.fog = new THREE.Fog(HAZE, 16, 96);
  renderer.shadowMap.enabled = false;

  camera.position.set(0, 2.6, 13);
  const target = new THREE.Vector3(0, 3.4, 0);

  scene.add(buildSky());

  // ---- flag and pole -----------------------------------------------------
  const rig = new THREE.Group();
  scene.add(rig);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.1, 25, 16),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.34, metalness: 0.55 })
  );
  pole.position.y = -3.5;
  rig.add(pole);

  const finial = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xd9ad52, roughness: 0.28, metalness: 0.92 })
  );
  finial.position.y = 9.15;
  rig.add(finial);

  const FLAG_W = 5.4;
  const FLAG_H = FLAG_W / 1.5;
  const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 52, 34);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({
    map: flagTexture(), side: THREE.DoubleSide, roughness: 0.78, metalness: 0.02,
  }));
  // Hoisted on the inboard side: the fly end has to blow towards the middle
  // of the page, or half the chakra ends up past the right-hand edge.
  flag.position.set(-(FLAG_W / 2 + 0.1), 7.2, 0);
  rig.add(flag);

  const rest = Float32Array.from(flagGeo.attributes.position.array);

  // ---- tricolour ribbons drifting high up --------------------------------
  const ribbons = new THREE.Group();
  const ribbonMat = (hex) => new THREE.MeshBasicMaterial({
    color: hex, transparent: true, opacity: 0.16, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    map: blobTexture(0.9),
  });
  [[SAFFRON, 9.5, -26], [0xffffff, 7.4, -31], [GREEN, 5.4, -24]].forEach(([hex, y, z], i) => {
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(44, 5.2), ribbonMat(hex));
    ribbon.position.set(-6 + i * 5, y, z);
    ribbon.rotation.z = -0.07 + i * 0.05;
    ribbons.add(ribbon);
  });
  scene.add(ribbons);

  // ---- petals in the air -------------------------------------------------
  const rand = seeded(2617);
  const PETALS = 150;
  const petalPos = new Float32Array(PETALS * 3);
  const petalCol = new Float32Array(PETALS * 3);
  const petalFall = new Float32Array(PETALS);
  const tint = [new THREE.Color(SAFFRON), new THREE.Color(0xffffff), new THREE.Color(GREEN)];
  for (let i = 0; i < PETALS; i++) {
    petalPos[i * 3] = (rand() - 0.5) * 46;
    petalPos[i * 3 + 1] = rand() * 20 - 4;
    petalPos[i * 3 + 2] = rand() * 26 - 18;
    const c = tint[i % 3];
    petalCol[i * 3] = c.r;
    petalCol[i * 3 + 1] = c.g;
    petalCol[i * 3 + 2] = c.b;
    petalFall[i] = 0.2 + rand() * 0.55;
  }
  const petalGeo = new THREE.BufferGeometry();
  petalGeo.setAttribute('position', new THREE.BufferAttribute(petalPos, 3));
  petalGeo.setAttribute('color', new THREE.BufferAttribute(petalCol, 3));
  const petals = new THREE.Points(petalGeo, new THREE.PointsMaterial({
    size: 0.17, map: blobTexture(0.95), vertexColors: true,
    transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(petals);

  // ---- light: bright and flat enough to read text against ----------------
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6dee8, 1.15));

  const sun = new THREE.DirectionalLight(0xfff4e2, 1.5);
  sun.position.set(-9, 13, 8);
  scene.add(sun);

  const warm = new THREE.PointLight(SAFFRON, 14, 40, 2);
  warm.position.set(7, 8, 5);
  scene.add(warm);

  const cool = new THREE.PointLight(GREEN, 9, 40, 2);
  cool.position.set(-8, 2, 6);
  scene.add(cool);

  return {
    target,

    /** Keeps the pole clear of the content column. */
    layout(w, h) {
      const wide = w / h > 1.05 && w > 900;
      // On a phone the content runs the full width, so the flag has to move
      // back and out to the corner rather than sit behind the paragraph.
      rig.position.x = wide ? 10.8 : 8.2;
      rig.position.y = wide ? 0 : 2.6;
      rig.position.z = wide ? -9 : -24;
      rig.rotation.y = wide ? 0.3 : 0.24;
      target.x = wide ? 3.2 : 0.4;
      target.y = wide ? 4.6 : 5.6;
      petals.visible = w > 560;
    },

    update(time) {
      if (reduced) return;

      // Cloth: two crossing waves, damped to nothing at the hoist so the flag
      // stays attached to the pole instead of flapping free of it.
      const pos = flagGeo.attributes.position;
      for (let i = 0; i < rest.length; i += 3) {
        const x = rest[i];
        const y = rest[i + 1];
        const grip = (FLAG_W / 2 - x) / FLAG_W; // 0 at the pole, 1 at the fly
        const amp = grip * grip * 0.62;
        pos.array[i + 2] =
          Math.sin(x * 1.7 - time * 2.5) * amp +
          Math.sin(x * 0.9 + y * 1.5 - time * 1.7) * amp * 0.55;
        // A little sag towards the free end, as a hanging cloth has.
        pos.array[i + 1] = y - grip * grip * 0.2;
      }
      pos.needsUpdate = true;
      flagGeo.computeVertexNormals();

      const fall = petalGeo.attributes.position.array;
      for (let i = 0; i < PETALS; i++) {
        fall[i * 3 + 1] -= petalFall[i] * 0.013;
        fall[i * 3] += Math.sin(time * 0.6 + i * 0.7) * 0.007;
        if (fall[i * 3 + 1] < -5.5) fall[i * 3 + 1] = 16;
      }
      petalGeo.attributes.position.needsUpdate = true;

      ribbons.children.forEach((ribbon, i) => {
        ribbon.position.x += (i % 2 ? 0.006 : -0.006);
        ribbon.position.y += Math.sin(time * 0.3 + i) * 0.0035;
        if (ribbon.position.x > 26) ribbon.position.x = -26;
        if (ribbon.position.x < -26) ribbon.position.x = 26;
      });
    },

    /** A short lift, so moving between services feels like one place. */
    leave({ camera: cam, home, duration }) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / (duration * 1000));
          const ease = 1 - Math.pow(1 - k, 3);
          cam.position.y = home.y + ease * 1.5;
          cam.position.z = home.z - ease * 2.2;
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        step();
      });
    },
  };
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isBlocked } from './manor.js';
import { asset } from './assets.js';
import { spawnGhost, preloadGhost } from './ghost.js';

/**
 * The haunting: every so often a coffin drops out of the ceiling somewhere
 * near Stella, slams into the floor, and lets a ghost out.
 *
 * The coffin is assets/world/coffin.glb -- a single mesh with no separate lid,
 * so the opening reads as an impact shudder rather than a lid coming off. The
 * The ghost itself is ghost.js -- the same wandering, path-finding ghost the
 * level already uses. The coffin just decides where and when one appears.
 */

const COFFIN_URL = asset('assets/world/coffin.glb');

// Matches the manor's ceiling height, so the coffin comes through the ceiling
// rather than materialising below it.
const CEILING = 3;
// Matches HEIGHT in ghost.js, so the rise clears the floor exactly.
const GHOST_HEIGHT = 1.75;

// coffin.glb is authored upright and already close to real-world scale (its
// raw height is 1.99 m), so this is a normalisation, not a resize. Height is
// the axis to measure: the long axis IS the vertical one here.
const COFFIN_HEIGHT = 2.0;

const FALL_GRAVITY = 22;

// Impact shudder: the model is a single mesh with no separate lid, so the
// coffin rocks itself apart-ish instead of throwing a lid.
const SHUDDER_TIME = 0.55;

// The opacity ghost.js settles its own materials at.
const GHOST_OPACITY = 0.42;

// Slack on the touch test. The collider already stops Stella at the coffin's
// edge, so this only has to cover that resting gap, not a real overlap.
const TOUCH_SLACK = 0.18;

// How long the coffin sits shut after landing before it lets the ghost out.
// Walking into it still opens it early.
const SEAL_TIME = 3;

// Seconds between hauntings, randomised in this range.
const FIRST_DELAY = [7, 12];
const REPEAT_DELAY = [26, 46];

// Where the coffin is allowed to land, relative to Stella.
const DROP_MIN = 3.5;
const DROP_MAX = 7.5;

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function buildDust(count) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0x9c8f7a, size: 0.06, transparent: true, opacity: 0.8, depthWrite: false })
  );
  points.frustumCulled = false;
  points.visible = false;
  return points;
}

// Fallback when no parked light is supplied. Costs one recompile on the frame
// it is added, which is why main.js hands them over instead.
function addOwnLight(scene) {
  const light = new THREE.PointLight(0xffffff, 0, 1, 2);
  scene.add(light);
  return light;
}

export function createHaunting({
  scene,
  level,
  character,
  characterRadius = 0.4,
  // The haunting owns the only ghost in the manor, so it needs the wiring that
  // makes one dangerous: who to hunt, and what to call when it lands a blow.
  onAttack = null,
  onGhost = null,
  // Two point lights, parked in the scene since boot. A light entering or
  // leaving the scene changes three's light count and recompiles every
  // material in it -- ~80 ms, landing squarely on the frame the coffin hits
  // the floor and again on the frame the ghost comes out. Reusing two that are
  // already counted makes both of those frames ordinary ones.
  glow = null,
  ghostGlow = null,
}) {
  const group = new THREE.Group();
  scene.add(group);

  // The dust is built once and reused. Creating a Points per burst meant
  // disposing its material per burst, which released the compiled program --
  // so every drop paid to compile it again, 30-140 ms on the exact frame the
  // coffin hits the floor. Now it is parked in the group and switched on.
  const DUST_COUNT = 90;
  const dust = buildDust(DUST_COUNT);
  group.add(dust);

  const coffinGlow = glow ?? addOwnLight(scene);
  coffinGlow.color.setHex(0x74e2ff);
  coffinGlow.distance = 6;
  coffinGlow.decay = 2;
  coffinGlow.intensity = 0;

  const loader = new GLTFLoader();
  const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

  // Both the coffin and the ghost load at boot, behind the first timer. They
  // used to arrive at the moment they were needed, which put a multi-megabyte
  // parse and a first-frame shader compile right where the player is watching:
  // the drop stuttered, and the ghost's emergence stuttered again.
  let coffinAsset = null;
  const coffinReady = load(COFFIN_URL).then((g) => {
    coffinAsset = prepareCoffin(g.scene);
    return coffinAsset;
  }).catch((err) => {
    console.error('haunting: coffin failed to load', err);
    return null;
  });

  const ghostReady = preloadGhost().catch((err) => {
    console.error('haunting: ghost failed to preload', err);
    return null;
  });

  const state = {
    phase: 'waiting',
    vy: 0,
    dustVel: null,
    timer: rand(...FIRST_DELAY),
    shake: 0,
    coffin: null,
    shudder: 0,
    baseYaw: 0,
    sealed: 0,
    ghost: null,
    emergeAt: null,
    emerge: 0,
    collider: null,
    glow: null,
    dust: null,
    dustLife: 0,
  };

  /* ------------------------------------------------------------------ model */

  // Normalise the export once: scale it to COFFIN_HEIGHT, centre it on the
  // origin in X/Z and sit its base on y = 0, so `position.y` reads as height
  // off the floor exactly like the procedural version did.
  function prepareCoffin(model) {
    model.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());

    // Normalise on height. Scaling by the horizontal extent would blow an
    // upright coffin up by its own aspect ratio.
    const scale = COFFIN_HEIGHT / size.y;
    model.scale.multiplyScalar(scale);

    model.updateWorldMatrix(true, true);
    const scaled = new THREE.Box3().setFromObject(model);
    const centre = scaled.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -scaled.min.y, -centre.z);

    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });

    const footprint = scaled.getSize(new THREE.Vector3());
    return { model, footprint };
  }

  function buildCoffin() {
    const coffin = new THREE.Group();
    // Cloned per drop: the prepared model is the shared source for every later
    // haunting and must not be reparented out of it.
    coffin.add(coffinAsset.model.clone(true));
    return coffin;
  }

  /* ------------------------------------------------------------- spawn point */

  // Pick a wall near Stella and set the coffin flush against its inward face.
  // Walls are the only colliders tagged 'wall', so furniture is ignored: the
  // coffin should stand against the panelling, not lean on a bookcase.
  function findDropSpot() {
    const walls = level.colliders.filter((b) => b.name === 'wall');
    if (!walls.length) return null;

    const gap = clearance() + 0.08;

    // Nearest walls first, so the drop still lands in Stella's part of the
    // manor rather than across the building.
    const ranked = walls
      .map((b) => {
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        return { b, cx, cz, d: Math.hypot(cx - character.position.x, cz - character.position.z) };
      })
      .filter((w) => w.d >= DROP_MIN && w.d <= DROP_MAX)
      .sort((a, b) => a.d - b.d);

    // Shuffle within reach so it isn't the same wall every time.
    for (const w of shuffle(ranked)) {
      // Step off each face in turn; the one that lands in open floor is the
      // room side. Interior walls have two, exterior only one -- and the far
      // side of an exterior wall is the void outside the manor, which is
      // unblocked and inside the bounds, so it has to be excluded explicitly.
      const half = { x: (w.b.maxX - w.b.minX) / 2, z: (w.b.maxZ - w.b.minZ) / 2 };
      const faces = [
        { dx: 0, dz: -1, off: half.z },
        { dx: 0, dz: 1, off: half.z },
        { dx: -1, dz: 0, off: half.x },
        { dx: 1, dz: 0, off: half.x },
      ];

      for (const f of shuffle(faces)) {
        const x = w.cx + f.dx * (f.off + gap);
        const z = w.cz + f.dz * (f.off + gap);

        if (!level.isFloor(x, z)) continue; // outside the rooms entirely
        if (isBlocked(x, z, level.colliders, clearance())) continue;
        if (Math.abs(x) > level.bounds.x - 0.6 || Math.abs(z) > level.bounds.z - 0.6) continue;

        // Back to the wall: face the way we stepped, i.e. into the room.
        return { at: new THREE.Vector3(x, 0, z), yaw: Math.atan2(f.dx, f.dz) };
      }
    }
    return null;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // The collider holds Stella at the coffin's edge, so "colliding" is really
  // "resting against it": test the gap the collider leaves, plus a little.
  function touchingCoffin() {
    const c = state.coffin;
    const box = state.collider;
    if (!c || !box) return false;

    // Same closest-point test the manor's own resolution uses.
    const cx = Math.max(box.minX, Math.min(character.position.x, box.maxX));
    const cz = Math.max(box.minZ, Math.min(character.position.z, box.maxZ));
    const dist = Math.hypot(character.position.x - cx, character.position.z - cz);
    return dist <= characterRadius + TOUCH_SLACK;
  }

  // Half-diagonal of the footprint: the coffin lands at an arbitrary yaw, so
  // the worst case is the diagonal, not either side.
  function clearance() {
    const f = coffinAsset.footprint;
    return Math.hypot(f.x, f.z) / 2;
  }

  /* -------------------------------------------------------------- lifecycle */

  function clear() {
    if (state.coffin) group.remove(state.coffin);
    if (state.ghost) {
      // Only ever one ghost: the old one leaves with its coffin.
      scene.remove(state.ghost.group);
      onGhost?.(null);
    }
    // Dimmed, not removed -- see the note on the constructor's `glow`.
    coffinGlow.intensity = 0;
    if (ghostGlow) ghostGlow.intensity = 0;
    dust.visible = false;
    if (state.collider) {
      const i = level.colliders.indexOf(state.collider);
      if (i !== -1) level.colliders.splice(i, 1);
    }
    Object.assign(state, {
      vy: 0, dustVel: null,
      coffin: null, shudder: 0, baseYaw: 0, sealed: 0,
      ghost: null, emergeAt: null,
      collider: null, glow: null, dust: null, dustLife: 0, emerge: 0,
    });
  }

  function trigger() {
    // Nothing to drop until the GLB is in. Re-arm rather than dropping an
    // invisible coffin the ghost then climbs out of.
    if (!coffinAsset) {
      state.timer = 2;
      return false;
    }

    const spot = findDropSpot();
    if (!spot) {
      state.timer = 3;
      return false;
    }

    // Only one haunting at a time -- otherwise coffins pile up across a long
    // session and their colliders fence the player in.
    clear();

    const coffin = buildCoffin();
    coffin.position.copy(spot.at);
    coffin.position.y = CEILING + 0.4;
    coffin.rotation.y = spot.yaw;
    group.add(coffin);

    state.coffin = coffin;
    state.baseYaw = spot.yaw;
    state.shudder = 0;
    state.vy = 0;
    state.phase = 'falling';
    return true;
  }

  function onImpact() {
    const c = state.coffin;
    c.position.y = 0;

    state.shake = 0.42;

    // Shut on landing, and it opens on its own a few seconds later. Touching
    // it just brings that forward.
    state.phase = 'sealed';
    state.sealed = SEAL_TIME;

    state.shudder = SHUDDER_TIME;

    // The coffin blocks movement only once it is actually on the floor. Square
    // on the half-diagonal, since it lands at an arbitrary yaw and the
    // colliders the manor uses are all axis-aligned.
    const half = clearance();
    state.collider = {
      minX: c.position.x - half, maxX: c.position.x + half,
      minZ: c.position.z - half, maxZ: c.position.z + half,
    };
    level.colliders.push(state.collider);

    state.glow = coffinGlow;
    state.glow.color.setHex(0x74e2ff);
    state.glow.intensity = 0.9;
    state.glow.position.set(c.position.x, 1.1, c.position.z);

    spawnDust(c.position);
  }

  function spawnDust(at) {
    const pos = dust.geometry.attributes.position.array;
    const vel = [];
    for (let i = 0; i < DUST_COUNT; i++) {
      pos[i * 3] = at.x;
      pos[i * 3 + 1] = 0.05;
      pos[i * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const speed = rand(0.6, 2.4);
      vel.push(new THREE.Vector3(Math.sin(a) * speed, rand(0.4, 1.8), Math.cos(a) * speed));
    }
    dust.geometry.attributes.position.needsUpdate = true;
    dust.material.opacity = 0.8;
    dust.visible = true;
    state.dust = dust;
    state.dustVel = vel;
    state.dustLife = 1.6;
  }

  async function releaseGhost(at) {
    // The coffin stands upright, so rising on its exact centre would leave the
    // ghost climbing up inside the box, hidden. Come up just clear of it, on
    // the side Stella is watching from.
    const dx = character.position.x - at.x;
    const dz = character.position.z - at.z;
    const len = Math.hypot(dx, dz) || 1;
    const reach = clearance() + 0.45;
    const ex = at.x + (dx / len) * reach;
    const ez = at.z + (dz / len) * reach;

    let spawned;
    try {
      spawned = await spawnGhost({
        scene,
        level,
        start: { x: ex, z: ez },
        target: character,
        onAttack,
        glow: ghostGlow,
      });
    } catch (err) {
      console.error('haunting: ghost failed to spawn', err);
      return;
    }

    // A later haunting may have cleared this one while the GLB was loading.
    if (state.phase !== 'opening' || !state.coffin) {
      scene.remove(spawned.group);
      return;
    }

    state.ghost = spawned;
    onGhost?.(spawned);
    state.emergeAt = { x: ex, z: ez };
    state.emerge = 0;
    setGhostOpacity(0);
    spawned.group.position.set(ex, -GHOST_HEIGHT, ez);
    state.phase = 'rising';
  }

  // ghost.js settles its materials at 0.42; scale that rather than overriding
  // it, so the ghost ends up looking exactly like every other one.
  function setGhostOpacity(v) {
    state.ghost.group.traverse((o) => {
      if (o.isMesh) o.material.opacity = v;
    });
  }

  /* -------------------------------------------------------------------- tick */

  function update(dt) {
    state.shake = Math.max(0, state.shake - dt * 1.8);

    if (state.dust) updateDust(dt);
    if (state.phase === 'waiting') {
      state.timer -= dt;
      if (state.timer <= 0) trigger();
      return;
    }

    if (state.phase === 'falling') {
      state.vy -= FALL_GRAVITY * dt;
      state.coffin.position.y += state.vy * dt;
      if (state.coffin.position.y <= 0) onImpact();
      return;
    }

    if (state.shudder > 0) updateShudder(dt);

    // Sealed: sit tight until Stella leans on it.
    if (state.phase === 'sealed') {
      if (state.glow) {
        // A faint seep through the chains, so it reads as something waiting.
        state.glow.intensity = 0.9 + Math.sin(performance.now() * 0.003) * 0.35;
      }
      state.sealed -= dt;
      if (state.sealed <= 0 || touchingCoffin()) {
        state.phase = 'opening';
        state.shake = 0.3;
        state.shudder = SHUDDER_TIME;
        spawnDust(state.coffin.position);
        releaseGhost(state.coffin.position);
      }
      return;
    }

    if (state.glow) {
      // Swells as the ghost comes up, then settles to a low haunt.
      const target = state.phase === 'rising' ? 9 : 3.2;
      state.glow.intensity += (target - state.glow.intensity) * Math.min(1, dt * 2.5);
    }

    if (state.phase === 'rising') {
      state.emerge = Math.min(1, state.emerge + dt / 2.2);
      const e = state.emerge;

      // Run ghost.js's own update so the walk cycle plays, then pin it back to
      // the emergence point: it must not start pathing until it is fully out.
      state.ghost.update(dt);
      state.ghost.group.position.set(
        state.emergeAt.x,
        -GHOST_HEIGHT + GHOST_HEIGHT * easeOut(e),
        state.emergeAt.z
      );
      setGhostOpacity(e * GHOST_OPACITY);

      // Keep the light on the ghost as it comes up, not on the empty coffin.
      state.glow.position.x = state.emergeAt.x;
      state.glow.position.z = state.emergeAt.z;

      if (e >= 1) state.phase = 'haunting';
      return;
    }

    if (state.phase === 'haunting') {
      // Fully handed over: it wanders the manor on its own from here.
      state.ghost.update(dt);
      state.glow.position.x = state.ghost.group.position.x;
      state.glow.position.z = state.ghost.group.position.z;

      // Axed and fully dissolved (ghost.js hides the group once it has faded).
      // Clear the coffin and re-arm, or the first banishing would be the last
      // haunting of the session.
      if (!state.ghost.alive && !state.ghost.group.visible) {
        clear();
        state.phase = 'waiting';
        state.timer = rand(...REPEAT_DELAY);
      }
    }
  }

  // A decaying rock about the long axis, as if something inside is fighting
  // its way out. Rotation is applied on top of the landing yaw, not replacing
  // it, so the coffin keeps the direction it fell in.
  function updateShudder(dt) {
    state.shudder = Math.max(0, state.shudder - dt);
    const t = state.shudder / SHUDDER_TIME;
    const c = state.coffin;
    c.rotation.z = Math.sin(state.shudder * 46) * 0.16 * t * t;
    c.position.y = Math.abs(Math.sin(state.shudder * 32)) * 0.09 * t * t;
    if (state.shudder === 0) {
      c.rotation.z = 0;
      c.position.y = 0;
    }
  }

  function updateDust(dt) {
    state.dustLife -= dt;
    const arr = state.dust.geometry.attributes.position.array;
    for (let i = 0; i < state.dustVel.length; i++) {
      const v = state.dustVel[i];
      v.y -= 3.2 * dt;
      arr[i * 3] += v.x * dt;
      arr[i * 3 + 1] = Math.max(0.02, arr[i * 3 + 1] + v.y * dt);
      arr[i * 3 + 2] += v.z * dt;
      v.x *= 1 - dt * 1.6;
      v.z *= 1 - dt * 1.6;
    }
    state.dust.geometry.attributes.position.needsUpdate = true;
    state.dust.material.opacity = clamp(state.dustLife / 1.6, 0, 1) * 0.8;

    if (state.dustLife <= 0) {
      // Hidden, never disposed -- see where it is built.
      dust.visible = false;
      state.dust = null;
    }
  }

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  return {
    update,
    trigger,
    // Resolves once both models are parsed, with the meshes the renderer needs
    // to compile. Downloading them early only moves half the stall: the first
    // draw of an uncompiled material still costs a frame.
    ready: Promise.all([coffinReady, ghostReady]).then(([coffin, ghost]) =>
      [coffin?.model, ghost?.model, dust].filter(Boolean)
    ),
    banish() {
      clear();
      state.phase = 'waiting';
      state.timer = rand(...REPEAT_DELAY);
    },
    get shake() { return state.shake; },
    get phase() { return state.phase; },
    get ghost() { return state.ghost; },
    get coffin() { return state.coffin; },
  };
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildManor, resolveCollisions, isBlocked } from './manor.js';
import { spawnGhost, HITS_TO_BANISH } from './ghost.js';

const ASSET_DIR = '/assets/characters/main-character';

// The rigged, skinned export drives everything now. The original
// main-character.glb is a 3M-triangle scan with no skeleton, so it cannot be
// animated -- it stays in the repo as the high-res reference, unused here.
const BASE_URL = `${ASSET_DIR}/main-character-biped-Animation-Walking-withSkin.glb`;

// Every file ships the same 24-joint skeleton, so clips lifted out of one
// load bind by joint name onto the base model's skeleton.
const CLIP_FILES = {
  run:        'main-character-biped-Animation-Running-withSkin.glb',
  runFast:    'main-character-biped-Animation-RunFast-withSkin.glb',
  jump:       'main-character-biped-Animation-Jump-Run-withSkin.glb',
  punch:      'main-character-biped-Animation-Punch-Combo-2-withSkin.glb',
  punchAlt:   'main-character-biped-Animation-Punch-Combo-5-withSkin.glb',
  jumpPunch:  'main-character-biped-Animation-Jumping-Punch-withSkin.glb',
};

// Ground speed each locomotion clip was authored for, used to scale playback
// so the feet don't skate. Tuned by eye against the in-place cycles.
const CLIP_SPEED = { walk: 1.5, run: 3.4, runFast: 5.0 };

// Seconds into the walk cycle used as the standing pose (see boot()).
const IDLE_FRAME_TIME = 0.0;

// Filled in once the manor is built; the level's walls are the bounds now.
let level = null;
let ghost = null;
const CHARACTER_HEIGHT = 1.8;

// Tuned against the walk cycle: at 1.8 the clip plays near 1.2x, which keeps
// the stride reading as a walk instead of a speed-walk.
const WALK_SPEED = 1.8;
const RUN_SPEED = 5.0;
const ACCEL = 14;
const TURN_SPEED = 12;
const JUMP_SPEED = 4.2;
const GRAVITY = 12;

// How far the camera keeps off walls and furniture, so the near plane never
// pokes through a surface.
const CAMERA_MARGIN = 0.35;

// The camera sits behind the character and drifts back into place on its own.
// Soft, not rigid: a proportional pull with a ceiling on how fast it can swing,
// so it trails the turn instead of snapping to it.
const FOLLOW_GAIN = 2.4;
const FOLLOW_MAX_RATE = 2.2; // rad/s
const FOLLOW_DEADZONE = 0.04; // rad; stops micro-jitter when nearly aligned
const FOLLOW_DELAY = 0.7; // s of no dragging before the camera takes over again
// Input within this cone of camera-forward counts as "running forwards".
const FOLLOW_CONE = Math.PI / 4;

// Standing still, the character turns to match the camera instead: whichever
// one the player is actively steering leads, and the other follows.
const TURN_TO_CAMERA = 4.5; // rad/s

// Combat. The strike lands partway through the punch clip rather than on the
// keypress, so the hit connects when the arm is actually out.
const PUNCH_STRIKE_TIME = 0.32; // s into the clip
const PUNCH_REACH = 1.6; // m, measured centre to centre
const PUNCH_ARC = Math.PI / 2.2; // the ghost must be in front, not behind
// The combo clips run 3.9-5.0 s. Waiting one out between punches makes the
// fight unplayable, so a punch only owns the body briefly and can be thrown
// again well before its clip ends.
const PUNCH_HOLD = 1.0; // s the punch animation stays in control
const PUNCH_COOLDOWN = 0.5; // s before another punch can be thrown

/* ------------------------------------------------------------------ renderer */

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070906);
scene.fog = new THREE.Fog(0x070906, 12, 34);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);

/* ------------------------------------------------------------------- lighting */

// Interior, candle-lit: the manor's own lamps and candles do most of the work
// (see buildManor), so this is just enough fill to keep the corners readable.
scene.add(new THREE.HemisphereLight(0x5a6480, 0x1a1510, 0.5));
scene.add(new THREE.AmbientLight(0xffd9b0, 0.18));

// One shadow-casting light for the whole level -- point-light shadows are
// expensive and the lamps are numerous.
const moon = new THREE.DirectionalLight(0x9fb6ff, 0.9);
moon.position.set(6, 12, 8);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.bias = -0.0005;
moon.shadow.normalBias = 0.02;
const s = moon.shadow.camera;
s.left = -14; s.right = 14; s.top = 12; s.bottom = -12;
s.near = 0.5; s.far = 40;
s.updateProjectionMatrix();
scene.add(moon);

/* ------------------------------------------------------------------ character */

// `character` is the thing we move; the loaded model is parented inside it so
// that normalizing the model's scale/offset never fights with the controller.
const character = new THREE.Group();
scene.add(character);

const modelPivot = new THREE.Group();
character.add(modelPivot);

const state = {
  velocity: new THREE.Vector3(),
  y: 0,
  vy: 0,
  grounded: true,
  facing: 0,
  radius: 0.4,
  punchTimer: 0, // how long the punch still owns the animation
  cooldown: 0, // time until another punch may be thrown
  strikeAt: 0, // countdown to the moment this punch connects
  hits: 0,
  over: false,
};

let mixer = null;
const actions = {};
let current = null;

/* ------------------------------------------------------------------- controls */

const keys = new Set();
const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space',
]);

addEventListener('keydown', (e) => {
  if (MOVE_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));

// Punch is a one-shot rather than a held state, so it fires on the keypress
// instead of being polled in the loop.
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.repeat || state.cooldown > 0 || state.over) return;
  const clip = state.grounded ? (Math.random() < 0.5 ? 'punch' : 'punchAlt') : 'jumpPunch';
  if (!actions[clip]) return;
  state.punchTimer = PUNCH_HOLD;
  state.cooldown = PUNCH_COOLDOWN;
  state.strikeAt = PUNCH_STRIKE_TIME;
  play(clip, 0.1, true);
});
addEventListener('blur', () => keys.clear());

// Orbit camera: yaw/pitch around the character, mouse or touch drag.
const orbit = { yaw: Math.PI * 0.15, pitch: 0.28, distance: 4.2, dragging: false, lastX: 0, lastY: 0, sinceDrag: FOLLOW_DELAY };

canvas.addEventListener('pointerdown', (e) => {
  orbit.dragging = true;
  orbit.sinceDrag = 0;
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  orbit.yaw -= (e.clientX - orbit.lastX) * 0.005;
  orbit.pitch = clamp(orbit.pitch + (e.clientY - orbit.lastY) * 0.005, -0.2, 1.2);
  orbit.lastX = e.clientX;
  orbit.lastY = e.clientY;
  orbit.sinceDrag = 0;
});
const endDrag = (e) => {
  orbit.dragging = false;
  orbit.sinceDrag = 0;
  if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.distance = clamp(orbit.distance + e.deltaY * 0.004, 1.8, 9);
}, { passive: false });

/* --------------------------------------------------------------------- loader */

const loaderEl = document.getElementById('loader');
const barFill = document.getElementById('bar-fill');
const statusEl = document.getElementById('loader-status');
const hud = document.getElementById('hud');
const pipsEl = document.getElementById('pips');
const overlayEl = document.getElementById('gameover');
document.getElementById('again')?.addEventListener('click', () => location.reload());

const gltfLoader = new GLTFLoader();
const load = (url, onProgress) => new Promise((res, rej) => gltfLoader.load(url, res, onProgress, rej));

(async function boot() {
  try {
    statusEl.textContent = 'Building the manor...';
    level = await buildManor({ scene, renderer });

    // Base model first, so the character is on screen before the extra clips
    // finish streaming.
    const base = await load(BASE_URL, (evt) => {
      if (!evt.total) return;
      const pct = Math.round((evt.loaded / evt.total) * 100);
      barFill.style.width = `${pct}%`;
      statusEl.textContent = `${pct}%`;
    });

    normalizeAndAdd(base.scene);
    character.position.copy(level.spawn);
    mixer = new THREE.AnimationMixer(base.scene);

    // The base file's own clip is the walk.
    const walkClip = base.animations[0];
    addClip('walk', walkClip);

    // No idle animation ships with the character. Freeze a single frame of the
    // walk instead of leaving the rig in its A-pose bind stance -- a clone,
    // because clipAction caches per clip and would otherwise hand back the
    // walk action itself.
    const idleClip = walkClip.clone();
    idleClip.name = 'idle';
    addClip('idle', idleClip);
    actions.idle.setEffectiveTimeScale(0);
    actions.idle.time = IDLE_FRAME_TIME;

    mixer.addEventListener('finished', onceFinished);
    play('idle', 0);

    loaderEl.classList.add('done');
    setTimeout(() => loaderEl.remove(), 700);
    hud.hidden = false;
    document.getElementById('tracker').hidden = false;

    // Remaining clips load in the background; each is pulled out of its file
    // and its skinned mesh discarded.
    spawnGhost({ scene, level })
      .then((g) => { ghost = g; })
      .catch((err) => console.error('ghost failed to spawn', err));

    const entries = Object.entries(CLIP_FILES);
    const loaded = await Promise.all(
      entries.map(([, file]) => load(`${ASSET_DIR}/${file}`).then((g) => g.animations[0]))
    );
    entries.forEach(([name], i) => addClip(name, loaded[i]));
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to load character — see console.';
  }
})();

function addClip(name, clip) {
  if (!clip) return;
  // Jump_Run travels ~4 units sideways and ~7 forward over its length. The
  // controller owns position, so that horizontal drift has to go or the model
  // slides off its own feet; the vertical channel stays for the tuck.
  if (name === 'jump' || name === 'jumpPunch') stripHorizontalRootMotion(clip);

  const action = mixer.clipAction(clip);
  if (name === 'jump' || name === 'punch' || name === 'punchAlt' || name === 'jumpPunch') {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
  }
  actions[name] = action;
}

// Zero the X/Z components of the Hips translation track, keeping Y.
function stripHorizontalRootMotion(clip) {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = 0;
      v[i + 2] = 0;
    }
  }
}

// `restart` replays an action that is already current -- used by punches, where
// pressing again should throw the next punch rather than be swallowed.
function play(name, fade = 0.18, restart = false) {
  const next = actions[name];
  if (!next || (next === current && !restart)) return;

  if (current && current !== next) current.fadeOut(fade);
  next.reset().setEffectiveWeight(1).fadeIn(fade).play();
  // reset() rewinds to 0, so the frozen idle pose has to be re-seated after it.
  if (next === actions.idle) next.time = IDLE_FRAME_TIME;
  current = next;
}

// Punches now hand control back on a timer (see PUNCH_HOLD) rather than when
// the clip ends, so this only needs to release a punch that finishes early.
// `current` is left alone: clampWhenFinished holds the last frame, and
// re-nulling it here would retrigger the same clip on the very next frame.
function onceFinished(e) {
  if (e.action === actions.punch || e.action === actions.punchAlt || e.action === actions.jumpPunch) {
    state.punchTimer = 0;
  }
}


// Rescale the rig to a human height and drop its feet onto y = 0, centered on
// the controller. The Armature already carries a 0.01 scale (the source is in
// centimetres), so this is measured rather than assumed.
function normalizeAndAdd(model) {
  model.updateWorldMatrix(true, true);

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  const scale = CHARACTER_HEIGHT / size.y;
  model.scale.multiplyScalar(scale);
  model.position.set(
    -center.x * scale,
    -bounds.min.y * scale,
    -center.z * scale
  );

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // Bounds are computed from the bind pose, so an animated limb reaching
    // outside them would pop the whole mesh out of view.
    o.frustumCulled = false;

    const mat = o.material;
    if (!mat) return;
    // The export sets emissive to full white over the colour map and leaves
    // metalness at the glTF default of 1, which renders the character self-lit
    // and chrome. Put it back under the scene's lighting.
    mat.emissiveIntensity = 0;
    mat.metalness = 0;
    mat.roughness = 0.85;
    mat.envMapIntensity = 0.9;
  });

  modelPivot.add(model);

  // Collision radius from the body's depth, not the full footprint: the bind
  // pose holds the arms out, and measuring across them would stop her a whole
  // arm span short of every wall.
  state.radius = clamp((Math.min(size.x, size.z) * scale) / 2, 0.2, 0.6);

  character.position.set(0, 0, 0);
}

/* ---------------------------------------------------------------------- loop */

const clock = new THREE.Clock();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const desired = new THREE.Vector3();
const camTarget = new THREE.Vector3();

// Wrapped, not passed directly: setAnimationLoop hands the callback a rAF
// timestamp, which would be mistaken for a dt override.
renderer.setAnimationLoop(() => tick());

// `dtOverride` lets the loop be stepped deterministically (tests, debugging)
// instead of following wall-clock time.
function tick(dtOverride) {
  const dt = Math.min(dtOverride ?? clock.getDelta(), 0.05);

  // Input is relative to where the camera is looking.
  forward.set(Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw));
  right.set(forward.z, 0, -forward.x);

  desired.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) desired.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) desired.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) desired.sub(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) desired.add(right);

  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = running ? RUN_SPEED : WALK_SPEED;
  const moving = desired.lengthSq() > 0;
  if (moving) desired.normalize().multiplyScalar(speed);

  state.velocity.x = approach(state.velocity.x, desired.x, ACCEL * dt);
  state.velocity.z = approach(state.velocity.z, desired.z, ACCEL * dt);

  character.position.x += state.velocity.x * dt;
  character.position.z += state.velocity.z * dt;

  // Push back out of walls and furniture. Resolving position rather than
  // cancelling velocity lets her slide along a wall instead of gluing to it.
  if (level) {
    const before = { x: character.position.x, z: character.position.z };
    resolveCollisions(character.position, state.radius, level.colliders);
    // Kill the velocity component that was absorbed, so she doesn't keep
    // accelerating into a wall she cannot pass.
    if (character.position.x !== before.x) state.velocity.x = 0;
    if (character.position.z !== before.z) state.velocity.z = 0;
  }

  // Jump + gravity.
  if (keys.has('Space') && state.grounded) {
    state.vy = JUMP_SPEED;
    state.grounded = false;
  }
  if (!state.grounded) {
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.grounded = true;
    }
  }
  character.position.y = state.y;

  // Turn to face the input direction rather than the velocity — velocity gets
  // zeroed against the walls, which would make the facing wobble when pushing
  // into one.
  if (moving) {
    state.facing = angleTowards(
      state.facing,
      Math.atan2(desired.x, desired.z),
      TURN_SPEED * dt
    );
  } else {
    // Idle: come around to wherever the camera is looking.
    state.facing = angleTowards(state.facing, orbit.yaw, TURN_TO_CAMERA * dt);
  }
  character.rotation.y = state.facing;

  const planarSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  updateAnimation(planarSpeed, dt);
  updateCameraFollow(dt, moving, desired);

  state.punchTimer = Math.max(0, state.punchTimer - dt);
  state.cooldown = Math.max(0, state.cooldown - dt);
  updateCombat(dt);
  ghost?.update(dt);

  updateCamera(dt);
  renderer.render(scene, camera);
}

function updateAnimation(speed, dt) {
  if (!mixer) return;

  if (!state.grounded) {
    play(state.punchTimer > 0 ? 'jumpPunch' : 'jump');
  } else if (state.punchTimer > 0) {
    // Held by the one-shot until its 'finished' event clears the flag.
  } else if (speed < 0.1) {
    play('idle', 0.25);
  } else if (speed <= WALK_SPEED + 0.2) {
    play('walk');
    setRate('walk', speed);
  } else {
    const clip = speed > RUN_SPEED * 0.85 ? 'runFast' : 'run';
    play(clip);
    setRate(clip, speed);
  }

  mixer.update(dt);
}

// Match cycle playback to real ground speed so the feet stop skating.
function setRate(name, speed) {
  const action = actions[name];
  if (!action) return;
  action.setEffectiveTimeScale(clamp(speed / CLIP_SPEED[name], 0.6, 1.8));
}

// Resolves a punch once it reaches its strike frame: the ghost has to be within
// reach and in front of the character, not merely nearby.
function updateCombat(dt) {
  if (state.strikeAt <= 0) return;

  state.strikeAt -= dt;
  if (state.strikeAt > 0) return;
  state.strikeAt = 0;

  if (!ghost?.alive) return;

  const dx = ghost.position.x - character.position.x;
  const dz = ghost.position.z - character.position.z;
  if (Math.hypot(dx, dz) > PUNCH_REACH) return;
  if (Math.abs(angleDelta(Math.atan2(dx, dz), state.facing)) > PUNCH_ARC) return;

  const hits = ghost.hit(character.position);
  if (hits === null) return;

  state.hits = hits;
  updateHitPips();
  if (hits >= HITS_TO_BANISH) endGame();
}

function updateHitPips() {
  if (!pipsEl) return;
  for (const [i, pip] of [...pipsEl.children].entries()) {
    pip.classList.toggle('struck', i < state.hits);
  }
}

function endGame() {
  if (state.over) return;
  state.over = true;
  // Let the death animation play before the card lands.
  setTimeout(() => overlayEl?.classList.add('show'), 1400);
}

// Eases the camera back behind the character while she is running forwards.
//
// Deliberately skipped while strafing: movement input is camera-relative, so if
// the camera chased a sideways facing it would rotate the input frame, which
// rotates the facing again -- the character would curve away on a held strafe
// key. Recentering only when idle or running forwards keeps that loop open, and
// the camera still swings in behind the moment the strafe key is released.
function updateCameraFollow(dt, moving, dir) {
  if (orbit.dragging) {
    orbit.sinceDrag = 0;
    return;
  }
  orbit.sinceDrag += dt;
  if (orbit.sinceDrag < FOLLOW_DELAY) return;

  // Standing still, the character turns to the camera instead -- if both moved
  // at once they would meet in the middle and neither would end up where the
  // player pointed.
  if (!moving) return;

  const inputAngle = Math.atan2(dir.x, dir.z);
  if (Math.abs(angleDelta(inputAngle, orbit.yaw)) > FOLLOW_CONE) return;

  const diff = angleDelta(state.facing, orbit.yaw);
  if (Math.abs(diff) < FOLLOW_DEADZONE) return;

  const step = diff * FOLLOW_GAIN * dt;
  const cap = FOLLOW_MAX_RATE * dt;
  orbit.yaw += clamp(step, -cap, cap);
}

function updateCamera(dt) {
  camTarget.copy(character.position);
  camTarget.y += CHARACTER_HEIGHT * 0.6;

  const horizontal = Math.cos(orbit.pitch) * orbit.distance;
  const target = new THREE.Vector3(
    camTarget.x - Math.sin(orbit.yaw) * horizontal,
    camTarget.y + Math.sin(orbit.pitch) * orbit.distance,
    camTarget.z - Math.cos(orbit.yaw) * horizontal
  );

  // Indoors the camera would otherwise sit inside the walls. March out from
  // the character and stop at the last clear point.
  if (level) {
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = camTarget.x + (target.x - camTarget.x) * t;
      const z = camTarget.z + (target.z - camTarget.z) * t;
      if (isBlocked(x, z, level.colliders, CAMERA_MARGIN)) {
        const back = (i - 1) / steps;
        target.set(
          camTarget.x + (target.x - camTarget.x) * back,
          camTarget.y + (target.y - camTarget.y) * back,
          camTarget.z + (target.z - camTarget.z) * back
        );
        break;
      }
    }
  }

  camera.position.lerp(target, 1 - Math.pow(0.001, dt));
  camera.lookAt(camTarget);
}

/* --------------------------------------------------------------------- utils */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function approach(current, goal, maxDelta) {
  const diff = goal - current;
  if (Math.abs(diff) <= maxDelta) return goal;
  return current + Math.sign(diff) * maxDelta;
}

// Signed shortest angle from b to a, in (-pi, pi].
function angleDelta(a, b) {
  return ((a - b + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

// Shortest-path angular step, so turning past ±π doesn't spin the long way.
function angleTowards(current, goal, maxDelta) {
  let diff = ((goal - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (Math.abs(diff) <= maxDelta) return goal;
  return current + Math.sign(diff) * maxDelta;
}

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// Handy for poking at the controller from the console.
window.stella = {
  THREE, scene, camera, renderer, character, state, orbit,
  get level() { return level; },
  get ghost() { return ghost; },
  step: tick,
  get actions() { return actions; },
  get current() { return current?._clip?.name ?? null; },
  get mixer() { return mixer; },
};

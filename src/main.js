import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildManor, resolveCollisions, isBlocked } from './manor.js';
import { HITS_TO_BANISH } from './ghost.js';
import { spawnAxe, randomRestingPlace } from './axe.js';
import { createHaunting } from './coffin.js';
import { asset } from './assets.js';
import { isTouchDevice, setupTouchControls } from './touch.js';

const ASSET_DIR = asset('assets/characters/main-character');

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
let axe = null;
let haunting = null;
let handBone = null;
let handRestQuat = null;
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

// While playing, the camera steers: the character turns to match it, so the
// view stays over her shoulder. A/D swing the pair around together.
const TURN_TO_CAMERA = 7.0; // rad/s
const TURN_RATE = 2.4; // rad/s, how fast A/D swing the view around

// S backs her straight up, facing the camera -- the thing you want when you are
// edging away from a ghost and need to keep your eyes on it. Double-tapping S
// is the about-face instead: she spins 180 and runs that way, with the camera
// swinging in behind a moment later.
//
// The heading is latched when the about-face starts rather than read from the
// camera each frame. Recomputing it would mean that once the camera settled
// behind her she would read as "backwards" again -- and she would pivot, and
// pivot, and spin.
const REVERSE_TAP_WINDOW = 0.3; // s between the two S presses
const REVERSE_TURN_SPEED = 9; // rad/s for the about-face itself
const REVERSE_CAMERA_DELAY = 0.35; // s of watching her turn before the camera moves
const REVERSE_CAMERA_GAIN = 3.2;
const REVERSE_CAMERA_MAX_RATE = 3.4; // rad/s

// Dragging the mouse breaks that link and frees the camera, so you can orbit
// right around and look at her. She holds her ground while you do -- if she
// kept following the camera you could never get in front of her. Touch a
// movement key, or leave the mouse alone for a moment, and it settles back.
const FREE_LOOK_HOLD = 1.4; // s of no mouse before the camera returns
const RETURN_GAIN = 2.2; // proportional pull back to behind her
const RETURN_MAX_RATE = 2.6; // rad/s ceiling, so it glides rather than snaps
const RETURN_SETTLED = 0.025; // rad; close enough to hand control back
const DEFAULT_PITCH = 0.28; // the resting over-the-shoulder height

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
// Bare fists wear the ghost down over HITS_TO_BANISH blows; the axe ends it in
// one, which is the whole point of going to fetch it.
const AXE_IS_LETHAL = true;

// The ghost hits back. Brief invulnerability after a blow stops a single
// encounter draining the whole bar, and gives the player time to swing or run.
const MAX_HEALTH = 3;
const INVULN_TIME = 1.4;
const HURT_KNOCKBACK = 1.1;

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
scene.add(moon);

// Three lights that would otherwise come and go during play: the axe's while it
// waits to be found, the coffin's, and the ghost's. three compiles its shaders
// against the number of lights in the scene, so adding or removing one
// invalidates every material and recompiles the lot -- about 80 ms here, and it
// lands on exactly the frames you least want it: the coffin hitting the floor,
// the ghost climbing out, the axe going into her hand. Made once, before the
// first render, and handed to their owners parked at zero; from then on only
// their position and intensity change and the count never moves.
const hauntLights = {
  axe: parkedLight(),
  coffin: parkedLight(),
  ghost: parkedLight(),
};

function parkedLight() {
  // Below the floor rather than at the origin: dark either way, but a stray
  // light at her feet would be a confusing thing to go looking for.
  const light = new THREE.PointLight(0xffffff, 0, 1, 2);
  light.position.set(0, -50, 0);
  scene.add(light);
  return light;
}

// The shadow frustum has to cover the whole floor plan, so it is sized from the
// level once that is built rather than hardcoded to one map's dimensions.
function fitShadowsToLevel() {
  const s = moon.shadow.camera;
  s.left = -level.bounds.x - 2;
  s.right = level.bounds.x + 2;
  s.top = level.bounds.z + 2;
  s.bottom = -level.bounds.z - 2;
  s.near = 0.5;
  s.far = 60;
  s.updateProjectionMatrix();
  moon.position.set(level.bounds.x * 0.4, 16, level.bounds.z * 0.5);
}

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
  armed: false,
  health: MAX_HEALTH,
  invuln: 0,
  reversing: false,
  aboutFace: false, // the double-tap has been seen; latch on the next frame
  reverseDir: 0, // latched heading for the about-face
  reverseCam: 0, // delay before the camera follows her round
};

let mixer = null;
const actions = {};
let current = null;

/* ------------------------------------------------------------------- controls */

const keys = new Set();
const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space',
]);

addEventListener('keydown', (e) => {
  if (MOVE_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));

// Two S presses inside the window arm the about-face; it then holds for as long
// as S is. Held-key repeats are ignored, or leaning on S would trigger it.
let lastBackPress = -Infinity;
addEventListener('keydown', (e) => {
  if (e.repeat || (e.code !== 'KeyS' && e.code !== 'ArrowDown')) return;
  const now = performance.now() / 1000;
  if (now - lastBackPress <= REVERSE_TAP_WINDOW) state.aboutFace = true;
  lastBackPress = now;
});

// Punch is a one-shot rather than a held state, so it fires on the keypress
// instead of being polled in the loop.
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.repeat) return;
  tryPunch();
});

function tryPunch() {
  if (state.cooldown > 0 || state.over) return;
  const clip = state.grounded ? (Math.random() < 0.5 ? 'punch' : 'punchAlt') : 'jumpPunch';
  if (!actions[clip]) return;
  state.punchTimer = PUNCH_HOLD;
  state.cooldown = PUNCH_COOLDOWN;
  state.strikeAt = PUNCH_STRIKE_TIME;
  play(clip, 0.1, true);
}

// On a phone the stick and buttons stand in for the keyboard. Jump is a
// one-shot request rather than a held key: faking a timed keypress made her
// re-jump the moment she landed, since the loop treats a held Space as
// "jump again".
let jumpRequested = false;

const touch = isTouchDevice()
  ? setupTouchControls({
      onJump: () => { jumpRequested = true; },
      onAttack: tryPunch,
    })
  : null;
addEventListener('blur', () => keys.clear());

// Orbit camera: yaw/pitch around the character, mouse or touch drag.
const orbit = {
  yaw: Math.PI * 0.15,
  pitch: DEFAULT_PITCH,
  distance: 4.2,
  dragging: false,
  lastX: 0,
  lastY: 0,
  free: false, // true while the camera is off the leash
  sinceMouse: 0, // seconds since the last drag
};

canvas.addEventListener('pointerdown', (e) => {
  orbit.dragging = true;
  orbit.free = true;
  orbit.sinceMouse = 0;
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
  orbit.sinceMouse = 0;
});
const endDrag = (e) => {
  orbit.dragging = false;
  orbit.sinceMouse = 0;
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
    fitShadowsToLevel();

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

    // Solve the axe's grip against the idle pose rather than the bind pose:
    // idle is a frozen frame she spends most of her time in, so the axe reads
    // upright when standing and swings with the arm when she moves. The bind
    // pose puts the hand somewhere she is never actually in.
    mixer.update(0);
    character.updateWorldMatrix(true, true);
    if (handBone) handRestQuat = handBone.getWorldQuaternion(new THREE.Quaternion());

    loaderEl.classList.add('done');
    setTimeout(() => loaderEl.remove(), 700);
    hud.hidden = false;
    document.getElementById('tracker').hidden = false;

    // Remaining clips load in the background; each is pulled out of its file
    // and its skinned mesh discarded.
    spawnAxe({ scene, level, position: randomRestingPlace(level, { away: level.spawn }), glow: hauntLights.axe })
      .then((a) => { axe = a; })
      .catch((err) => console.error('axe failed to spawn', err));

    // There is exactly one ghost in the manor and the coffin brings it: no
    // free-roaming ghost is spawned here, and each haunting clears the previous
    // one before releasing the next.
    //
    // Needs the level (for wall drop spots and colliders) and the character to
    // land beside; state.radius is measured in normalizeAndAdd, above.
    haunting = createHaunting({
      scene,
      level,
      character,
      characterRadius: state.radius,
      onAttack: hurtPlayer,
      onGhost: (g) => { ghost = g; },
      glow: hauntLights.coffin,
      ghostGlow: hauntLights.ghost,
    });

    // Compile the haunting's shaders and upload its textures while nothing is
    // happening. Without this the first frame the coffin (or the ghost) is
    // drawn on stalls for as long as the compile takes -- a visible hitch on
    // the drop, which is the one moment the player is looking straight at it.
    haunting.ready
      .then(async (models) => {
        for (const model of models) {
          // compileAsync walks the visible graph, so anything parked out of
          // sight has to be shown for the length of the compile.
          const wasVisible = model.visible;
          model.visible = true;
          await renderer.compileAsync(model, camera, scene);
          model.visible = wasVisible;
        }
      })
      .catch((err) => console.error('haunting: warm-up failed', err));

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

  // The rig's hand bone is where the axe will be parented once it's picked up.
  model.traverse((o) => {
    if (o.isBone && o.name === 'RightHand') handBone = o;
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
const reverseHeading = new THREE.Vector3();
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

  // A/D turn rather than strafe: with the camera locked behind her, turning is
  // what actually steers. Q/E keep a sidestep for when you want one.
  const stick = touch?.move;
  const turn =
    (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) +
    (keys.has('KeyD') || keys.has('ArrowRight') ? -1 : 0) +
    (stick ? -stick.x : 0);
  if (turn) orbit.yaw += turn * TURN_RATE * dt;

  const forwardKey = keys.has('KeyW') || keys.has('ArrowUp');
  const backKey = keys.has('KeyS') || keys.has('ArrowDown');

  if (backKey && !forwardKey) {
    if (state.aboutFace && !state.reversing) {
      state.reversing = true;
      state.reverseDir = orbit.yaw + Math.PI;
      state.reverseCam = REVERSE_CAMERA_DELAY;
    }
    // Keep A/D steering her while she runs, turning her with the view.
    if (state.reversing) state.reverseDir += turn * TURN_RATE * dt;
  } else {
    // Letting go of S ends the about-face; the next one needs its own two taps.
    state.reversing = false;
    state.aboutFace = false;
  }

  desired.set(0, 0, 0);
  if (forwardKey) desired.add(forward);
  if (state.reversing) desired.add(reverseHeading.set(Math.sin(state.reverseDir), 0, Math.cos(state.reverseDir)));
  else if (backKey) desired.sub(forward);
  if (keys.has('KeyE')) desired.add(right);
  if (keys.has('KeyQ')) desired.sub(right);
  // The stick is analog: how far it is pushed sets the pace, so a gentle push
  // walks and a full one runs, without a separate run button.
  if (stick && stick.y !== 0) desired.addScaledVector(forward, stick.y);

  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const push = stick ? Math.abs(stick.y) : 0;
  const speed = push > 0
    ? WALK_SPEED + (RUN_SPEED - WALK_SPEED) * clamp((push - 0.45) / 0.55, 0, 1)
    : running ? RUN_SPEED : WALK_SPEED;
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
  if ((keys.has('Space') || jumpRequested) && state.grounded) {
    state.vy = JUMP_SPEED;
    state.grounded = false;
  }
  jumpRequested = false;
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
  // Locked play: the camera owns the facing, so her back is always to it.
  // During free look she holds still and the camera moves around her instead.
  // Backing up is the exception -- she turns to the latched heading and the
  // camera follows her round, which reads as an about-face, not a moonwalk.
  if (state.reversing) {
    state.facing = angleTowards(state.facing, state.reverseDir, REVERSE_TURN_SPEED * dt);

    state.reverseCam = Math.max(0, state.reverseCam - dt);
    if (state.reverseCam <= 0) {
      const diff = angleDelta(state.reverseDir, orbit.yaw);
      const cap = REVERSE_CAMERA_MAX_RATE * dt;
      orbit.yaw += clamp(diff * REVERSE_CAMERA_GAIN * dt, -cap, cap);
    }
  } else if (!orbit.free) {
    state.facing = angleTowards(state.facing, orbit.yaw, TURN_TO_CAMERA * dt);
  }
  character.rotation.y = state.facing;

  updateFreeLook(dt, moving || turn !== 0);

  const planarSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  updateAnimation(planarSpeed, dt);

  state.punchTimer = Math.max(0, state.punchTimer - dt);
  state.cooldown = Math.max(0, state.cooldown - dt);
  state.invuln = Math.max(0, state.invuln - dt);
  updateAxe(dt);
  updateCombat(dt);
  // The haunting drives the ghost -- it owns the only one there is. Ticking it
  // here as well ran it at double speed (and double clip rate, so its feet
  // skated), which is why it could outrun a sprint.
  haunting?.update(dt);

  updateCamera(dt);
  renderer.render(scene, camera);
}

function updateAnimation(speed, dt) {
  if (!mixer) return;

  // Travelling against the way she faces means she is walking backwards.
  const backwards =
    !state.reversing &&
    speed > 0.1 &&
    state.velocity.x * Math.sin(state.facing) + state.velocity.z * Math.cos(state.facing) < 0;

  if (!state.grounded) {
    play(state.punchTimer > 0 ? 'jumpPunch' : 'jump');
  } else if (state.punchTimer > 0) {
    // Held by the one-shot until its 'finished' event clears the flag.
  } else if (speed < 0.1) {
    play('idle', 0.25);
  } else if (speed <= WALK_SPEED + 0.2) {
    play('walk');
    setRate('walk', speed, backwards);
  } else {
    const clip = speed > RUN_SPEED * 0.85 ? 'runFast' : 'run';
    play(clip);
    setRate(clip, speed, backwards);
  }

  mixer.update(dt);
}

// Match cycle playback to real ground speed so the feet stop skating.
function setRate(name, speed, backwards = false) {
  const action = actions[name];
  if (!action) return;
  // Reversing the clip when backing up beats moonwalking, and costs nothing.
  const rate = clamp(speed / CLIP_SPEED[name], 0.6, 1.8);
  action.setEffectiveTimeScale(backwards ? -rate : rate);
}

// Hands the camera back to the character after a spell of free looking: either
// the player started moving again, or the mouse has been still long enough.
function updateFreeLook(dt, playerIsDriving) {
  if (!orbit.free) return;

  // Reaching for the controls always wins -- no waiting out the timer.
  if (playerIsDriving) {
    orbit.free = false;
    return;
  }

  if (orbit.dragging) {
    orbit.sinceMouse = 0;
    return;
  }

  orbit.sinceMouse += dt;
  if (orbit.sinceMouse < FREE_LOOK_HOLD) return;

  // Glide back behind her, levelling the pitch on the way.
  const diff = angleDelta(state.facing, orbit.yaw);
  const cap = RETURN_MAX_RATE * dt;
  orbit.yaw += clamp(diff * RETURN_GAIN * dt, -cap, cap);
  orbit.pitch += (DEFAULT_PITCH - orbit.pitch) * Math.min(1, RETURN_GAIN * dt);

  if (Math.abs(angleDelta(state.facing, orbit.yaw)) < RETURN_SETTLED) {
    orbit.yaw = state.facing;
    orbit.free = false;
  }
}

// Hovers the axe until the character walks into it, then puts it in her hand.
function updateAxe(dt) {
  if (!axe) return;
  axe.update(dt);

  if (axe.equipped || !handBone || !handRestQuat) return;
  if (!axe.isNear(character.position)) return;

  if (axe.attachTo(handBone, handRestQuat)) {
    state.armed = true;
    document.getElementById('tracker')?.classList.add('armed');
  }
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

  const hits = ghost.hit(character.position, state.armed && AXE_IS_LETHAL);
  if (hits === null) return;

  state.hits = hits;
  updateHitPips();
  if (hits >= HITS_TO_BANISH) endGame();
}

// Called by the ghost when a swipe connects.
function hurtPlayer(from) {
  if (state.over || state.invuln > 0) return;

  state.health--;
  state.invuln = INVULN_TIME;

  // Shoved away from the ghost, but never into a wall.
  const dx = character.position.x - from.x;
  const dz = character.position.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = character.position.x + (dx / len) * HURT_KNOCKBACK;
  const nz = character.position.z + (dz / len) * HURT_KNOCKBACK;
  if (level && !isBlocked(nx, nz, level.colliders, state.radius)) {
    character.position.x = nx;
    character.position.z = nz;
  }

  updateHearts();
  document.getElementById('hurt')?.classList.remove('flash');
  // Reflow so the animation restarts even on back-to-back hits.
  void document.getElementById('hurt')?.offsetWidth;
  document.getElementById('hurt')?.classList.add('flash');

  if (state.health <= 0) endGame(false);
}

function updateHearts() {
  const el = document.getElementById('hearts');
  if (!el) return;
  for (const [i, heart] of [...el.children].entries()) {
    heart.classList.toggle('lost', i >= state.health);
  }
}

function updateHitPips() {
  if (!pipsEl) return;
  for (const [i, pip] of [...pipsEl.children].entries()) {
    pip.classList.toggle('struck', i < state.hits);
  }
}

function endGame(won = true) {
  if (state.over) return;
  state.over = true;

  const title = document.getElementById('over-title');
  const detail = document.getElementById('over-detail');
  if (title && detail) {
    title.textContent = won ? 'The manor is quiet again' : 'The manor keeps you';
    detail.textContent = won
      ? 'Three hits landed. The ghost is gone.'
      : 'The ghost caught you in the dark.';
  }
  overlayEl?.classList.toggle('lost', !won);

  // Let the death animation play before the card lands.
  setTimeout(() => overlayEl?.classList.add('show'), won ? 1400 : 900);
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

  // Coffin impact kick. Applied after lookAt so the jolt shows as a shove of
  // the whole frame rather than being cancelled by the re-orient.
  const shake = haunting?.shake ?? 0;
  if (shake > 0.001) {
    const amp = shake * shake * 0.5;
    camera.position.x += (Math.random() - 0.5) * amp;
    camera.position.y += (Math.random() - 0.5) * amp;
    camera.position.z += (Math.random() - 0.5) * amp;
  }
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
  THREE, scene, camera, renderer, character, state, orbit, keys,
  get level() { return level; },
  get ghost() { return ghost; },
  get axe() { return axe; },
  get handBone() { return handBone; },
  step: tick,
  get actions() { return actions; },
  get current() { return current?._clip?.name ?? null; },
  get mixer() { return mixer; },
  get haunting() { return haunting; },
  haunt: () => haunting?.trigger(),
  banish: () => haunting?.banish(),
};

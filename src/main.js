import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MODEL_URL = '/assets/characters/main-character/main-character.glb';

// The box the character is confined to: half-extents on the ground plane.
const ROOM = { half: 6, height: 5 };
const CHARACTER_HEIGHT = 1.8;

const WALK_SPEED = 2.4;
const RUN_SPEED = 5.0;
const ACCEL = 14;
const TURN_SPEED = 12;
const JUMP_SPEED = 4.2;
const GRAVITY = 12;

/* ------------------------------------------------------------------ renderer */

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1015);
scene.fog = new THREE.Fog(0x0d1015, 16, 40);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);

/* ---------------------------------------------------------------------- room */

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ROOM.half * 2, ROOM.half * 2),
  new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.92, metalness: 0 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(ROOM.half * 2, ROOM.half * 4, 0x55607a, 0x39415a);
grid.position.y = 0.002;
scene.add(grid);

// Wireframe walls, so the box reads as a box without hiding the character.
const box = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.half * 2, ROOM.height, ROOM.half * 2),
  new THREE.MeshBasicMaterial({ color: 0x3f4a63, wireframe: true, transparent: true, opacity: 0.35 })
);
box.position.y = ROOM.height / 2;
scene.add(box);

/* ------------------------------------------------------------------- lighting */

scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x2b3240, 0.7));

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(4, 8, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
const s = key.shadow.camera;
s.left = -ROOM.half - 1;
s.right = ROOM.half + 1;
s.top = ROOM.half + 1;
s.bottom = -ROOM.half - 1;
s.near = 0.5;
s.far = 30;
s.updateProjectionMatrix();
scene.add(key);

const rim = new THREE.DirectionalLight(0x7fa8ff, 0.8);
rim.position.set(-5, 4, -6);
scene.add(rim);

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
  bob: 0,
};

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
addEventListener('blur', () => keys.clear());

// Orbit camera: yaw/pitch around the character, mouse or touch drag.
const orbit = { yaw: Math.PI * 0.15, pitch: 0.28, distance: 7, dragging: false, lastX: 0, lastY: 0 };

canvas.addEventListener('pointerdown', (e) => {
  orbit.dragging = true;
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
});
const endDrag = (e) => {
  orbit.dragging = false;
  if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.distance = clamp(orbit.distance + e.deltaY * 0.004, 2.5, 18);
}, { passive: false });

/* --------------------------------------------------------------------- loader */

const loaderEl = document.getElementById('loader');
const barFill = document.getElementById('bar-fill');
const statusEl = document.getElementById('loader-status');
const hud = document.getElementById('hud');

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    normalizeAndAdd(gltf.scene);
    loaderEl.classList.add('done');
    setTimeout(() => loaderEl.remove(), 700);
    hud.hidden = false;
  },
  (evt) => {
    if (evt.total) {
      const pct = Math.round((evt.loaded / evt.total) * 100);
      barFill.style.width = `${pct}%`;
      statusEl.textContent = `${pct}%`;
    } else {
      statusEl.textContent = `${(evt.loaded / 1e6).toFixed(1)} MB`;
    }
  },
  (err) => {
    console.error(err);
    statusEl.textContent = 'Failed to load model — see console.';
  }
);

// The GLB is a raw scan: arbitrary scale, arbitrary origin. Rescale it to a
// human height and drop its feet onto y = 0, centered on the controller.
function normalizeAndAdd(model) {
  model.updateWorldMatrix(true, true);

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  const scale = CHARACTER_HEIGHT / size.y;
  model.scale.setScalar(scale);
  model.position.set(
    -center.x * scale,
    -bounds.min.y * scale,
    -center.z * scale
  );

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
      if (o.material) o.material.envMapIntensity = 0.9;
    }
  });

  modelPivot.add(model);

  // Collision radius from the model's footprint, so it stops at the walls
  // rather than clipping through them.
  state.radius = (Math.max(size.x, size.z) * scale) / 2;

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

  // Keep the character inside the box.
  const limit = ROOM.half - state.radius;
  if (Math.abs(character.position.x) > limit) {
    character.position.x = Math.sign(character.position.x) * limit;
    state.velocity.x = 0;
  }
  if (Math.abs(character.position.z) > limit) {
    character.position.z = Math.sign(character.position.z) * limit;
    state.velocity.z = 0;
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
  }
  character.rotation.y = state.facing;

  // The model has no animation clips, so movement gets a procedural bob and a
  // slight lean into the direction of travel to sell the motion.
  const planarSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  const gait = planarSpeed / RUN_SPEED;
  state.bob += dt * (6 + gait * 8);
  modelPivot.position.y = state.grounded ? Math.abs(Math.sin(state.bob)) * 0.05 * gait : 0;
  modelPivot.rotation.z = Math.sin(state.bob) * 0.03 * gait;
  modelPivot.rotation.x = -gait * 0.08;

  updateCamera(dt);
  renderer.render(scene, camera);
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
window.stella = { scene, camera, character, state, orbit, step: tick };

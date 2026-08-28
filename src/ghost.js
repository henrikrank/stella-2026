import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isBlocked } from './manor.js';
import { asset } from './assets.js';

/**
 * A ghost that wanders the manor on its own.
 *
 * "Randomly" here means a random *destination*, not a random direction: the
 * ghost builds a navigation grid from the level's colliders and paths to its
 * target, so it walks through doorways and around the furniture instead of
 * grinding along walls.
 */

const DIR = asset('assets/characters/ghost');
const BASE_URL = `${DIR}/ghost-biped-Animation-Walking-withSkin.glb`;
const CLIP_FILES = {
  run: 'ghost-biped-Animation-Running-withSkin.glb',
  strut: 'ghost-biped-Animation-Flirty-Strut-withSkin.glb',
  hit: 'ghost-biped-Animation-Hit-Reaction-withSkin.glb',
  dead: 'ghost-biped-Animation-Dead-withSkin.glb',
};

// Every reaction clip travels: the stagger covers 1.13 m, the death 0.70 m.
// Their horizontal motion is stripped and re-applied in code, so a hit can
// never shove the ghost through a wall.
const ONE_SHOTS = new Set(['hit', 'dead']);

export const HITS_TO_BANISH = 3;
const STUN_TIME = 1.15;
const KNOCKBACK = 0.75;
const FADE_TIME = 2.2;

const HEIGHT = 1.75;
const NAV_CELL = 0.5; // navigation grid resolution, metres
const RADIUS = 0.32; // clearance the ghost needs from walls and furniture
const WALK_SPEED = 1.1;
const RUN_SPEED = 2.6;
const TURN_SPEED = 6;
const ARRIVE = 0.28; // how close counts as reaching a waypoint
const CLIP_SPEED = { walk: 1.5, run: 3.4 };

export async function spawnGhost({ scene, level }) {
  const loader = new GLTFLoader();
  const base = await loader.loadAsync(BASE_URL);

  const group = new THREE.Group();
  scene.add(group);

  const model = base.scene;
  model.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = HEIGHT / size.y;
  model.scale.multiplyScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);

  model.traverse((o) => {
    if (!o.isMesh) return;
    // Ghosts cast no shadow, and shadows are the expensive part anyway.
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.renderOrder = 2;

    // Keep the character's own colour map but wash it cold and translucent.
    // depthWrite off stops the ghost from occluding itself in slabs.
    const src = o.material;
    o.material = new THREE.MeshStandardMaterial({
      map: src.map ?? null,
      emissiveMap: src.map ?? null,
      emissive: new THREE.Color(0x74b8ff),
      emissiveIntensity: 0.55,
      color: new THREE.Color(0x8fd0ff),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  });

  group.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  const addClip = (name, clip) => {
    if (!clip) return;
    stripHorizontalRootMotion(clip);
    const action = mixer.clipAction(clip);
    if (ONE_SHOTS.has(name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[name] = action;
  };
  addClip('walk', base.animations[0]);

  // A cold light travelling with it, so the rooms react as it drifts past.
  const glow = new THREE.PointLight(0x86c5ff, 5, 6, 2);
  glow.position.y = 1.2;
  group.add(glow);

  // --- navigation -----------------------------------------------------------

  const minX = -level.bounds.x;
  const minZ = -level.bounds.z;
  const cols = Math.floor((level.bounds.x * 2) / NAV_CELL);
  const rows = Math.floor((level.bounds.z * 2) / NAV_CELL);

  const cellX = (c) => minX + (c + 0.5) * NAV_CELL;
  const cellZ = (r) => minZ + (r + 0.5) * NAV_CELL;

  // A cell is walkable if the ghost's clearance circle fits there.
  const walkable = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(!isBlocked(cellX(c), cellZ(r), level.colliders, RADIUS));
    }
    walkable.push(row);
  }

  const open = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (walkable[r][c]) open.push({ r, c });
  }
  if (!open.length) throw new Error('ghost: no walkable cells in the level');

  const toCell = (v) => ({
    r: Math.min(rows - 1, Math.max(0, Math.floor((v.z - minZ) / NAV_CELL))),
    c: Math.min(cols - 1, Math.max(0, Math.floor((v.x - minX) / NAV_CELL))),
  });

  // Breadth-first search: the grid is ~1700 cells, so this is cheap enough to
  // run on arrival without a frame budget worth worrying about.
  function findPath(from, to) {
    if (!walkable[to.r][to.c]) return null;
    const key = (r, c) => r * cols + c;
    const prev = new Map();
    const seen = new Set([key(from.r, from.c)]);
    const queue = [from];

    while (queue.length) {
      const cur = queue.shift();
      if (cur.r === to.r && cur.c === to.c) {
        const path = [];
        let node = cur;
        while (node) {
          path.unshift(new THREE.Vector3(cellX(node.c), 0, cellZ(node.r)));
          node = prev.get(key(node.r, node.c));
        }
        return path;
      }
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = cur.r + dr;
        const c = cur.c + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        if (!walkable[r][c] || seen.has(key(r, c))) continue;
        seen.add(key(r, c));
        prev.set(key(r, c), cur);
        queue.push({ r, c });
      }
    }
    return null;
  }

  // Start somewhere far from the player's spawn so it has to be found.
  const start = open.reduce((best, cell) => {
    const d = (cellX(cell.c) - level.spawn.x) ** 2 + (cellZ(cell.r) - level.spawn.z) ** 2;
    return d > best.d ? { cell, d } : best;
  }, { cell: open[0], d: -1 }).cell;
  group.position.set(cellX(start.c), 0, cellZ(start.r));

  let path = null;
  let waypoint = 0;
  let facing = 0;
  let pause = 1.5;
  let running = false;
  let current = null;
  let bob = 0;
  let stun = 0;
  let hits = 0;
  let dead = false;
  let fade = 0;
  const materials = [];
  model.traverse((o) => { if (o.isMesh) materials.push(o.material); });

  // The remaining clips stream in after the ghost is already walking.
  Promise.all(
    Object.entries(CLIP_FILES).map(([name, file]) =>
      loader.loadAsync(`${DIR}/${file}`).then((g) => addClip(name, g.animations[0]))
    )
  ).catch((err) => console.error('ghost clips failed to load', err));

  play('walk');
  retarget();

  function play(name, fade = 0.25) {
    const next = actions[name];
    if (!next || next === current) return;
    if (current) current.fadeOut(fade);
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    current = next;
  }

  function retarget() {
    const from = toCell(group.position);
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = open[Math.floor(Math.random() * open.length)];
      // Ignore destinations that are barely a step away.
      if (Math.abs(target.r - from.r) + Math.abs(target.c - from.c) < 6) continue;
      const found = findPath(from, target);
      if (found && found.length > 1) {
        path = found;
        waypoint = 1;
        running = Math.random() < 0.25;
        play(running ? 'run' : 'walk');
        return;
      }
    }
    path = null;
  }

  /**
   * Registers a hit from `source`. A `lethal` hit (the axe) finishes it
   * outright. Returns the running hit count, or null if the ghost is already
   * gone, so a flurry of blows can't overkill it.
   */
  function hit(source, lethal = false) {
    if (dead) return null;

    hits = lethal ? HITS_TO_BANISH : hits + 1;
    stun = STUN_TIME;
    path = null;

    // Knock it back, but only into space it is allowed to occupy.
    const dx = group.position.x - source.x;
    const dz = group.position.z - source.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = group.position.x + (dx / len) * KNOCKBACK;
    const nz = group.position.z + (dz / len) * KNOCKBACK;
    if (!isBlocked(nx, nz, level.colliders, RADIUS)) {
      group.position.x = nx;
      group.position.z = nz;
    }

    // Face its attacker as it reels.
    facing = Math.atan2(-dx, -dz);
    group.rotation.y = facing;

    if (hits >= HITS_TO_BANISH) {
      dead = true;
      play('dead', 0.12);
    } else {
      play('hit', 0.08);
    }
    return hits;
  }

  function update(dt) {
    mixer.update(dt);

    if (dead) {
      // Settle onto the floor -- the death clip drops the body, and the idle
      // hover would otherwise leave it lying in mid-air.
      group.position.y = Math.max(0, group.position.y - dt * 0.4);
      // Sink and dissolve once the death clip has played out.
      fade = Math.min(fade + dt, FADE_TIME + 1);
      const t = Math.max(0, (fade - 1) / FADE_TIME);
      for (const m of materials) m.opacity = 0.42 * (1 - t);
      glow.intensity = 5 * (1 - t);
      group.visible = t < 1;
      return;
    }

    if (stun > 0) {
      stun -= dt;
      if (stun <= 0) retarget();
      return;
    }

    // Drift: a ghost should never look quite planted on the floor.
    bob += dt;
    group.position.y = 0.06 + Math.sin(bob * 1.6) * 0.05;
    glow.intensity = 4.2 + Math.sin(bob * 2.7) * 1.1;

    if (pause > 0) {
      pause -= dt;
      if (pause <= 0) retarget();
      return;
    }

    if (!path || waypoint >= path.length) {
      // Arrived: linger for a moment, with a flourish if it has loaded.
      pause = 1.2 + Math.random() * 2.5;
      play(actions.strut ? 'strut' : 'walk');
      path = null;
      return;
    }

    const target = path[waypoint];
    const dx = target.x - group.position.x;
    const dz = target.z - group.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE) {
      waypoint++;
      return;
    }

    const speed = running ? RUN_SPEED : WALK_SPEED;
    group.position.x += (dx / dist) * speed * dt;
    group.position.z += (dz / dist) * speed * dt;

    facing = angleTowards(facing, Math.atan2(dx, dz), TURN_SPEED * dt);
    group.rotation.y = facing;

    const clip = running ? 'run' : 'walk';
    actions[clip]?.setEffectiveTimeScale(speed / CLIP_SPEED[clip]);
  }

  return {
    group,
    update,
    hit,
    get position() { return group.position; },
    get alive() { return !dead; },
    get hits() { return hits; },
    get target() { return path?.[path.length - 1] ?? null; },
  };
}

function stripHorizontalRootMotion(clip) {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = 0;
      track.values[i + 2] = 0;
    }
  }
}

function angleTowards(current, goal, maxDelta) {
  let diff = ((goal - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (Math.abs(diff) <= maxDelta) return goal;
  return current + Math.sign(diff) * maxDelta;
}

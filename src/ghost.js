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

// Hunting. The ghost notices the player inside AGGRO and gives up past LOSE --
// the gap between the two stops it flickering between wandering and chasing
// when the player sits right on the boundary.
const AGGRO_RANGE = 7.5;
const LOSE_RANGE = 11;
const CHASE_SPEED = 2.9;
const REACH = 1.15; // how close it must be to land a blow
const SWIPE_COOLDOWN = 1.6; // seconds between blows
const REPATH_INTERVAL = 0.35; // how often the chase path is recomputed

// It strikes and withdraws rather than grinding away at the player: after a
// blow (or after taking one) it breaks off and keeps its distance for a while
// before closing in again.
const FLEE_AFTER_SWIPE = 3.2; // seconds spent retreating after landing a blow
const FLEE_AFTER_HIT = 4; // longer after being hit -- it has learnt something
const FLEE_SPEED = 3.4; // faster than it chases; it is genuinely running
const FLEE_MIN_GAP = 6; // how far away a retreat spot has to be
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

// `start` optionally places the ghost at a world position instead of the
// far corner -- used by the coffin, which decides where its ghost appears.
export async function spawnGhost({ scene, level, start: startAt = null, target = null, onAttack = null }) {
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

  // Start somewhere far from the player's spawn so it has to be found, unless
  // the caller nominated a spot.
  if (startAt) {
    group.position.set(startAt.x, 0, startAt.z);
  } else {
    const start = open.reduce((best, cell) => {
      const d = (cellX(cell.c) - level.spawn.x) ** 2 + (cellZ(cell.r) - level.spawn.z) ** 2;
      return d > best.d ? { cell, d } : best;
    }, { cell: open[0], d: -1 }).cell;
    group.position.set(cellX(start.c), 0, cellZ(start.r));
  }

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
  let hunting = false;
  let repathIn = 0;
  let swipeIn = 0;
  let fleeIn = 0;
  let flash = 0;
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
      // Back off once it has finished reeling.
      startFleeing(FLEE_AFTER_HIT);
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

    // Cold glow normally; hot for a moment after it lands a blow.
    flash = Math.max(0, flash - dt);
    glow.color.setHex(flash > 0 ? 0xff6a4a : 0x86c5ff);

    if (hunt(dt)) return;

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

    followPath(dt, running ? RUN_SPEED : WALK_SPEED, running ? 'run' : 'walk');
  }

  /**
   * Chases the player. Returns true when it has taken the frame, leaving the
   * wandering below untouched.
   */
  function hunt(dt) {
    swipeIn = Math.max(0, swipeIn - dt);
    if (!target) return false;

    const dx = target.position.x - group.position.x;
    const dz = target.position.z - group.position.z;
    const range = Math.hypot(dx, dz);

    // Hysteresis: a wide band to give up in, so it doesn't dither on the edge.
    if (!hunting && range < AGGRO_RANGE) {
      hunting = true;
      path = null;
      repathIn = 0;
      pause = 0;
    } else if (hunting && range > LOSE_RANGE) {
      hunting = false;
      path = null;
      retarget();
      return false;
    }
    if (!hunting) return false;

    if (fleeIn > 0) {
      fleeIn -= dt;

      // Repath while retreating, so it keeps backing away as the player gives
      // chase instead of running to one fixed spot and stopping there.
      repathIn -= dt;
      if (repathIn <= 0 || !path || waypoint >= path.length) {
        repathIn = REPATH_INTERVAL;
        const bolt = retreatCell();
        if (bolt) {
          path = bolt;
          waypoint = 1;
        }
      }

      play('run');
      followPath(dt, FLEE_SPEED, 'run');
      return true;
    }

    if (range <= REACH) {
      // In reach: stop, square up, and swipe on the beat.
      facing = angleTowards(facing, Math.atan2(dx, dz), TURN_SPEED * dt);
      group.rotation.y = facing;
      play('walk');
      actions.walk?.setEffectiveTimeScale(0.35);

      if (swipeIn <= 0) {
        swipeIn = SWIPE_COOLDOWN;
        flash = 0.35;
        glow.intensity = 14;
        onAttack?.(group.position);
        startFleeing(FLEE_AFTER_SWIPE);
      }
      return true;
    }

    // Path to the player rather than steering straight at them, so walls and
    // furniture route the chase instead of pinning it against a corner.
    repathIn -= dt;
    if (repathIn <= 0 || !path || waypoint >= path.length) {
      repathIn = REPATH_INTERVAL;
      // The player can stand where the ghost cannot fit (right against a wall,
      // wedged by a chair), so aim at the nearest cell it can actually occupy.
      const goal = nearestWalkable(toCell(target.position));
      const found = goal && findPath(toCell(group.position), goal);
      if (found && found.length > 1) {
        path = found;
        waypoint = 1;
      }
    }

    play('run');
    if (path && waypoint < path.length) {
      followPath(dt, CHASE_SPEED, 'run');
    } else {
      // No route at all -- close the gap directly rather than standing still,
      // which is what a frozen chase looks like.
      const len = Math.hypot(dx, dz) || 1;
      const nx = group.position.x + (dx / len) * CHASE_SPEED * dt;
      const nz = group.position.z + (dz / len) * CHASE_SPEED * dt;
      if (!isBlocked(nx, nz, level.colliders, RADIUS)) {
        group.position.x = nx;
        group.position.z = nz;
      }
      facing = angleTowards(facing, Math.atan2(dx, dz), TURN_SPEED * dt);
      group.rotation.y = facing;
    }
    return true;
  }

  /** Nearest cell the ghost can stand in, spiralling out from `cell`. */
  function nearestWalkable(cell) {
    if (walkable[cell.r]?.[cell.c]) return cell;
    for (let ring = 1; ring <= 6; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = cell.r + dr;
          const c = cell.c + dc;
          if (walkable[r]?.[c]) return { r, c };
        }
      }
    }
    return null;
  }

  function startFleeing(seconds) {
    fleeIn = seconds;
    path = null;
    repathIn = 0;
  }

  /**
   * Picks somewhere to bolt to: reachable, and putting real distance between
   * it and the player. Sampling beats scanning every cell, and the retreat is
   * recomputed often enough that a mediocre pick corrects itself.
   */
  function retreatCell() {
    if (!target) return null;
    const from = toCell(group.position);
    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < 40; i++) {
      const cell = open[Math.floor(Math.random() * open.length)];
      const gap = Math.hypot(cellX(cell.c) - target.position.x, cellZ(cell.r) - target.position.z);
      if (gap < FLEE_MIN_GAP) continue;

      // Far from the player, but not halfway across the manor.
      const trek = Math.hypot(cellX(cell.c) - group.position.x, cellZ(cell.r) - group.position.z);
      const score = gap - trek * 0.35;
      if (score <= bestScore) continue;

      const route = findPath(from, cell);
      if (route && route.length > 1) {
        best = route;
        bestScore = score;
      }
    }
    return best;
  }

  // Walks one step along the current path, advancing the waypoint on arrival.
  function followPath(dt, speed, clip) {
    const node = path[waypoint];
    if (!node) return;

    const dx = node.x - group.position.x;
    const dz = node.z - group.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE) {
      waypoint++;
      return;
    }

    group.position.x += (dx / dist) * speed * dt;
    group.position.z += (dz / dist) * speed * dt;

    facing = angleTowards(facing, Math.atan2(dx, dz), TURN_SPEED * dt);
    group.rotation.y = facing;

    actions[clip]?.setEffectiveTimeScale(speed / (CLIP_SPEED[clip] ?? 1));
  }

  return {
    group,
    update,
    hit,
    get position() { return group.position; },
    get alive() { return !dead; },
    get hits() { return hits; },
    get destination() { return path?.[path.length - 1] ?? null; },
    get hunting() { return hunting; },
    get fleeing() { return fleeIn > 0; },
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

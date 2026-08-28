import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { asset } from './assets.js';

/**
 * Builds the manor level from the OBJ pack.
 *
 * The pack is authored in real-world metres, Y-up, with every model's feet at
 * y = 0, and the wall is a 1 m x 3 m module. That makes a 1 m grid the natural
 * unit, so the floor plan below is literally the level: one character per
 * square metre. Edit the map, get a different manor.
 */

const CELL = 1;

// # wall   P pillar   . floor
// T dining table   c chair   B book case   S side table (short)   L side table (long)
// f floor lamp   H heater   p painting (wall-mounted)
const PLAN = [
  '########################',
  '#p.........B..B..B..B.p#',
  '#.........P......P.....#',
  '#......................#',
  '#..f...................#',
  '#......c...............#',
  '#.....cTc..............#',
  '#......c.......S....S..#',
  '#......................#',
  '#.........P......P.....#',
  '#H....................f#',
  '###########..###########',
  '#..B..B................#',
  '#...........f.........p#',
  '#......................#',
  '#pfL...............H...#',
  '#......................#',
  '########################',
];

// obj: path under the pack. tex: basename of the texture set (the loader reads
// from the flattened derived/ folder, which sidesteps the fact that the source
// Wall/ and Pillar/ texture folders have each other's maps in them).
const ASSETS = {
  '#': { name: 'wall', obj: 'Structure/Wall/MansionWall.obj', tex: 'MansionWall', collide: true, orient: 'run' },
  P: { name: 'pillar', obj: 'Structure/Pillar/MansionPillar.obj', tex: 'MansionPillar', collide: true },
  T: { name: 'table', obj: 'Props/Dining Table/DiningTable.obj', tex: 'DiningTable', collide: true, surface: true },
  c: { name: 'chair', obj: 'Props/Chair/Chair.obj', tex: 'Chair', collide: true, faces: 'T' },
  B: { name: 'bookcase', obj: 'Props/Book Case/BookCase.obj', tex: 'BookCase', collide: true, orient: 'backToWall' },
  S: { name: 'sideShort', obj: 'Props/Side Tables/Short/SideTable_Short.obj', tex: 'SideTable_Short', collide: true, surface: true, orient: 'backToWall' },
  L: { name: 'sideLong', obj: 'Props/Side Tables/Long/SideTable_Long.obj', tex: 'SideTable_Long', collide: true, surface: true, orient: 'backToWall' },
  f: { name: 'lamp', obj: 'Props/Floor Lamp/FloorLamp.obj', tex: 'FloorLamp', collide: true, light: 'lamp' },
  H: { name: 'heater', obj: 'Props/Heater/Heater.obj', tex: 'Heater', collide: true, orient: 'backToWall' },
  p: { name: 'painting', obj: 'Props/Painting Frame/PaintingFrame.obj', tex: 'PaintingFrame', orient: 'onWall', height: 1.7 },
};

// Dressing placed on top of anything flagged `surface`, at its measured height.
const CANDLE = { obj: 'Props/Candle/Candle.obj', tex: 'Candle' };
const BOOKS = { obj: 'Props/Books/Books.obj', tex: 'Books' };

const SRC = asset('assets/manor/assets');
const TEX = asset('assets/manor/derived');

export async function buildManor({ scene, renderer }) {
  const rows = PLAN.length;
  const cols = PLAN[0].length;
  const bad = PLAN.findIndex((r) => r.length !== cols);
  if (bad !== -1) throw new Error(`manor plan row ${bad} is ${PLAN[bad].length} wide, expected ${cols}`);

  const objLoader = new OBJLoader();
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const texture = (file, srgb) => {
    const t = texLoader.load(`${TEX}/${file}`);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.flipY = false; // OBJ UVs match glTF convention here
    return t;
  };

  // One geometry + material per asset type, shared by every copy placed.
  const prototypes = new Map();
  async function prototype(def) {
    if (prototypes.has(def.tex)) return prototypes.get(def.tex);

    const group = await objLoader.loadAsync(`${SRC}/${def.obj}`);
    let geometry = null;
    group.traverse((o) => {
      if (o.isMesh && !geometry) geometry = o.geometry;
    });
    if (!geometry) throw new Error(`no mesh in ${def.obj}`);

    // Centre horizontally, leave the feet on y = 0 as authored.
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    geometry.translate(-cx, -bb.min.y, -cz);
    geometry.computeBoundingBox();
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      map: texture(`${def.tex}_Base_color.png`, true),
      normalMap: texture(`${def.tex}_Normal.png`),
      roughnessMap: texture(`${def.tex}_Roughness.png`),
      metalnessMap: texture(`${def.tex}_Metallic.png`),
      metalness: 1,
      roughness: 1,
      envMapIntensity: 0.35,
    });

    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    const proto = { geometry, material, size };
    prototypes.set(def.tex, proto);
    return proto;
  }

  const at = (r, c) => (PLAN[r] ? PLAN[r][c] ?? '.' : '.');
  const solid = (r, c) => at(r, c) === '#' || at(r, c) === 'P';

  // Grid -> world. The plan is centred on the origin.
  const worldX = (c) => (c - (cols - 1) / 2) * CELL;
  const worldZ = (r) => (r - (rows - 1) / 2) * CELL;

  const root = new THREE.Group();
  scene.add(root);
  const colliders = [];
  const lights = [];
  const surfaces = [];

  // Pre-load every prototype in parallel before placing anything.
  const used = [...new Set(PLAN.join('').split('').filter((ch) => ASSETS[ch]))];
  await Promise.all(used.map((ch) => prototype(ASSETS[ch])));
  const candleProto = await prototype(CANDLE);
  const booksProto = await prototype(BOOKS);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = at(r, c);
      const def = ASSETS[ch];
      if (!def) continue;

      const proto = prototypes.get(def.tex);
      const mesh = new THREE.Mesh(proto.geometry, proto.material);
      mesh.name = def.name;
      mesh.userData.cell = { r, c, ch };
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(worldX(c), 0, worldZ(r));

      let footprint = { x: proto.size.x, z: proto.size.z };

      if (def.orient === 'run') {
        // A wall segment is 1 m wide and thin; turn it to follow the run of
        // walls it belongs to, so corners meet instead of crossing.
        const horizontal = solid(r, c - 1) || solid(r, c + 1);
        if (!horizontal) {
          mesh.rotation.y = Math.PI / 2;
          footprint = { x: proto.size.z, z: proto.size.x };
        }
      } else if (def.orient === 'backToWall' || def.orient === 'onWall') {
        const wall = nearestWallDir(r, c);
        if (!wall && def.orient === 'onWall') {
          // A painting with no wall behind it would hang in mid-air. Say so
          // rather than shipping floating art.
          console.warn(`manor: '${ch}' at row ${r}, col ${c} has no adjacent wall -- skipped`);
          continue;
        }
        // Freestanding furniture is fine mid-room; it just faces south.
        if (!wall) {
          mesh.rotation.y = 0;
        } else {
          mesh.rotation.y = Math.atan2(-wall.dx, -wall.dz);
          if (Math.abs(wall.dx) > Math.abs(wall.dz)) footprint = { x: proto.size.z, z: proto.size.x };
          // Sit flush against the wall face rather than floating in the cell.
          mesh.position.x += wall.dx * (CELL / 2 - proto.size.z / 2);
          mesh.position.z += wall.dz * (CELL / 2 - proto.size.z / 2);
          if (def.orient === 'onWall') {
            mesh.position.y = def.height - proto.size.y / 2;
            mesh.castShadow = false;
          }
        }
      } else if (def.faces) {
        const target = nearestChar(r, c, def.faces);
        if (target) {
          const tx = worldX(target.c);
          const tz = worldZ(target.r);
          const dx = mesh.position.x - tx;
          const dz = mesh.position.z - tz;
          const len = Math.hypot(dx, dz) || 1;
          mesh.rotation.y = Math.atan2(tx - mesh.position.x, tz - mesh.position.z);

          // A grid cell puts the chair 1 m from the table's centre, which is
          // inside a 2.69 m table. Seat it against the measured edge instead.
          const targetSize = prototypes.get(ASSETS[def.faces].tex).size;
          const reach = Math.abs(dx) > Math.abs(dz) ? targetSize.x / 2 : targetSize.z / 2;
          const dist = reach + proto.size.z / 2 + 0.04;
          mesh.position.x = tx + (dx / len) * dist;
          mesh.position.z = tz + (dz / len) * dist;
        }
      }

      if (def.collide) {
        colliders.push({
          // Tagged so callers can tell structure from furniture -- the coffin
          // looks for walls specifically to land against.
          name: def.name,
          minX: mesh.position.x - footprint.x / 2,
          maxX: mesh.position.x + footprint.x / 2,
          minZ: mesh.position.z - footprint.z / 2,
          maxZ: mesh.position.z + footprint.z / 2,
        });
      }

      if (def.light === 'lamp') {
        const lamp = new THREE.PointLight(0xffb570, 14, 9, 2);
        lamp.position.set(mesh.position.x, proto.size.y * 0.92, mesh.position.z);
        lights.push(lamp);
        root.add(lamp);
      }

      if (def.surface) surfaces.push({ x: mesh.position.x, z: mesh.position.z, top: proto.size.y, size: proto.size });

      root.add(mesh);
    }
  }

  // Dress the tables: a candle on each, books on the wider ones.
  for (const [i, s] of surfaces.entries()) {
    const candle = new THREE.Mesh(candleProto.geometry, candleProto.material);
    candle.castShadow = true;
    candle.position.set(s.x + 0.12, s.top, s.z - 0.1);
    root.add(candle);

    // A candle that lights nothing is just a stick; give it a small flame.
    const flame = new THREE.PointLight(0xffa54a, 2.2, 3.2, 2);
    flame.position.set(candle.position.x, s.top + candleProto.size.y + 0.05, candle.position.z);
    root.add(flame);
    lights.push(flame);

    if (s.size.x > 1) {
      const books = new THREE.Mesh(booksProto.geometry, booksProto.material);
      books.castShadow = true;
      books.position.set(s.x - 0.25, s.top, s.z + 0.15);
      books.rotation.y = i * 1.1;
      root.add(books);
    }
  }

  // Floor and ceiling, reusing the wall stone so the rooms read as one build.
  const floorTex = texture('MansionWall_Base_color.png', true);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(cols / 2, rows / 2);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(cols * CELL, rows * CELL),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(cols * CELL, rows * CELL),
    new THREE.MeshStandardMaterial({ color: 0x1b1712, roughness: 1, metalness: 0 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3;
  root.add(ceiling);

  // Spawn in the middle of the great hall, clear of the table.
  const spawn = new THREE.Vector3(worldX(3), 0, worldZ(8));

  return { root, colliders, lights, spawn, bounds: { x: (cols * CELL) / 2, z: (rows * CELL) / 2 } };

  function nearestWallDir(r, c) {
    const dirs = [
      { dx: 0, dz: -1, r: r - 1, c },
      { dx: 0, dz: 1, r: r + 1, c },
      { dx: -1, dz: 0, r, c: c - 1 },
      { dx: 1, dz: 0, r, c: c + 1 },
    ];
    return dirs.find((d) => solid(d.r, d.c)) ?? null;
  }

  function nearestChar(r, c, target) {
    let best = null;
    let bestDist = Infinity;
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        if (at(rr, cc) !== target) continue;
        const d = (rr - r) ** 2 + (cc - c) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = { r: rr, c: cc };
        }
      }
    }
    return best;
  }
}

/**
 * Circle-vs-AABB resolution, applied per axis so sliding along a wall works
 * instead of sticking. Mutates `position`.
 */
export function resolveCollisions(position, radius, colliders) {
  for (const box of colliders) {
    const closestX = Math.max(box.minX, Math.min(position.x, box.maxX));
    const closestZ = Math.max(box.minZ, Math.min(position.z, box.maxZ));
    const dx = position.x - closestX;
    const dz = position.z - closestZ;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;

    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = radius - dist;
      position.x += (dx / dist) * push;
      position.z += (dz / dist) * push;
    } else {
      // Dead centre of the box: push out along the shallowest axis.
      const toLeft = position.x - box.minX;
      const toRight = box.maxX - position.x;
      const toTop = position.z - box.minZ;
      const toBottom = box.maxZ - position.z;
      const min = Math.min(toLeft, toRight, toTop, toBottom);
      if (min === toLeft) position.x = box.minX - radius;
      else if (min === toRight) position.x = box.maxX + radius;
      else if (min === toTop) position.z = box.minZ - radius;
      else position.z = box.maxZ + radius;
    }
  }
}

/** True if (x, z) sits inside any collider, expanded by `margin`. */
export function isBlocked(x, z, colliders, margin = 0) {
  for (const b of colliders) {
    if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) {
      return true;
    }
  }
  return false;
}

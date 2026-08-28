/**
 * Generates the manor's floor plan: three rooms in different places every run,
 * joined by corridors.
 *
 * The output is the same ASCII grid the hand-drawn map used, one character per
 * square metre, so everything downstream is unchanged.
 *
 *   # wall   . floor   (props share the legend in manor.js)
 *
 * Only solid cells that actually touch a floor cell become walls. Filling the
 * void would put a mesh on every unused square -- hundreds of them, all of them
 * invisible behind the walls you can see.
 */

const WIDTH = 44;
const HEIGHT = 32;

const ROOMS = 3;
const ROOM_MIN = { w: 10, h: 8 };
const ROOM_MAX = { w: 16, h: 12 };
const ROOM_GAP = 3; // solid cells kept between rooms, so they never share a wall
const CORRIDOR_WIDTH = 2;

const VOID = ' ';
const FLOOR = '.';
const WALL = '#';

/** Deterministic RNG, so a seed can reproduce a layout exactly. */
function makeRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

export function generatePlan({ seed = (Math.random() * 1e9) | 0 } = {}) {
  // A bad roll (rooms that will not fit) is cheaper to discard than to repair.
  for (let attempt = 0; attempt < 60; attempt++) {
    const plan = attemptPlan(makeRng(seed + attempt * 7919));
    if (plan) return { rows: plan.rows, rooms: plan.rooms, spawn: plan.spawn, seed };
  }
  throw new Error('manor: could not generate a plan');
}

function attemptPlan(rng) {
  const grid = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(VOID));
  const pick = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  const rooms = [];
  for (let tries = 0; tries < 400 && rooms.length < ROOMS; tries++) {
    const w = pick(ROOM_MIN.w, ROOM_MAX.w);
    const h = pick(ROOM_MIN.h, ROOM_MAX.h);
    const x = pick(2, WIDTH - w - 3);
    const y = pick(2, HEIGHT - h - 3);
    const room = { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };

    const clashes = rooms.some(
      (o) =>
        x - ROOM_GAP < o.x + o.w &&
        x + w + ROOM_GAP > o.x &&
        y - ROOM_GAP < o.y + o.h &&
        y + h + ROOM_GAP > o.y
    );
    if (!clashes) rooms.push(room);
  }
  if (rooms.length < ROOMS) return null;

  for (const room of rooms) {
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) grid[r][c] = FLOOR;
    }
  }

  // Chain the rooms together with L-shaped corridors, then add one more link so
  // the manor loops instead of dead-ending.
  const links = rooms.slice(1).map((room, i) => [rooms[i], room]);
  links.push([rooms[rooms.length - 1], rooms[0]]);
  for (const [a, b] of links) {
    if (rng() < 0.5) {
      carveH(grid, a.cy, a.cx, b.cx);
      carveV(grid, b.cx, a.cy, b.cy);
    } else {
      carveV(grid, a.cx, a.cy, b.cy);
      carveH(grid, b.cy, a.cx, b.cx);
    }
  }

  // Wall off anything solid that touches open floor; the rest stays void.
  for (let r = 0; r < HEIGHT; r++) {
    for (let c = 0; c < WIDTH; c++) {
      if (grid[r][c] !== VOID) continue;
      if (touchesFloor(grid, r, c)) grid[r][c] = WALL;
    }
  }

  const spawn = { r: rooms[0].cy, c: rooms[0].x + 1 };
  if (grid[spawn.r][spawn.c] !== FLOOR) return null;
  if (!fullyConnected(grid)) return null;

  dressRooms(grid, rooms, rng, spawn);

  return { rows: grid.map((row) => row.join('')), rooms, spawn };
}

function carveH(grid, row, c0, c1) {
  const [from, to] = c0 < c1 ? [c0, c1] : [c1, c0];
  for (let c = from; c <= to; c++) {
    for (let w = 0; w < CORRIDOR_WIDTH; w++) {
      const r = row + w;
      if (grid[r] && grid[r][c] !== undefined) grid[r][c] = FLOOR;
    }
  }
}

function carveV(grid, col, r0, r1) {
  const [from, to] = r0 < r1 ? [r0, r1] : [r1, r0];
  for (let r = from; r <= to; r++) {
    for (let w = 0; w < CORRIDOR_WIDTH; w++) {
      const c = col + w;
      if (grid[r] && grid[r][c] !== undefined) grid[r][c] = FLOOR;
    }
  }
}

function touchesFloor(grid, r, c) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (grid[r + dr]?.[c + dc] === FLOOR) return true;
    }
  }
  return false;
}

const isOpen = (ch) => ch !== undefined && ch !== VOID && ch !== WALL;

function fullyConnected(grid) {
  let start = null;
  let total = 0;
  for (let r = 0; r < HEIGHT; r++) {
    for (let c = 0; c < WIDTH; c++) {
      if (!isOpen(grid[r][c])) continue;
      total++;
      start ??= { r, c };
    }
  }
  if (!start) return false;

  const seen = new Set([start.r * WIDTH + start.c]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const { r, c } = queue[head];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isOpen(grid[nr]?.[nc]) || seen.has(nr * WIDTH + nc)) continue;
      seen.add(nr * WIDTH + nc);
      queue.push({ r: nr, c: nc });
    }
  }
  return seen.size === total;
}

/** True when a cell has a wall next to it -- where the wall-hugging props go. */
function againstWall(grid, r, c) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => grid[r + dr]?.[c + dc] === WALL);
}

/**
 * Furnishes the rooms. Corridors are deliberately left bare: they are the way
 * through, and a bookcase in a 2 m passage is a roadblock, not decoration.
 */
function dressRooms(grid, rooms, rng, spawn) {
  const pick = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  rooms.forEach((room, index) => {
    const inside = [];
    const edges = [];
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        if (grid[r][c] !== FLOOR) continue;
        if (r === spawn.r && c === spawn.c) continue;
        (againstWall(grid, r, c) ? edges : inside).push({ r, c });
      }
    }
    shuffle(edges, rng);
    shuffle(inside, rng);

    const place = (list, ch, count) => {
      for (let n = 0; n < count && list.length; n++) {
        const { r, c } = list.pop();
        grid[r][c] = ch;
      }
    };

    // One room gets the dining set, if it has the space for the chairs.
    if (index === 0) {
      // The four chairs need clear floor, and none of the five cells may be the
      // spawn -- the player would start inside the furniture.
      const seat = inside.find(({ r, c }) =>
        !(r === spawn.r && c === spawn.c) &&
        [[1, 0], [-1, 0], [0, 1], [0, -1]].every(
          ([dr, dc]) =>
            grid[r + dr]?.[c + dc] === FLOOR &&
            !(r + dr === spawn.r && c + dc === spawn.c)
        )
      );
      if (seat) {
        grid[seat.r][seat.c] = 'T';
        grid[seat.r + 1][seat.c] = 'c';
        grid[seat.r - 1][seat.c] = 'c';
        grid[seat.r][seat.c + 1] = 'c';
        grid[seat.r][seat.c - 1] = 'c';
        // Those cells are spoken for now.
        for (let i = inside.length - 1; i >= 0; i--) {
          const { r, c } = inside[i];
          if (Math.abs(r - seat.r) <= 1 && Math.abs(c - seat.c) <= 1) inside.splice(i, 1);
        }
      }
    }

    place(edges, 'p', pick(2, 3)); // paintings need the wall
    place(edges, 'B', pick(2, 4));
    place(edges, 'H', 1);
    place(edges, 'S', pick(1, 2));
    place(edges, 'L', 1);
    place(inside, 'f', pick(1, 2)); // lamps stand out in the open
  });
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

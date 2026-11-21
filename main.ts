// A push-optimal Sokoban solver: one program answers a whole set of levels in
// as few pushes as it can. Node 22, standard library only, no clock, no
// randomness, so two runs write the same bytes.
//
// How it works, in short. A level is a hallway with rooms off it, and a box
// pushed out of a room's door can never come back, so each room is its own
// little puzzle and the level's optimum is the sum of the rooms'. The solver
// splits the level into rooms, solves each room on its own with an A* search
// over pushes, and stitches the rooms' move strings together with walks
// through the hallway. A search state is the boxes' squares plus the square
// the player stands on; the player walks for free between pushes, so only
// pushes cost. Two prunings keep the search small, and neither can cut a
// solvable position: a box on a square from which no sequence of pushes (the
// other boxes ignored) can ever reach a goal, and a 2 x 2 block of walls and
// boxes holding a box off its goal. The estimate guiding the search is the
// sum, over the boxes, of the fewest pushes each box still needs to reach a
// goal on its own; every push moves one box one square, so that sum can never
// overstate what is left, and the first solved state the search meets is
// push-optimal.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room's search keeps before it gives up: work, never the clock. */
const MAX_STATES = 1_500_000;

/** The four steps: [dx, dy, the step's letter, the push's letter]. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For every square, the fewest pushes a lone box standing there needs to reach
 * a goal (other boxes ignored, the player assumed able to stand anywhere open):
 * a backward breadth-first walk from the goals, a box pulled one square back
 * at a time, the player standing one square further back. -1 where no push
 * sequence reaches a goal at all: a dead square.
 */
function pushDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d; // the square the box is pulled back from
      if (wall[y] || wall[y - d] || dist[y] >= 0) continue;
      dist[y] = dist[x]! + 1;
      queue.push(y);
    }
  }
  return dist;
}

/** The squares the player reaches from `from` with `occupied` in the way; the lowest square reached. */
function regionLow(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes holding a box off a goal. */
function frozenBlock(level: Level, occupied: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !isGoal[a]) || (occupied[b] && !isGoal[b]) || (occupied[c] && !isGoal[c]) || (occupied[d] && !isGoal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower-case letters, first direction first on ties. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('no walk to the push square');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of one level (or one room of it), or null when the
 * search gives up. A* over pushes: a state is the boxes (sorted, packed into
 * one number) with the player's reachable region named by its lowest square;
 * the estimate is the summed lone-box push distance, which never overstates
 * the pushes left, so the first solved state met is optimal.
 */
function searchPushOptimal(level: Level, maxStates = MAX_STATES): SearchResult | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const n = startBoxes.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const dist = pushDistances(level);
  if (startBoxes.some((b) => dist[b] < 0)) return null;

  // Pack sorted boxes into one number, base `size`: exact while size ** n stays under 2 ** 53.
  const pack = (boxes: number[]): number => {
    let code = 0;
    for (const b of boxes) code = code * size + b;
    return code;
  };
  const unpack = (code: number): number[] => {
    const boxes = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
      boxes[i] = code % size;
      code = Math.floor(code / size);
    }
    return boxes;
  };
  const keyOf = (boxesCode: number, low: number): number => low * Math.pow(size, n) + boxesCode;
  const estimate = (boxes: number[]): number => {
    let sum = 0;
    for (const b of boxes) sum += dist[b]!;
    return sum;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states, in the order found: packed boxes, the player's square, the parent, the push that made them,
  // and the f value (pushes + estimate) the heap orders on. A state is only accepted as solved when it is
  // popped, not when it is made: with a consistent estimate that is what makes the first solved state optimal.
  const stateBoxes: number[] = [pack(startBoxes)];
  const statePlayer: number[] = [startPlayer];
  const statePushes: number[] = [0];
  const stateF: number[] = [estimate(startBoxes)];
  const stateKey: number[] = [];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const best = new Map<number, number>();
  for (const b of startBoxes) occupied[b] = 1;
  stateKey.push(keyOf(stateBoxes[0]!, regionLow(level, occupied, startPlayer, seen, ++stamp, stack), size));
  best.set(stateKey[0]!, 0);
  for (const b of startBoxes) occupied[b] = 0;

  // A binary heap on (f, pushes, order found): ties go by the order found, so runs agree.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    stateF[a]! < stateF[b]! || (stateF[a]! === stateF[b]! && (statePushes[a]! < statePushes[b]! || (statePushes[a]! === statePushes[b]! && a < b)));
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush(0);

  const solved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);
  let found = -1;
  while (heap.length > 0 && found < 0) {
    const s = heapPop();
    const g = statePushes[s]!;
    if (best.get(stateKey[s]!) !== g) continue; // a better way to this state was found since; skip the stale entry
    const boxes = unpack(stateBoxes[s]!);
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(level, occupied, statePlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || dist[t] < 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, isGoal, t);
        let code = -1;
        let key = -1;
        let h = -1;
        if (!frozen) {
          const next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          code = pack(next);
          key = keyOf(code, regionLow(level, occupied, b, mark, ++stamp, stack));
          h = estimate(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || code < 0) continue;
        const old = best.get(key);
        if (old !== undefined && old <= g + 1) continue;
        if (stateBoxes.length >= maxStates) return null;
        best.set(key, g + 1);
        stateBoxes.push(code);
        statePlayer.push(b);
        statePushes.push(g + 1);
        stateF.push(g + 1 + h);
        stateKey.push(key);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        heapPush(stateBoxes.length - 1);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The pushes, first to last, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b)).sort((a, b2) => a - b2);
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway,
 * where a box reaches no goal) out of the floor; each part left holding a box
 * is a room. Null when a box starts in the hallway, a goal is cut off, or a
 * room's boxes and goals do not match.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dist = pushDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && dist[i] < 0) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveLevel(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return searchPushOptimal(level);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done = new Set<{ squares: number[]; boxes: number[]; goals: number[] }>();
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      // A finished room's boxes sit on its goals and stay there; an unfinished room's boxes stand where they are.
      for (const b of done.has(other) ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPushOptimal(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done.add(room);
  }
  return { pushes, moves };
}

/** Solve one level's text; an empty answer when it gives up, never a crash. */
function solve(text: string): string {
  try {
    const solved = solveLevel(parseLevel(text));
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT).sort()) {
  if (!statSync(join(INPUT, id)).isDirectory()) continue; // a stray file in /input is not an instance
  const moves = solve(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}

/**
 * geometry.js — Room geometry engine
 * ------------------------------------------------------------------
 * PERMANENT DESIGN RULE (spec §1.1):
 *   A room is either a RECTANGLE or a SIMS FREEPLAY `L` (footprint minus one
 *   corner notch). Nothing else, ever.
 *
 * Room model
 *   { id, name, x, y, w, h, lshape, armW, armH }
 *
 *   x, y    footprint origin (integer cells, top-left)
 *   w, h    footprint size   (integer cells)
 *   lshape  null | 'NW' | 'NE' | 'SW' | 'SE'  — which corner is notched out
 *   armW    notch width  (horizontal arm of the missing corner)
 *   armH    notch height (vertical arm of the missing corner)
 *
 *   A valid L needs 1 <= armW <= w-1 and 1 <= armH <= h-1.
 *   Setting either arm to 0 collapses the notch => the room is a rectangle
 *   again (spec §6.2 "shortening the extension to zero restores a rectangle").
 */

export const LOT_PRESETS = {
  standard: {
    id: 'standard',
    name: 'Standard Lot',
    w: 18,
    h: 18,
    blurb: 'Classic residential plot',
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean View / Premium Lot',
    w: 18,
    h: 36,
    blurb: 'Beachfront estate plot',
  },
  penthouse: {
    id: 'penthouse',
    name: 'Penthouse',
    w: 12,
    h: 26,
    blurb: 'Top-floor apartment plot',
  },
};

export const LOT_LIST = Object.values(LOT_PRESETS);
export const CORNERS = ['NW', 'NE', 'SW', 'SE'];
export const STAIR_TYPES = {
  narrow: { id: 'narrow', name: 'Stair 1 × 5', w: 1, h: 5 },
  compact: { id: 'compact', name: 'Stair 2 × 3', w: 2, h: 3 },
};

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const isInt = (v) => Number.isFinite(v) && Math.floor(v) === v;

/* ------------------------------------------------------------------ */
/* Shape queries                                                       */
/* ------------------------------------------------------------------ */

export function isL(room) {
  return (
    !!room.lshape &&
    room.armW >= 1 &&
    room.armH >= 1 &&
    room.armW <= room.w - 1 &&
    room.armH <= room.h - 1
  );
}

/** Decompose a room into 1..2 axis-aligned rectangles (exact, lossless). */
export function rectsOf(room) {
  const { x, y, w, h } = room;
  if (!isL(room)) return [{ x, y, w, h }];

  const a = clamp(room.armW, 1, w - 1);
  const b = clamp(room.armH, 1, h - 1);

  switch (room.lshape) {
    case 'NW':
      return [
        { x: x + a, y, w: w - a, h },
        { x, y: y + b, w: a, h: h - b },
      ];
    case 'NE':
      return [
        { x, y, w: w - a, h },
        { x: x + w - a, y: y + b, w: a, h: h - b },
      ];
    case 'SW':
      return [
        { x: x + a, y, w: w - a, h },
        { x, y, w: a, h: h - b },
      ];
    case 'SE':
      return [
        { x, y, w: w - a, h },
        { x: x + w - a, y, w: a, h: h - b },
      ];
    default:
      return [{ x, y, w, h }];
  }
}

export function areaOf(room) {
  const base = room.w * room.h;
  return isL(room) ? base - room.armW * room.armH : base;
}

export const cellCount = areaOf;

export function rectContains(r, cx, cy) {
  return cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h;
}

export function roomContains(room, cx, cy) {
  if (cx < room.x || cy < room.y || cx >= room.x + room.w || cy >= room.y + room.h) {
    return false;
  }
  return rectsOf(room).some((r) => rectContains(r, cx, cy));
}

/** Screen/world point (float, world units) -> room hit test. */
export function pointInRoom(room, wx, wy) {
  return roomContains(room, Math.floor(wx), Math.floor(wy));
}

export function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

export function roomsOverlap(a, b) {
  if (a.id === b.id) return false;
  const A = rectsOf(a);
  const B = rectsOf(b);
  for (const ra of A) for (const rb of B) if (rectsOverlap(ra, rb)) return true;
  return false;
}

export function roomSupported(room, supportRooms) {
  const supportedCells = new Set();
  for (const supportRoom of supportRooms) {
    for (const rect of rectsOf(supportRoom)) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        for (let y = rect.y; y < rect.y + rect.h; y += 1) {
          supportedCells.add(`${x},${y}`);
        }
      }
    }
  }
  for (const rect of rectsOf(room)) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        if (!supportedCells.has(`${x},${y}`)) return false;
      }
    }
  }
  return true;
}

export function validateBalcony(balcony, rooms, balconies, lot, supportRooms) {
  if (![balcony.x, balcony.y, balcony.w, balcony.h].every(isInt)) {
    return fail('integer', 'Balcony must sit on whole grid cells.');
  }
  if (balcony.w < 1 || balcony.h < 1) {
    return fail('degenerate', 'Balcony must cover at least one grid cell.');
  }
  if (balcony.w === 1 && balcony.h === 1) {
    return fail('min-size', 'A 1 × 1 balcony is not allowed. The smallest balcony is 1 × 2.');
  }
  if (balcony.x < 0 || balcony.y < 0 || balcony.x + balcony.w > lot.w || balcony.y + balcony.h > lot.h) {
    return fail('bounds', 'Balcony cannot extend past the lot boundary.');
  }
  if (rooms.some((room) => roomsOverlap(balcony, room))) {
    return fail('overlap', 'Balcony cannot overlap a room.');
  }
  if (balconies.some((other) => roomsOverlap(balcony, other))) {
    return fail('overlap', 'Balconies cannot overlap each other.');
  }
  if (maxUnsupportedDistance(balcony, supportRooms) > 3) {
    return fail('balcony-depth', 'Balcony gray cells cannot be more than 3 grid cells from a supported cell.');
  }
  return { ok: true, code: 'ok', message: '' };
}

export function poolOuterRect(pool) {
  return { x: pool.x - 1, y: pool.y - 1, w: pool.w + 2, h: pool.h + 2 };
}

export function poolBlockedCells(pools) {
  const cells = new Set();
  for (const pool of pools) {
    const outer = poolOuterRect(pool);
    for (let x = outer.x; x < outer.x + outer.w; x += 1) {
      for (let y = outer.y; y < outer.y + outer.h; y += 1) {
        cells.add(`${x},${y}`);
      }
    }
  }
  return cells;
}

export function validatePool(pool, rooms, pools, lot) {
  if (![pool.x, pool.y, pool.w, pool.h].every(isInt)) {
    return fail('integer', 'Pool must sit on whole grid cells.');
  }
  if (pool.w < 3 || pool.h < 3) {
    return fail('min-size', 'A pool core must be at least 3 × 3 grid cells.');
  }
  const outer = poolOuterRect(pool);
  if (outer.x < 0 || outer.y < 0 || outer.x + outer.w > lot.w || outer.y + outer.h > lot.h) {
    return fail('bounds', 'The pool and its outer ring must fit within the lot boundary.');
  }
  if (rooms.some((room) => rectsOf(room).some((rect) => rectsOverlap(outer, rect)))) {
    return fail('overlap', 'A pool and its outer ring cannot overlap a room.');
  }
  if (pools.some((other) => rectsOverlap(pool, other))) {
    return fail('core-overlap', 'Pool cores cannot overlap each other.');
  }
  return { ok: true, code: 'ok', message: '' };
}

export function validatePatio(patio, rooms, pools, lot) {
  if (![patio.x, patio.y, patio.w, patio.h].every(isInt)) {
    return fail('integer', 'Patio must sit on whole grid cells.');
  }
  if (patio.w < 1 || patio.h < 1) {
    return fail('degenerate', 'Patio must cover at least one grid cell.');
  }
  if (patio.x < 0 || patio.y < 0 || patio.x + patio.w > lot.w || patio.y + patio.h > lot.h) {
    return fail('bounds', 'Patio cannot extend past the lot boundary.');
  }
  if (rooms.some((room) => roomsOverlap(patio, room))) {
    return fail('room-overlap', 'Patio cannot overlap a room.');
  }
  if (pools.some((pool) => rectsOverlap(patio, poolOuterRect(pool)))) {
    return fail('pool-overlap', 'Patio cannot overlap a pool core or its outer ring.');
  }
  return { ok: true, code: 'ok', message: '' };
}

export function validateMezzanine(mezzanine, lowerRooms, mezzanines, lot, upperRooms = null) {
  if (![mezzanine.x, mezzanine.y, mezzanine.w, mezzanine.h].every(isInt)) {
    return fail('integer', 'Mezzanine must sit on whole grid cells.');
  }
  if (mezzanine.w < 1 || mezzanine.h < 1 || mezzanine.w === 1 && mezzanine.h === 1) {
    return fail('degenerate', 'Mezzanine must be at least 1 × 2 cells.');
  }
  if (mezzanine.x < 0 || mezzanine.y < 0 ||
      mezzanine.x + mezzanine.w > lot.w || mezzanine.y + mezzanine.h > lot.h) {
    return fail('bounds', 'Mezzanine cannot extend past the lot boundary.');
  }
  const supportedByOneRoom = lowerRooms.some((room) => {
    for (let x = mezzanine.x; x < mezzanine.x + mezzanine.w; x += 1) {
      for (let y = mezzanine.y; y < mezzanine.y + mezzanine.h; y += 1) {
        if (!roomContains(room, x, y)) return false;
      }
    }
    return true;
  });
  if (!supportedByOneRoom) {
    return fail('support', 'Mezzanine must fit entirely inside one room on the floor below.');
  }
  if (upperRooms && !upperRooms.some((room) => {
    for (let x = mezzanine.x; x < mezzanine.x + mezzanine.w; x += 1) {
      for (let y = mezzanine.y; y < mezzanine.y + mezzanine.h; y += 1) {
        if (!roomContains(room, x, y)) return false;
      }
    }
    return true;
  })) {
    return fail('upper-support', 'Mezzanine must fit entirely inside one room on this floor.');
  }
  if (mezzanines.some((other) => other.id !== mezzanine.id && rectsOverlap(mezzanine, other))) {
    return fail('overlap', 'Mezzanines cannot overlap each other.');
  }
  return { ok: true, code: 'ok', message: '' };
}

export function validateDoor(door, rooms, doors = [], { interiorOnly = false } = {}) {
  if (!isInt(door.x) || !isInt(door.y) || !isInt(door.length) ||
      !['horizontal', 'vertical'].includes(door.orientation)) {
    return fail('integer', 'Door must align with whole grid cells on a room wall.');
  }

  if (door.length < 1 || door.length > 4) {
    return fail('length', 'Door width must be between 1 and 4 grid cells.');
  }
  for (let offset = 0; offset < door.length; offset += 1) {
    const sideA = door.orientation === 'horizontal'
      ? rooms.filter((room) => roomContains(room, door.x + offset, door.y - 1))
      : rooms.filter((room) => roomContains(room, door.x - 1, door.y + offset));
    const sideB = door.orientation === 'horizontal'
      ? rooms.filter((room) => roomContains(room, door.x + offset, door.y))
      : rooms.filter((room) => roomContains(room, door.x, door.y + offset));
    const separatesRooms = sideA.some((roomA) => sideB.some((roomB) => roomA.id !== roomB.id));
    if ((!sideA.length && !sideB.length) ||
        (sideA.length && sideB.length && !separatesRooms) ||
        (interiorOnly && (!sideA.length || !sideB.length || !separatesRooms))) {
      return fail('wall', interiorOnly
        ? 'Basement doors must be placed between two rooms.'
        : 'Doors must be placed on a room wall.');
    }
  }
  if (doors.some((other) => {
    if (other.id === door.id || other.orientation !== door.orientation) return false;
    const sameWall = door.orientation === 'horizontal' ? other.y === door.y : other.x === door.x;
    const start = door.orientation === 'horizontal' ? door.x : door.y;
    const otherStart = door.orientation === 'horizontal' ? other.x : other.y;
    return sameWall && start < otherStart + other.length && otherStart < start + door.length;
  })) {
    return fail('overlap', 'Doors cannot overlap each other.');
  }
  return { ok: true, code: 'ok', message: '' };
}

export function stairSize(stair) {
  const type = STAIR_TYPES[stair.type];
  if (!type) return null;
  return stair.rotated ? { w: type.h, h: type.w } : { w: type.w, h: type.h };
}

export function floorAbove(floor) {
  return floor === 'basement' ? '1' : String(Number(floor) + 1);
}

export function validateStair(stair, lowerRooms, upperRooms, stairs, lot, floors) {
  const size = stairSize(stair);
  if (!size || !isInt(stair.x) || !isInt(stair.y) ||
      typeof stair.lowerFloor !== 'string' || typeof stair.rotated !== 'boolean') {
    return fail('shape', 'Choose a stair type and align it to whole grid cells.');
  }
  const upperFloor = floorAbove(stair.lowerFloor);
  if (!floors.includes(stair.lowerFloor) || !floors.includes(upperFloor)) {
    return fail('floors', 'Stairs must connect two existing adjacent floors.');
  }
  if (stair.x < 0 || stair.y < 0 ||
      stair.x + size.w > lot.w || stair.y + size.h > lot.h) {
    return fail('bounds', 'Stairs cannot extend past the lot boundary.');
  }
  const lowerOwner = lowerRooms.find((room) => {
    for (let x = stair.x; x < stair.x + size.w; x += 1) {
      for (let y = stair.y; y < stair.y + size.h; y += 1) {
        if (!roomContains(room, x, y)) return false;
      }
    }
    return true;
  });
  if (!lowerOwner) {
    return fail('lower-room', 'Stairs must fit entirely inside one room on the lower floor.');
  }
  const upperOwner = upperRooms.find((room) => {
    for (let x = stair.x; x < stair.x + size.w; x += 1) {
      for (let y = stair.y; y < stair.y + size.h; y += 1) {
        if (!roomContains(room, x, y)) return false;
      }
    }
    return true;
  });
  if (!upperOwner) {
    return fail('upper-room', 'The upper floor needs one room covering the full stair opening.');
  }
  const exitCell = size.w >= size.h
    ? { x: stair.x + size.w, y: stair.y + Math.floor(size.h / 2) }
    : { x: stair.x + Math.floor(size.w / 2), y: stair.y - 1 };
  if (!roomContains(upperOwner, exitCell.x, exitCell.y)) {
    return fail('upper-exit', 'The upper room needs a clear exit in the direction the stairs face.');
  }
  const occupiedFloors = new Set([stair.lowerFloor, upperFloor]);
  for (const other of stairs) {
    if (other.id === stair.id) continue;
    const otherUpperFloor = floorAbove(other.lowerFloor);
    if (!occupiedFloors.has(other.lowerFloor) &&
        !occupiedFloors.has(otherUpperFloor)) continue;
    const otherSize = stairSize(other);
    if (!otherSize) continue;
    if (stair.x < other.x + otherSize.w && other.x < stair.x + size.w &&
        stair.y < other.y + otherSize.h && other.y < stair.y + size.h) {
      return fail('overlap', 'Stairs and stair openings cannot overlap on a floor.');
    }
  }
  return { ok: true, code: 'ok', message: '' };
}

function supportedCellSet(rooms) {
  const supported = new Set();
  for (const room of rooms) {
    for (const rect of rectsOf(room)) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        for (let y = rect.y; y < rect.y + rect.h; y += 1) supported.add(`${x},${y}`);
      }
    }
  }
  return supported;
}

function maxUnsupportedDistance(balcony, supportRooms) {
  const supported = supportedCellSet(supportRooms);
  let maxDistance = 0;
  for (let x = balcony.x; x < balcony.x + balcony.w; x += 1) {
    for (let y = balcony.y; y < balcony.y + balcony.h; y += 1) {
      if (supported.has(`${x},${y}`)) continue;
      let nearestDistance = Infinity;
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dy = -3; dy <= 3; dy += 1) {
          if (supported.has(`${x + dx},${y + dy}`)) {
            nearestDistance = Math.min(nearestDistance, Math.max(Math.abs(dx), Math.abs(dy)));
          }
        }
      }
      maxDistance = Math.max(maxDistance, nearestDistance);
    }
  }
  return maxDistance;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Spec §5.2 — the only size ban is exactly 1 x 1.
 * 1x2, 2x1, 3x1 ... are all legal. Do NOT turn this into "each side >= 2".
 */
export function minSizeOk(room) {
  return !(room.w === 1 && room.h === 1);
}

/** Returns { ok, reason } — reason is a short machine code + message pair. */
export function validateRoom(room, rooms, lot, supportRooms = null, blockedCells = null) {
  if (![room.x, room.y, room.w, room.h].every(isInt)) {
    return fail('integer', 'Room must sit on whole grid cells.');
  }
  if (room.w < 1 || room.h < 1) {
    return fail('degenerate', 'Room must be at least 1 cell wide and tall.');
  }
  if (room.x < 0 || room.y < 0 || room.x + room.w > lot.w || room.y + room.h > lot.h) {
    return fail('bounds', 'Room cannot extend past the lot boundary.');
  }
  if (!minSizeOk(room)) {
    return fail('min-size', 'A 1 × 1 room is not allowed. The smallest room is 1 × 2.');
  }
  if (room.lshape) {
    if (!isL(room)) {
      return fail('l-shape', 'L-shape arms must leave at least 1 cell of each side.');
    }
  }
  if (blockedCells && rectsOf(room).some((rect) => {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        if (blockedCells.has(`${x},${y}`)) return true;
      }
    }
    return false;
  })) {
    return fail('balcony-blocked', 'Rooms cannot be built on blocked cells.');
  }
  if (supportRooms && !roomSupported(room, supportRooms)) {
    return fail('unsupported', 'Every room cell must be supported by a 1F room.');
  }
  for (const other of rooms) {
    if (other.id === room.id) continue;
    if (roomsOverlap(room, other)) {
      return fail('overlap', `Room would overlap “${other.name}”.`);
    }
  }
  return { ok: true, code: 'ok', message: '' };
}

function fail(code, message) {
  return { ok: false, code, message };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Force a room object into a legal L / rectangle state without touching
 * footprint legality (coordinates) — arms that no longer fit collapse.
 */
export function normalizeShape(room) {
  const r = { ...room };
  if (!r.lshape || !CORNERS.includes(r.lshape)) {
    r.lshape = null;
    return r;
  }
  r.armW = clamp(Math.round(r.armW || 0), 0, r.w - 1);
  r.armH = clamp(Math.round(r.armH || 0), 0, r.h - 1);
  if (r.armW < 1 || r.armH < 1) {
    // Arm shortened to zero cells -> back to a rectangle (spec §6.2)
    r.lshape = null;
    r.armW = 0;
    r.armH = 0;
  }
  return r;
}

export function makeRoom(partial) {
  return normalizeShape({
    id: partial.id || uid('room'),
    name: partial.name || 'Room',
    x: partial.x | 0,
    y: partial.y | 0,
    w: partial.w | 0,
    h: partial.h | 0,
    lshape: partial.lshape || null,
    armW: partial.armW || 0,
    armH: partial.armH || 0,
  });
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now()
    .toString(36)
    .slice(-3)}`;
}

/* ------------------------------------------------------------------ */
/* Edge / corner anchors                                               */
/* ------------------------------------------------------------------ */

/** Footprint edge move -> candidate room. */
export function resizeEdge(room, edge, cellDelta) {
  const r = { ...room };
  switch (edge) {
    case 'W':
      r.x = room.x + cellDelta;
      r.w = room.w - cellDelta;
      break;
    case 'E':
      r.w = room.w + cellDelta;
      break;
    case 'N':
      r.y = room.y + cellDelta;
      r.h = room.h - cellDelta;
      break;
    case 'S':
      r.h = room.h + cellDelta;
      break;
    default:
      return r;
  }
  return normalizeShape(r);
}

/** Corner drag on a *rectangle* (L rooms use the renovator instead). */
export function resizeCorner(room, corner, dx, dy) {
  let r = { ...room };
  if (corner === 'NW' || corner === 'SW') r = resizeEdge(r, 'W', dx);
  if (corner === 'NE' || corner === 'SE') r = resizeEdge(r, 'E', dx);
  if (corner === 'NW' || corner === 'NE') r = resizeEdge(r, 'N', dy);
  if (corner === 'SW' || corner === 'SE') r = resizeEdge(r, 'S', dy);
  return r;
}

/* ------------------------------------------------------------------ */
/* Room Renovator — FreePlay mechanics                                 */
/* ------------------------------------------------------------------ */
/**
 * Reference: The Sims FreePlay room renovator.
 *   "Drag out a yellow arrow anchor point to extend a wall out. A green
 *    extrusion means it's clear to build, red means it cannot be built."
 *
 * Each of the 4 corners of a rectangular room carries two yellow anchors,
 * one per outward wall direction. Dragging one outward by `k` cells pulls a
 * 1-cell-thick strip off that wall, attached at the anchor corner — which is
 * geometrically identical to "footprint grew by k on that side, minus the
 * opposite corner region". That produces a true single L room.
 *
 * Returns { room, axis } or null when the move cannot form an L.
 *
 *  axis 'h' : dragged along the top/bottom wall (left/right)
 *  axis 'v' : dragged along the left/right wall (up/down)
 */
export function renovatorExtend(room, anchor, dir, k) {
  if (!room) return null;
  if (!isInt(k) || k < 1) return null;
  // A room already notched can't take another arm (FreePlay keeps one L).
  if (isL(room)) return null;
  if (k > 200) return null;

  const { x, y, w, h } = room;
  const horizontal = dir === 'left' || dir === 'right';
  const topSide = anchor === 'NW' || anchor === 'NE';
  const leftSide = anchor === 'NW' || anchor === 'SW';

  if (horizontal) {
    if (h < 2) return null; // need at least 1 notch row + 1 kept row
    const notchY = topSide ? 'S' : 'N'; // opposite vertical side
    const notchX = dir === 'left' ? 'W' : 'E';
    const next = {
      ...room,
      x: dir === 'left' ? x - k : x,
      w: w + k,
      lshape: `${notchY}${notchX}`,
      armW: k,
      armH: h - 1,
    };
    return normalizeShape(next);
  }

  if (w < 2) return null;
  const notchX = leftSide ? 'E' : 'W';
  const notchY = dir === 'up' ? 'N' : 'S';
  const next = {
    ...room,
    y: dir === 'up' ? y - k : y,
    h: h + k,
    lshape: `${notchY}${notchX}`,
    armW: w - 1,
    armH: k,
  };
  return normalizeShape(next);
}

/**
 * The interior (concave) corner of an L room, in world cell coordinates.
 * This is the handle used to widen / narrow the extension, and dragging it
 * until an arm reaches 0 restores a rectangle.
 */
export function innerCornerOf(room) {
  if (!isL(room)) return null;
  const a = clamp(room.armW, 1, room.w - 1);
  const b = clamp(room.armH, 1, room.h - 1);
  const px = room.lshape === 'NW' || room.lshape === 'SW' ? room.x + a : room.x + room.w - a;
  const py = room.lshape === 'NW' || room.lshape === 'NE' ? room.y + b : room.y + room.h - b;
  return { x: px, y: py };
}

/** Move the inner corner -> new arm sizes. Zero on either arm = rectangle. */
export function setInnerCorner(room, px, py) {
  if (!isL(room)) return room;
  const rightSide = room.lshape === 'NE' || room.lshape === 'SE';
  const bottomSide = room.lshape === 'SW' || room.lshape === 'SE';

  let armW = rightSide ? room.x + room.w - px : px - room.x;
  let armH = bottomSide ? room.y + room.h - py : py - room.y;

  armW = clamp(Math.round(armW), 0, room.w - 1);
  armH = clamp(Math.round(armH), 0, room.h - 1);

  const next = { ...room, armW, armH };
  if (armW < 1 || armH < 1) {
    return normalizeShape({ ...next, armW: 0, armH: 0 });
  }
  return normalizeShape(next);
}

/** Explicit "restore rectangle" (spec §6.2). */
export function toRectangle(room) {
  return normalizeShape({ ...room, lshape: null, armW: 0, armH: 0 });
}

/** Bounding box helper (label placement, mini previews). */
export function boundsOf(rooms) {
  if (!rooms.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rooms) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Area-weighted centroid of the room (for the label). */
export function centroidOf(room) {
  const rects = rectsOf(room);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const r of rects) {
    const ra = r.w * r.h;
    a += ra;
    cx += (r.x + r.w / 2) * ra;
    cy += (r.y + r.h / 2) * ra;
  }
  if (!a) return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
  return { x: cx / a, y: cy / a };
}

/** Outline polygon of the room, clockwise from its top-left-most vertex. */
export function outlineOf(room) {
  const { x, y, w, h } = room;
  if (!isL(room)) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }
  const a = clamp(room.armW, 1, w - 1);
  const b = clamp(room.armH, 1, h - 1);
  switch (room.lshape) {
    case 'NW':
      return [
        [x + a, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x, y + b],
        [x + a, y + b],
      ];
    case 'NE':
      return [
        [x, y],
        [x + w - a, y],
        [x + w - a, y + b],
        [x + w, y + b],
        [x + w, y + h],
        [x, y + h],
      ];
    case 'SW':
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x + a, y + h],
        [x + a, y + h - b],
        [x, y + h - b],
      ];
    case 'SE':
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h - b],
        [x + w - a, y + h - b],
        [x + w - a, y + h],
        [x, y + h],
      ];
    default:
      return [];
  }
}

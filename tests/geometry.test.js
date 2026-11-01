import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rectsOf,
  areaOf,
  isL,
  minSizeOk,
  validateRoom,
  makeRoom,
  renovatorExtend,
  innerCornerOf,
  setInnerCorner,
  toRectangle,
  resizeEdge,
  roomsOverlap,
  outlineOf,
  LOT_PRESETS,
  pointInRoom,
  roomSupported,
  validateBalcony,
  validatePool,
  validatePatio,
  validateMezzanine,
  validateDoor,
  validateStair,
  stairSize,
  floorAbove,
  poolOuterRect,
  poolBlockedCells,
} from '../src/geometry.js';
import { sanitizeProject, newProject, floorKeysForProject } from '../src/project.js';

const LOT = LOT_PRESETS.ocean;

const room = (o) => makeRoom({ name: 'R', ...o });

/* ------------------------------------------------------------------ */
/* Shape decomposition                                                 */
/* ------------------------------------------------------------------ */

test('rectangle and L decomposition cover the same area as the footprint rule', () => {
  const base = room({ x: 2, y: 3, w: 5, h: 4 });
  assert.equal(isL(base), false);
  assert.equal(areaOf(base), 20);

  for (const corner of ['NW', 'NE', 'SW', 'SE']) {
    const l = room({ x: 2, y: 3, w: 5, h: 4, lshape: corner, armW: 2, armH: 3 });
    assert.equal(isL(l), true, `${corner} should be an L`);
    assert.equal(areaOf(l), 20 - 6, `${corner} area`);
    // Decomposition must agree with the area formula.
    const sum = rectsOf(l).reduce((s, r) => s + r.w * r.h, 0);
    assert.equal(sum, areaOf(l), `${corner} rect decomposition`);
  }
});

test('outline polygon of an L has exactly 6 vertices; rectangle 4', () => {
  assert.equal(outlineOf(room({ x: 0, y: 0, w: 3, h: 3 })).length, 4);
  for (const corner of ['NW', 'NE', 'SW', 'SE']) {
    const l = room({ x: 0, y: 0, w: 3, h: 3, lshape: corner, armW: 1, armH: 1 });
    assert.equal(outlineOf(l).length, 6);
  }
});

test('the notched corner is not part of the room; the rest is', () => {
  const l = room({ x: 0, y: 0, w: 4, h: 4, lshape: 'SE', armW: 2, armH: 2 });
  assert.equal(pointInRoom(l, 3.5, 3.5), false, 'notch must be excluded');
  assert.equal(pointInRoom(l, 0.5, 0.5), true);
  assert.equal(pointInRoom(l, 3.5, 1.5), true);
  assert.equal(pointInRoom(l, 1.5, 3.5), true);
});

/* ------------------------------------------------------------------ */
/* Spec §5.2 — the only banned size is exactly 1 x 1                   */
/* ------------------------------------------------------------------ */

test('1x1 is banned, every other combination is allowed', () => {
  assert.equal(minSizeOk({ w: 1, h: 1 }), false);
  for (const [w, h] of [
    [1, 2],
    [2, 1],
    [2, 2],
    [3, 2],
    [1, 9],
    [9, 1],
  ]) {
    assert.equal(minSizeOk({ w, h }), true, `${w}x${h} must be legal`);
    const r = room({ x: 0, y: 0, w, h });
    assert.equal(validateRoom(r, [], LOT).ok, true, `${w}x${h} should validate`);
  }
  const bad = room({ x: 0, y: 0, w: 1, h: 1 });
  const res = validateRoom(bad, [], LOT);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'min-size');
});

/* ------------------------------------------------------------------ */
/* Spec §5.3 — bounds, overlap, adjacency                              */
/* ------------------------------------------------------------------ */

test('rooms may touch but never overlap', () => {
  const a = room({ id: 'a', x: 0, y: 0, w: 4, h: 4 });
  const touching = room({ id: 'b', x: 4, y: 0, w: 4, h: 4 });
  const overlapping = room({ id: 'c', x: 3, y: 3, w: 4, h: 4 });

  assert.equal(roomsOverlap(a, touching), false);
  assert.equal(validateRoom(touching, [a], LOT).ok, true, 'shared boundary allowed');
  assert.equal(validateRoom(overlapping, [a], LOT).code, 'overlap');
});

test('L room notches allow a neighbouring room to nest in the gap', () => {
  const l = room({ id: 'l', x: 0, y: 0, w: 6, h: 6, lshape: 'SE', armW: 3, armH: 3 });
  const nestled = room({ id: 'n', x: 3, y: 3, w: 3, h: 3 });
  assert.equal(validateRoom(nestled, [l], LOT).ok, true);
  const tooBig = room({ id: 'm', x: 2, y: 2, w: 3, h: 3 });
  assert.equal(validateRoom(tooBig, [l], LOT).code, 'overlap');
});

test('rooms cannot leave the lot', () => {
  const lot = LOT_PRESETS.standard; // 18 x 18
  assert.equal(validateRoom(room({ x: 12, y: 0, w: 6, h: 2 }), [], lot).ok, true);
  const out = validateRoom(room({ x: 13, y: 0, w: 6, h: 2 }), [], lot);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bounds');
  assert.equal(validateRoom(room({ x: -1, y: 0, w: 2, h: 2 }), [], lot).code, 'bounds');
});

test('upper-floor rooms must be supported by occupied cells below', () => {
  const support = room({ id: 'support', x: 2, y: 2, w: 6, h: 6, lshape: 'SE', armW: 3, armH: 3 });
  const supported = room({ id: 'upper', x: 2, y: 2, w: 3, h: 3 });
  const unsupported = room({ id: 'upper-gap', x: 5, y: 5, w: 2, h: 2 });
  assert.equal(roomSupported(supported, [support]), true);
  assert.equal(validateRoom(supported, [], LOT, [support]).ok, true);
  assert.equal(roomSupported(unsupported, [support]), false);
  assert.equal(validateRoom(unsupported, [], LOT, [support]).code, 'unsupported');
  assert.equal(roomSupported(room({ x: 0, y: 0, w: 2, h: 2 }), []), false);
});

test('balcony cells are gray and unavailable to rooms on higher floors', () => {
  const support = room({ id: 'ground', x: 0, y: 0, w: 6, h: 6 });
  const balconyCells = new Set(['3,2', '3,3']);
  const overlappingBalconyRoom = room({ id: 'blocked', x: 2, y: 2, w: 2, h: 2 });
  const clearRoom = room({ id: 'clear', x: 0, y: 0, w: 2, h: 2 });
  assert.equal(validateRoom(overlappingBalconyRoom, [], LOT, [support], balconyCells).code, 'balcony-blocked');
  assert.equal(validateRoom(clearRoom, [], LOT, [support], balconyCells).ok, true);
});

test('pools have a 3x3 minimum core and a one-cell outer ring inside the lot', () => {
  const pool = { id: 'pool-a', x: 4, y: 4, w: 3, h: 3 };
  assert.deepEqual(poolOuterRect(pool), { x: 3, y: 3, w: 5, h: 5 });
  assert.equal(validatePool(pool, [], [], LOT).ok, true);
  assert.equal(validatePool({ ...pool, w: 2 }, [], [], LOT).code, 'min-size');
  assert.equal(validatePool({ ...pool, x: 0 }, [], [], LOT).code, 'bounds');
});

test('pool outer rings may overlap and another core may cover a ring, but cores cannot overlap', () => {
  const first = { id: 'pool-a', x: 4, y: 4, w: 3, h: 3 };
  const adjacent = { id: 'pool-b', x: 7, y: 4, w: 3, h: 3 };
  const overlappingCore = { id: 'pool-c', x: 6, y: 4, w: 3, h: 3 };
  assert.equal(validatePool(adjacent, [], [first], LOT).ok, true);
  assert.equal(validatePool(first, [], [adjacent], LOT).ok, true);
  assert.equal(validatePool(overlappingCore, [], [first], LOT).code, 'core-overlap');
});

test('pool core and outer ring cannot overlap rooms; all covered cells are blocked', () => {
  const pool = { id: 'pool-a', x: 4, y: 4, w: 3, h: 3 };
  const nearbyRoom = room({ x: 3, y: 3, w: 2, h: 2 });
  assert.equal(validatePool(pool, [nearbyRoom], [], LOT).code, 'overlap');
  const blocked = poolBlockedCells([pool]);
  assert.equal(blocked.size, 25);
  assert.equal(blocked.has('3,3'), true);
  assert.equal(blocked.has('4,4'), true);
  assert.equal(blocked.has('8,8'), false);
});

test('pool data is sanitized while preserving non-overlapping cores with overlapping rings', () => {
  const project = sanitizeProject({
    lot: 'ocean',
    rooms: [],
    pools: [
      { id: 'pool-a', x: 4, y: 4, w: 3, h: 3 },
      { id: 'pool-b', x: 7, y: 4, w: 3, h: 3 },
      { id: 'pool-c', x: 6, y: 4, w: 3, h: 3 },
      { id: 'pool-small', x: 12, y: 4, w: 2, h: 3 },
    ],
  });
  assert.deepEqual(project.pools.map((pool) => pool.id), ['pool-a', 'pool-b']);
});

test('patios cannot overlap rooms or any part of a pool', () => {
  const pool = { id: 'pool-a', x: 4, y: 4, w: 3, h: 3 };
  const patio = { id: 'patio-a', x: 3, y: 3, w: 2, h: 2 };
  const clearPatio = { ...patio, x: 10, y: 10 };
  const room = { id: 'room-a', x: 3, y: 3, w: 2, h: 2 };
  assert.equal(validatePatio(patio, [], [pool], LOT).code, 'pool-overlap');
  assert.equal(validatePatio(patio, [room], [], LOT).code, 'room-overlap');
  assert.equal(validatePatio(clearPatio, [room], [pool], LOT).ok, true);
  assert.equal(validatePatio({ ...clearPatio, x: 0 }, [], [], LOT).ok, true);
  assert.equal(validatePatio({ ...clearPatio, x: -1 }, [], [], LOT).code, 'bounds');
});

test('doors occupy 1-4 cells on real room walls and cannot overlap', () => {
  const firstRoom = room({ id: 'first', x: 2, y: 2, w: 4, h: 4 });
  const secondRoom = room({ id: 'second', x: 6, y: 2, w: 3, h: 4 });
  const sharedWallDoor = { id: 'door-a', x: 6, y: 2, length: 4, orientation: 'vertical' };
  assert.equal(validateDoor(sharedWallDoor, [firstRoom, secondRoom]).ok, true);
  assert.equal(validateDoor(sharedWallDoor, [firstRoom, secondRoom], [], { interiorOnly: true }).ok, true);
  const exteriorDoor = { id: 'exterior-door', x: 2, y: 2, length: 2, orientation: 'horizontal' };
  assert.equal(validateDoor(exteriorDoor, [firstRoom]).ok, true);
  assert.equal(validateDoor(exteriorDoor, [firstRoom], [], { interiorOnly: true }).code, 'wall');
  assert.equal(validateDoor({ ...sharedWallDoor, length: 5 }, [firstRoom, secondRoom]).code, 'length');
  assert.equal(validateDoor({ ...sharedWallDoor, x: 10 }, [firstRoom, secondRoom]).code, 'wall');
  assert.equal(
    validateDoor({ ...sharedWallDoor, length: 2 }, [firstRoom, secondRoom], [
      { ...sharedWallDoor, id: 'door-b', y: 3, length: 2 },
    ]).code,
    'overlap',
  );
  assert.equal(
    validateDoor({ ...sharedWallDoor, x: 3, y: 3, orientation: 'horizontal' }, [firstRoom]).code,
    'wall',
  );
});

test('stairs require room support on both floors and an upper-floor exit in their facing direction', () => {
  const lower = room({ id: 'lower', x: 1, y: 1, w: 8, h: 8 });
  const upper = room({ id: 'upper', x: 2, y: 1, w: 3, h: 6 });
  const stair = { id: 'stair-a', type: 'narrow', rotated: false, x: 2, y: 2, lowerFloor: '1' };
  const floors = ['1', '2'];
  assert.deepEqual(stairSize(stair), { w: 1, h: 5 });
  assert.deepEqual(stairSize({ ...stair, type: 'compact', rotated: true }), { w: 3, h: 2 });
  assert.equal(floorAbove('basement'), '1');
  assert.equal(floorAbove('2'), '3');
  assert.equal(validateStair(stair, [lower], [upper], [], LOT, floors).ok, true);
  assert.equal(validateStair(stair, [lower], [], [], LOT, floors).code, 'upper-room');
  assert.equal(validateStair(stair, [lower], [room({ id: 'no-exit', x: 2, y: 2, w: 1, h: 5 })], [], LOT, floors).code, 'upper-exit');
  assert.equal(validateStair(stair, [], [upper], [], LOT, floors).code, 'lower-room');
  assert.equal(validateStair(stair, [lower], [], [], LOT, ['1']).code, 'floors');
  assert.equal(validateStair(stair, [lower], [upper], [
    { ...stair, id: 'stair-b', lowerFloor: '2' },
  ], LOT, ['1', '2', '3']).code, 'overlap');
  const horizontal = { ...stair, type: 'compact', rotated: true, x: 2, y: 2 };
  const horizontalUpper = room({ id: 'upper-horizontal', x: 2, y: 2, w: 4, h: 2 });
  assert.equal(validateStair(horizontal, [lower], [horizontalUpper], [], LOT, floors).ok, true);
});

test('mezzanines must fit entirely inside one lower-floor room', () => {
  const firstRoom = room({ id: 'first', x: 2, y: 2, w: 3, h: 4 });
  const secondRoom = room({ id: 'second', x: 5, y: 2, w: 3, h: 4 });
  const mezzanine = { id: 'mezz-a', x: 2, y: 2, w: 2, h: 3 };
  assert.equal(validateMezzanine(mezzanine, [firstRoom, secondRoom], [], LOT).ok, true);
  assert.equal(
    validateMezzanine({ ...mezzanine, w: 1, h: 1 }, [firstRoom], [], LOT).code,
    'degenerate',
  );
  assert.equal(
    validateMezzanine({ ...mezzanine, x: 4, w: 2 }, [firstRoom, secondRoom], [], LOT).code,
    'support',
  );
  assert.equal(
    validateMezzanine({ ...mezzanine, x: 7 }, [firstRoom, secondRoom], [], LOT).code,
    'support',
  );
  assert.equal(validateMezzanine(mezzanine, [], [], LOT).code, 'support');
  assert.equal(
    validateMezzanine({ ...mezzanine, x: LOT.w - 1 }, [firstRoom, secondRoom], [], LOT).code,
    'bounds',
  );
  assert.equal(
    validateMezzanine(mezzanine, [firstRoom, secondRoom], [{ ...mezzanine, id: 'mezz-b' }], LOT).code,
    'overlap',
  );
  assert.equal(
    validateMezzanine(
      { ...mezzanine, x: 4, w: 2 },
      [{ id: 'lower-wide', x: 2, y: 2, w: 6, h: 4 }],
      [],
      LOT,
      [firstRoom, secondRoom],
    ).code,
    'upper-support',
  );
});

test('balcony gray cells must be within 3 grid cells of supported cells', () => {
  const host = room({ id: 'host', x: 2, y: 2, w: 3, h: 3 });
  const support = room({ id: 'support', x: 0, y: 0, w: 5, h: 5 });
  const balcony = {
    id: 'balcony',
    roomId: null,
    side: null,
    x: 5,
    y: 2,
    w: 2,
    h: 2,
  };
  assert.equal(validateBalcony({ ...balcony, w: 1, h: 1 }, [host], [], LOT, [support]).code, 'min-size');
  assert.equal(validateBalcony(balcony, [host], [], LOT, [support]).ok, true);
  assert.equal(validateBalcony({ ...balcony, w: 3 }, [host], [], LOT, [support]).ok, true);
  assert.equal(
    validateBalcony({ ...balcony, w: 4 }, [host], [], LOT, [support]).code,
    'balcony-depth',
    'a balcony may start directly on the grid, but gray cells more than 3 cells from support are blocked',
  );
  assert.equal(
    validateBalcony({ ...balcony, h: 4 }, [host], [], LOT, [support]).code,
    'ok',
    'balcony width may exceed 3 cells when every gray cell is within 3 cells of support',
  );
  const wideSupport = room({ id: 'wide-support', x: 0, y: 0, w: 5, h: 6 });
  const wideBalcony = { ...balcony, x: 5, y: 1, w: 3, h: 8 };
  assert.equal(validateBalcony(wideBalcony, [host], [], LOT, [wideSupport]).ok, true);
  assert.equal(
    validateBalcony({ ...wideBalcony, h: 9 }, [host], [], LOT, [wideSupport]).code,
    'balcony-depth',
    'only cells more than 3 grid cells from the supported area are blocked',
  );
  assert.equal(
    validateBalcony(
      { ...balcony, w: 4 },
      [host],
      [],
      LOT,
      [room({ id: 'wide-support', x: 0, y: 0, w: 10, h: 10 })],
    ).ok,
    true,
    'a balcony may be placed entirely over white support cells',
  );
  assert.equal(
    validateBalcony(balcony, [host], [{ ...balcony, id: 'other' }], LOT, [support]).code,
    'overlap',
  );
});

test('shrinking a 1x2 room into 1x1 is rejected', () => {
  const r = room({ id: 'r', x: 0, y: 0, w: 1, h: 2 });
  const shrunk = resizeEdge(r, 'S', -1);
  assert.equal(shrunk.w, 1);
  assert.equal(shrunk.h, 1);
  assert.equal(validateRoom(shrunk, [], LOT).code, 'min-size');
});

/* ------------------------------------------------------------------ */
/* Room Renovator                                                      */
/* ------------------------------------------------------------------ */

test('every anchor + direction produces a legal L that adds exactly k cells', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 4, h: 3 });
  const cases = [
    ['NW', 'right'],
    ['NW', 'up'],
    ['NE', 'left'],
    ['NE', 'up'],
    ['SW', 'right'],
    ['SW', 'down'],
    ['SE', 'left'],
    ['SE', 'down'],
  ];
  for (const [anchor, dir] of cases) {
    for (const k of [1, 2, 3]) {
      const extended = renovatorExtend(base, anchor, dir, k);
      assert.ok(extended, `${anchor}/${dir}/${k} should extend`);
      assert.equal(isL(extended), true, `${anchor}/${dir} must be an L`);
      assert.equal(areaOf(extended), areaOf(base) + k, `${anchor}/${dir}/${k} area`);
      assert.equal(validateRoom(extended, [], LOT).ok, true, `${anchor}/${dir}/${k} valid`);
      assert.equal(extended.x + extended.w <= LOT.w, true);
    }
  }
});

test('each corner anchor extends outwards in its matching left or right direction', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 4, h: 3 });
  const cases = [
    ['NW', 'right', 9.5, 5.5],
    ['NW', 'up', 5.5, 4.5],
    ['NE', 'left', 4.5, 5.5],
    ['NE', 'up', 8.5, 4.5],
    ['SW', 'right', 9.5, 7.5],
    ['SW', 'down', 5.5, 8.5],
    ['SE', 'left', 4.5, 7.5],
    ['SE', 'down', 8.5, 8.5],
  ];

  for (const [anchor, dir, addedX, addedY] of cases) {
    const extended = renovatorExtend(base, anchor, dir, 1);
    assert.ok(extended, `${anchor}/${dir} should extend`);
    assert.equal(pointInRoom(extended, addedX, addedY), true, `${anchor}/${dir} should grow outwards`);
    for (let x = base.x; x < base.x + base.w; x += 1) {
      for (let y = base.y; y < base.y + base.h; y += 1) {
        assert.equal(pointInRoom(extended, x + 0.5, y + 0.5), true, `${anchor}/${dir} must preserve the original room`);
      }
    }
  }
});

test('the extended strip is 1 cell thick and attached at the anchor corner', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 4, h: 3 });
  const e = renovatorExtend(base, 'SE', 'right', 2);
  // footprint grew to the right, only the top row gained cells
  assert.equal(e.w, 6);
  assert.equal(e.h, 3);
  assert.equal(e.lshape, 'NE', 'the far corner is the one notched out');
  assert.equal(pointInRoom(e, 5.5, 5.5), true, 'top-left kept');
  assert.equal(pointInRoom(e, 8.5, 5.5), true, 'new top cell (the arm)');
  assert.equal(pointInRoom(e, 8.5, 7.5), true, 'bottom cell still part of the body');
  assert.equal(pointInRoom(e, 10.5, 5.5), false, 'notch starts at the far corner');
});

test('renovator refuses to run out of bounds, on zero drag, or on an existing L', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 4, h: 3 });
  assert.equal(renovatorExtend(base, 'SE', 'down', 0), null);
  const l = renovatorExtend(base, 'SE', 'right', 1);
  assert.equal(renovatorExtend(l, 'NW', 'up', 1), null, 'only one L per room');
  // push past the lot edge and confirm validation catches it
  const far = renovatorExtend(base, 'SE', 'right', 40);
  assert.equal(validateRoom(far, [], LOT).code, 'bounds');
});

test('inner corner: shrink the extension to zero and the room is a rectangle again', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 4, h: 3 });
  const l = renovatorExtend(base, 'SE', 'right', 2);
  const ic = innerCornerOf(l);
  assert.deepEqual(ic, { x: 9, y: 7 });

  // drag the inner corner towards the extension's tip (the far edge) until armW hits 0
  const collapsed = setInnerCorner(l, l.x + l.w, ic.y);
  assert.equal(isL(collapsed), false, 'L must collapse to a rectangle');
  // Collapsing the notch fills it in: the room becomes the full footprint.
  assert.equal(collapsed.w, 6);
  assert.equal(collapsed.h, 3);
  assert.equal(areaOf(collapsed), 18);
});

test('inner corner resizes the extension and can collapse it on either axis', () => {
  const base = room({ id: 'b', x: 5, y: 5, w: 6, h: 6 });
  const l = renovatorExtend(base, 'SE', 'right', 2); // strip off the top wall, to the right
  assert.equal(isL(l), true);
  const ic = innerCornerOf(l);
  const A = areaOf(l);

  // The notch always starts spanning the whole other axis, so that axis can
  // only shrink (making the room bigger); the other axis moves both ways.
  //  - drag right => notch narrower => room BIGGER
  assert.ok(areaOf(setInnerCorner(l, ic.x + 1, ic.y)) > A, 'drag right => bigger');
  //  - drag left  => notch wider    => room SMALLER
  assert.ok(areaOf(setInnerCorner(l, ic.x - 1, ic.y)) < A, 'drag left => smaller');
  //  - drag up    => notch shorter  => room BIGGER
  assert.ok(areaOf(setInnerCorner(l, ic.x, ic.y - 1)) > A, 'drag up => bigger');
  // never beyond the footprint
  const clamped = setInnerCorner(l, ic.x, ic.y + 99);
  assert.equal(isL(clamped), true, 'over-dragging clamps instead of breaking the L');
  assert.ok(clamped.armH <= clamped.h - 1, 'arm stays inside the footprint');

  // dragging far enough on either axis restores a rectangle
  assert.equal(isL(setInnerCorner(l, ic.x, l.y)) === false, true, 'armH -> 0 => rectangle');
  assert.equal(isL(setInnerCorner(l, l.x + l.w, ic.y)), false, 'armW -> 0 => rectangle');

  const vertical = renovatorExtend(base, 'NW', 'up', 2);
  const vic = innerCornerOf(vertical);
  const VA = areaOf(vertical);
  assert.ok(areaOf(setInnerCorner(vertical, vic.x + 1, vic.y)) > VA, 'narrower notch => bigger');
  assert.ok(areaOf(setInnerCorner(vertical, vic.x, vic.y + 1)) < VA, 'longer arm => smaller');
  assert.equal(isL(setInnerCorner(vertical, vic.x, vertical.y)), false, 'pulling the arm back to the wall => rectangle');
});

test('toRectangle restores a rectangle and keeps the footprint', () => {
  const l = room({ id: 'b', x: 1, y: 1, w: 5, h: 4, lshape: 'NE', armW: 2, armH: 3 });
  const r = toRectangle(l);
  assert.equal(r.lshape, null);
  assert.equal(r.w, 5);
  assert.equal(r.h, 4);
  assert.equal(areaOf(r), 20);
});

test('shrinking the footprint clamps or drops an illegal L notch', () => {
  const l = room({ id: 'b', x: 0, y: 0, w: 5, h: 5, lshape: 'SE', armW: 4, armH: 4 });
  const shrunk = resizeEdge(l, 'E', -4);
  assert.equal(shrunk.w, 1);
  // arm width no longer fits -> must not remain a broken L
  assert.ok(shrunk.lshape === null || (shrunk.armW >= 1 && shrunk.armW <= shrunk.w - 1));
});

/* ------------------------------------------------------------------ */
/* Project files                                                       */
/* ------------------------------------------------------------------ */

test('project sanitization repairs impossible rooms', () => {
  const repaired = sanitizeProject({
    name: 'Repair',
    lot: 'standard',
    rooms: [
      { x: 0, y: 0, w: 1, h: 1 }, // 1x1 -> dropped
      { x: 0, y: 0, w: 30, h: 3 }, // out of bounds -> dropped
      { x: 5.5, y: 0, w: 2, h: 2 }, // non-integer -> dropped
      { x: 2, y: 2, w: 3, h: 3 }, // kept
      { x: 3, y: 3, w: 3, h: 3 }, // overlaps -> dropped
    ],
  });
  assert.equal(repaired.rooms.length, 1);
  assert.equal(repaired.rooms[0].w, 3);
});

test('a 1x1 room can never be resurrected from a file', () => {
  const p = sanitizeProject({ lot: 'penthouse', rooms: [{ x: 0, y: 0, w: 1, h: 1 }] });
  assert.equal(p.rooms.length, 0);
});

test('floor data migrates legacy projects and retains unsupported upper rooms', () => {
  const fresh = newProject('Fresh', 'standard');
  assert.deepEqual(floorKeysForProject(fresh), ['1']);
  const penthouse = newProject('Penthouse', 'penthouse');
  assert.deepEqual(floorKeysForProject(penthouse), ['1']);
  assert.equal(penthouse.penthouseThirdFloorAcknowledged, false);

  const legacy = sanitizeProject({
    lot: 'standard',
    rooms: [{ id: 'ground', x: 1, y: 1, w: 4, h: 4 }],
  });
  assert.equal(legacy.floors['1'].length, 1);
  assert.deepEqual(floorKeysForProject(legacy), ['1']);

  const layered = sanitizeProject({
    lot: 'standard',
    floors: {
      '1': [{ id: 'ground', x: 1, y: 1, w: 4, h: 4 }],
      '2': [
        { id: 'supported', x: 1, y: 1, w: 2, h: 2 },
        { id: 'unsupported', x: 8, y: 8, w: 2, h: 2 },
      ],
      basement: [{ id: 'basement', x: 10, y: 10, w: 2, h: 2 }],
    },
  });
  assert.deepEqual(layered.floors['2'].map((r) => r.id), ['supported', 'unsupported']);
  assert.equal(layered.floors.basement.length, 1);

  const withBalcony = sanitizeProject({
    lot: 'standard',
    floors: {
      '1': [{ id: 'ground', x: 0, y: 0, w: 6, h: 2 }],
      '2': [{ id: 'upper-host', x: 3, y: 0, w: 2, h: 2 }],
    },
    balconies: {
      '2': [{
        id: 'upper-balcony',
        roomId: 'upper-host',
        side: 'E',
        x: 5,
        y: 0,
        w: 4,
        h: 2,
      }],
    },
  });
  assert.equal(withBalcony.balconies['2'].length, 1);
  assert.equal(withBalcony.balconies['2'][0].id, 'upper-balcony');
});

test('Penthouse sanitization removes Basement and floors above 3F and preserves acknowledgement', () => {
  const repaired = sanitizeProject({
    lot: 'penthouse',
    floors: {
      '1': [],
      '2': [],
      '3': [],
      '4': [{ id: 'fourth', x: 2, y: 2, w: 2, h: 2 }],
      basement: [{ id: 'basement', x: 2, y: 2, w: 2, h: 2 }],
    },
    penthouseThirdFloorAcknowledged: true,
  });
  assert.deepEqual(floorKeysForProject(repaired), ['1', '2', '3']);
  assert.equal(repaired.floors['4'], undefined);
  assert.equal(repaired.floors.basement, undefined);
  assert.equal(repaired.penthouseThirdFloorAcknowledged, true);
});

test('patios persist when valid and are removed when they overlap a room or pool footprint', () => {
  const project = sanitizeProject({
    lot: 'standard',
    floors: { '1': [{ id: 'room-a', x: 14, y: 14, w: 2, h: 2 }] },
    pools: [{ id: 'pool-a', x: 4, y: 4, w: 3, h: 3 }],
    patios: [
      { id: 'blocked-patio', x: 3, y: 3, w: 2, h: 2 },
      { id: 'room-overlap', x: 14, y: 14, w: 2, h: 2 },
      { id: 'clear-patio', x: 10, y: 10, w: 2, h: 2 },
    ],
  });
  assert.deepEqual(project.patios.map((patio) => patio.id), ['clear-patio']);
});

test('doors are sanitized per floor and Basement doors must be between rooms', () => {
  const project = sanitizeProject({
    lot: 'standard',
    floors: {
      '1': [{ id: 'room-a', x: 2, y: 2, w: 4, h: 4 }],
      basement: [
        { id: 'basement-a', x: 2, y: 2, w: 4, h: 4 },
        { id: 'basement-b', x: 6, y: 2, w: 4, h: 4 },
      ],
      '2': [],
    },
    doors: {
      '1': [
        { id: 'valid-door', x: 2, y: 2, length: 2, orientation: 'horizontal' },
        { id: 'floating-door', x: 10, y: 10, length: 1, orientation: 'horizontal' },
      ],
      basement: [
        { id: 'basement-exterior', x: 2, y: 2, length: 2, orientation: 'horizontal' },
        { id: 'basement-shared', x: 6, y: 2, length: 2, orientation: 'vertical' },
      ],
      '2': [{ id: 'no-wall', x: 2, y: 2, length: 1, orientation: 'vertical' }],
    },
  });
  assert.deepEqual(project.doors['1'].map((door) => door.id), ['valid-door']);
  assert.deepEqual(project.doors.basement.map((door) => door.id), ['basement-shared']);
  assert.deepEqual(project.doors['2'], []);
});

test('staircases are sanitized against both connected floors', () => {
  const project = sanitizeProject({
    lot: 'standard',
    floors: {
      '1': [{ id: 'lower-room', x: 1, y: 1, w: 8, h: 8 }],
      '2': [{ id: 'upper-room', x: 2, y: 1, w: 3, h: 6 }],
    },
    stairs: [
      { id: 'valid-stair', type: 'narrow', rotated: false, x: 2, y: 2, lowerFloor: '1' },
      { id: 'blocked-stair', type: 'compact', rotated: false, x: 10, y: 1, lowerFloor: '1' },
      { id: 'missing-floor-stair', type: 'narrow', rotated: false, x: 2, y: 2, lowerFloor: '2' },
    ],
  });

  assert.deepEqual(project.stairs.map((stair) => stair.id), ['valid-stair']);
});

test('mezzanines are sanitized against both adjacent floors', () => {
  const project = sanitizeProject({
    lot: 'standard',
    floors: {
      basement: [{ id: 'basement-room', x: 1, y: 1, w: 8, h: 5 }],
      '1': [
        { id: 'first-a', x: 1, y: 1, w: 4, h: 5 },
        { id: 'first-b', x: 5, y: 1, w: 4, h: 5 },
      ],
      '2': [{ id: 'second-room', x: 1, y: 1, w: 4, h: 5 }],
      '3': [],
    },
    mezzanines: {
      '1': [
        { id: 'valid-basement-mezz', x: 2, y: 2, w: 2, h: 3 },
        { id: 'spans-first-floor-rooms', x: 4, y: 2, w: 2, h: 3 },
        { id: 'one-cell-first-floor-mezz', x: 2, y: 2, w: 1, h: 1 },
      ],
      '2': [
        { id: 'valid-mezz', x: 2, y: 2, w: 2, h: 3 },
        { id: 'spans-lower-rooms', x: 4, y: 2, w: 2, h: 3 },
      ],
      '3': [{ id: 'missing-upper-room', x: 2, y: 2, w: 1, h: 2 }],
    },
  });
  assert.deepEqual(project.mezzanines['1'].map((item) => item.id), ['valid-basement-mezz']);
  assert.deepEqual(project.mezzanines['2'].map((item) => item.id), ['valid-mezz']);
  assert.deepEqual(project.mezzanines['3'], []);
});

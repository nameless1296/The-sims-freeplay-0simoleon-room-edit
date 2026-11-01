/**
 * project.js — project schema, (de)serialisation and validation.
 *
 * Project schema and persistence sanitization.
 */
import {
  LOT_PRESETS,
  LOT_LIST,
  CORNERS,
  isInt,
  makeRoom,
  normalizeShape,
  validateBalcony,
  validatePool,
  validatePatio,
  validateMezzanine,
  validateDoor,
  validateStair,
  uid,
} from './geometry.js';

export const FLOOR_KEYS = ['basement', '1', '2', '3', '4', '5'];
export const UPPER_FLOOR_KEYS = ['1', '2', '3', '4', '5'];

export function emptyFloors() {
  return { '1': [] };
}

export function floorKeysForProject(project) {
  const floors = project?.floors || {};
  const maxFloor = project?.lot === 'penthouse' ? 3 : 5;
  return FLOOR_KEYS.filter((floor) => {
    if (floor === '1') return true;
    if (floor === 'basement') return project?.lot !== 'penthouse' && Object.hasOwn(floors, floor);
    return Number(floor) <= maxFloor && Object.hasOwn(floors, floor);
  });
}

export function emptyBalconies() {
  return Object.fromEntries(FLOOR_KEYS.map((floor) => [floor, []]));
}

export function emptyDoors() {
  return Object.fromEntries(FLOOR_KEYS.map((floor) => [floor, []]));
}

export function emptyMezzanines() {
  return Object.fromEntries(FLOOR_KEYS.map((floor) => [floor, []]));
}

export function roomsOnFloor(project, floor) {
  return project.floors?.[floor] || (floor === '1' ? project.rooms || [] : []);
}

export function balconiesOnFloor(project, floor) {
  return project.balconies?.[floor] || [];
}

export function doorsOnFloor(project, floor) {
  return project.doors?.[floor] || [];
}

export function mezzaninesOnFloor(project, floor) {
  return project.mezzanines?.[floor] || [];
}

export function withFloorRooms(project, floor, rooms) {
  const floors = { ...emptyFloors(), ...project.floors, [floor]: rooms };
  return { ...project, floors, rooms: floors['1'] };
}

export function withFloorBalconies(project, floor, balconies) {
  return {
    ...project,
    balconies: { ...emptyBalconies(), ...project.balconies, [floor]: balconies },
  };
}

export function newProject(name, lotId) {
  const lot = LOT_PRESETS[lotId] || LOT_PRESETS.standard;
  const now = Date.now();
  return {
    id: uid('proj'),
    name: (name || 'Untitled Home').trim().slice(0, 60) || 'Untitled Home',
    lot: lot.id,
    rooms: [],
    floors: emptyFloors(),
    balconies: emptyBalconies(),
    doors: emptyDoors(),
    mezzanines: emptyMezzanines(),
    stairs: [],
    pools: [],
    patios: [],
    penthouseThirdFloorAcknowledged: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function lotOf(project) {
  return LOT_PRESETS[project?.lot] || LOT_PRESETS.standard;
}

export function touch(project) {
  return { ...project, updatedAt: Date.now() };
}

export function nextRoomName(project, floorRooms = project.rooms) {
  const used = new Set(floorRooms.map((r) => r.name));
  let i = floorRooms.length + 1;
  while (used.has(`Room ${i}`)) i += 1;
  return `Room ${i}`;
}

/** Defensive copy used on load: coerce every field, drop impossible rooms. */
export function sanitizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Project data is not an object.');
  const lotId = LOT_LIST.some((l) => l.id === raw.lot) ? raw.lot : 'standard';
  const lot = LOT_PRESETS[lotId];

  const floors = emptyFloors();
  const balconies = emptyBalconies();
  const doors = emptyDoors();
  const mezzanines = emptyMezzanines();
  const pools = [];
  const seenIds = new Set();
  const rawFloors = raw.floors && typeof raw.floors === 'object' ? raw.floors : {};
  for (const floor of FLOOR_KEYS) {
    if (lotId === 'penthouse' && (floor === 'basement' || Number(floor) > 3)) continue;
    const floorExists = floor === '1' || Object.hasOwn(rawFloors, floor);
    if (!floorExists) continue;
    const rawRooms = floor === '1' && !Array.isArray(rawFloors['1'])
      ? raw.rooms
      : rawFloors[floor];
    const rooms = [];
    for (const r of Array.isArray(rawRooms) ? rawRooms : []) {
      if (!r || typeof r !== 'object') continue;
      if (![r.x, r.y, r.w, r.h].every(isInt)) continue;
      if (r.w < 1 || r.h < 1) continue;
      if (r.x < 0 || r.y < 0 || r.x + r.w > lot.w || r.y + r.h > lot.h) continue;
      if (r.w === 1 && r.h === 1) continue;

      let room = makeRoom({
        id: typeof r.id === 'string' && r.id ? r.id : uid('room'),
        name: typeof r.name === 'string' && r.name ? r.name.slice(0, 40) : 'Room',
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        lshape: CORNERS.includes(r.lshape) ? r.lshape : null,
        armW: isInt(r.armW) ? r.armW : 0,
        armH: isInt(r.armH) ? r.armH : 0,
      });
      room = normalizeShape(room);
      if (seenIds.has(room.id)) room.id = uid('room');
      seenIds.add(room.id);
      if (rooms.some((other) => overlaps(room, other))) continue;
      rooms.push(room);
    }
    floors[floor] = rooms;
    const rawBalconies = raw.balconies?.[floor];
    for (const rawBalcony of Array.isArray(rawBalconies) ? rawBalconies : []) {
      if (!rawBalcony || ![rawBalcony.x, rawBalcony.y, rawBalcony.w, rawBalcony.h].every(isInt)) continue;
      if (rawBalcony.w < 1 || rawBalcony.h < 1) continue;
      if (rawBalcony.x < 0 || rawBalcony.y < 0 || rawBalcony.x + rawBalcony.w > lot.w || rawBalcony.y + rawBalcony.h > lot.h) continue;
      const balcony = {
        id: typeof rawBalcony.id === 'string' && rawBalcony.id ? rawBalcony.id : uid('balcony'),
        name: typeof rawBalcony.name === 'string' && rawBalcony.name ? rawBalcony.name.slice(0, 40) : 'Balcony',
        x: rawBalcony.x,
        y: rawBalcony.y,
        w: rawBalcony.w,
        h: rawBalcony.h,
        side: ['N', 'E', 'S', 'W'].includes(rawBalcony.side) ? rawBalcony.side : null,
        roomId: typeof rawBalcony.roomId === 'string' ? rawBalcony.roomId : null,
      };
      if (seenIds.has(balcony.id)) balcony.id = uid('balcony');
      seenIds.add(balcony.id);
      if (floor === '1' || floor === 'basement') continue;
      if (rooms.some((room) => overlaps(balcony, room))) continue;
      if (balconies[floor].some((other) => overlaps(balcony, other))) continue;
      const supportRooms = floors['1'];
      const check = validateBalcony(balcony, rooms, balconies[floor], lot, supportRooms);
      if (!check.ok) continue;
      balconies[floor].push(balcony);
    }
    for (const rawDoor of Array.isArray(raw.doors?.[floor]) ? raw.doors[floor] : []) {
      if (!rawDoor || ![rawDoor.x, rawDoor.y, rawDoor.length].every(isInt)) continue;
      const door = {
        id: typeof rawDoor.id === 'string' && rawDoor.id ? rawDoor.id : uid('door'),
        x: rawDoor.x,
        y: rawDoor.y,
        length: rawDoor.length,
        orientation: rawDoor.orientation,
      };
      if (seenIds.has(door.id)) door.id = uid('door');
      seenIds.add(door.id);
      if (validateDoor(door, rooms, doors[floor], { interiorOnly: floor === 'basement' }).ok) {
        doors[floor].push(door);
      }
    }
  }

  for (const rawPool of Array.isArray(raw.pools) ? raw.pools : []) {
    if (!rawPool || ![rawPool.x, rawPool.y, rawPool.w, rawPool.h].every(isInt)) continue;
    const pool = {
      id: typeof rawPool.id === 'string' && rawPool.id ? rawPool.id : uid('pool'),
      name: typeof rawPool.name === 'string' && rawPool.name ? rawPool.name.slice(0, 40) : 'Pool',
      x: rawPool.x,
      y: rawPool.y,
      w: rawPool.w,
      h: rawPool.h,
    };
    if (seenIds.has(pool.id)) pool.id = uid('pool');
    seenIds.add(pool.id);
    if (!validatePool(pool, [...floors['1'], ...(floors.basement || [])], pools, lot).ok) continue;
    pools.push(pool);
  }
  const patios = [];
  for (const rawPatio of Array.isArray(raw.patios) ? raw.patios : []) {
    if (!rawPatio || ![rawPatio.x, rawPatio.y, rawPatio.w, rawPatio.h].every(isInt)) continue;
    const patio = {
      id: typeof rawPatio.id === 'string' && rawPatio.id ? rawPatio.id : uid('patio'),
      name: typeof rawPatio.name === 'string' && rawPatio.name ? rawPatio.name.slice(0, 40) : 'Patio',
      x: rawPatio.x,
      y: rawPatio.y,
      w: rawPatio.w,
      h: rawPatio.h,
    };
    if (seenIds.has(patio.id)) patio.id = uid('patio');
    seenIds.add(patio.id);
    if (!validatePatio(patio, floors['1'], pools, lot).ok) continue;
    patios.push(patio);
  }
  const stairs = [];
  const availableFloors = FLOOR_KEYS.filter((floor) =>
    floor === '1' || Object.hasOwn(floors, floor),
  );
  for (const rawStair of Array.isArray(raw.stairs) ? raw.stairs : []) {
    if (!rawStair || ![rawStair.x, rawStair.y].every(isInt)) continue;
    const stair = {
      id: typeof rawStair.id === 'string' && rawStair.id ? rawStair.id : uid('stair'),
      type: rawStair.type,
      rotated: rawStair.rotated === true,
      x: rawStair.x,
      y: rawStair.y,
      lowerFloor: rawStair.lowerFloor,
    };
    if (seenIds.has(stair.id)) stair.id = uid('stair');
    seenIds.add(stair.id);
    const lowerRooms = floors[stair.lowerFloor];
    const upperRooms = floors[stair.lowerFloor === 'basement' ? '1' : String(Number(stair.lowerFloor) + 1)];
    if (!lowerRooms || !upperRooms) continue;
    if (validateStair(
      stair,
      lowerRooms,
      upperRooms,
      stairs,
      lot,
      availableFloors,
    ).ok) stairs.push(stair);
  }
  for (const floor of FLOOR_KEYS) {
    if (floor === 'basement' || !floors[floor]) continue;
    const lowerFloor = floor === '1' ? 'basement' : String(Number(floor) - 1);
    if (!floors[lowerFloor]) continue;
    for (const rawMezzanine of Array.isArray(raw.mezzanines?.[floor]) ? raw.mezzanines[floor] : []) {
      if (!rawMezzanine || ![rawMezzanine.x, rawMezzanine.y, rawMezzanine.w, rawMezzanine.h].every(isInt)) continue;
      const mezzanine = {
        id: typeof rawMezzanine.id === 'string' && rawMezzanine.id ? rawMezzanine.id : uid('mezz'),
        name: typeof rawMezzanine.name === 'string' && rawMezzanine.name ? rawMezzanine.name.slice(0, 40) : 'Mezzanine',
        x: rawMezzanine.x,
        y: rawMezzanine.y,
        w: rawMezzanine.w,
        h: rawMezzanine.h,
      };
      if (seenIds.has(mezzanine.id)) mezzanine.id = uid('mezz');
      seenIds.add(mezzanine.id);
      if (validateMezzanine(
        mezzanine,
        floors[lowerFloor],
        mezzanines[floor],
        lot,
        floors[floor],
      ).ok) mezzanines[floor].push(mezzanine);
    }
  }

  const created = isInt(raw.createdAt) ? raw.createdAt : Date.now();
  const updated = isInt(raw.updatedAt) ? raw.updatedAt : created;

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('proj'),
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 60)
        : 'Untitled Home',
    lot: lotId,
    rooms: floors['1'],
    floors,
    balconies,
    doors,
    mezzanines,
    stairs,
    pools,
    patios,
    penthouseThirdFloorAcknowledged: raw.penthouseThirdFloorAcknowledged === true,
    createdAt: created,
    updatedAt: updated,
  };
}

function overlaps(a, b) {
  const A = rectsOf(a);
  const B = rectsOf(b);
  return A.some((ra) =>
    B.some(
      (rb) =>
        ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h,
    ),
  );
}

import { rectsOf } from './geometry.js';

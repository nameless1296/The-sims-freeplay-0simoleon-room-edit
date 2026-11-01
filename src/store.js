/**
 * store.js — persistence: browser localStorage with a JSON file fallback.
 */
import { sanitizeProject, FLOOR_KEYS } from './project.js';

function roomCount(project) {
  return FLOOR_KEYS.reduce((count, floor) => count + (project.floors[floor]?.length || 0), 0);
}

const KEY_INDEX = 'floorplanner.index.v1';
const KEY_PROJECT = (id) => `floorplanner.project.v1.${id}`;

/* ------------------------------------------------------------------ */
/* Storage backend: localStorage, with an in-memory fallback so the    */
/* app still works inside sandboxed previews where storage throws.     */
/* ------------------------------------------------------------------ */

const memory = new Map();
let backend = null;

function detectBackend() {
  if (backend) return backend;
  try {
    const probe = '__fp_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backend = { kind: 'local', get: (k) => window.localStorage.getItem(k), set: (k, v) => window.localStorage.setItem(k, v), remove: (k) => window.localStorage.removeItem(k) };
  } catch {
    backend = { kind: 'memory', get: (k) => (memory.has(k) ? memory.get(k) : null), set: (k, v) => memory.set(k, v), remove: (k) => memory.delete(k) };
  }
  return backend;
}

const store = {
  getItem: (k) => detectBackend().get(k),
  setItem: (k, v) => detectBackend().set(k, v),
  removeItem: (k) => detectBackend().remove(k),
};

function readIndex() {
  try {
    const raw = store.getItem(KEY_INDEX);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  store.setItem(KEY_INDEX, JSON.stringify(list));
}

export function listProjects() {
  return readIndex()
    .map((entry) => {
      try {
        const raw = store.getItem(KEY_PROJECT(entry.id));
        if (!raw) return null;
        const project = sanitizeProject(JSON.parse(raw));
        return {
          id: project.id,
          name: project.name,
          lot: project.lot,
          rooms: roomCount(project),
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadProject(id) {
  const raw = store.getItem(KEY_PROJECT(id));
  if (!raw) return null;
  try {
    return sanitizeProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveProject(project) {
  const safe = sanitizeProject(project);
  store.setItem(KEY_PROJECT(safe.id), JSON.stringify(safe));
  const index = readIndex().filter((e) => e.id !== safe.id);
  index.push({
    id: safe.id,
    name: safe.name,
    lot: safe.lot,
    rooms: roomCount(safe),
    updatedAt: safe.updatedAt,
    createdAt: safe.createdAt,
  });
  writeIndex(index);
  return safe;
}

export function deleteProject(id) {
  store.removeItem(KEY_PROJECT(id));
  writeIndex(readIndex().filter((e) => e.id !== id));
}

export function storageAvailable() {
  return detectBackend().kind === 'local';
}

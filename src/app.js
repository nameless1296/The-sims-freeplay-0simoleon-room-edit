/**
 * app.js — router + Home / Create-Project screens.
 */
import { LOT_LIST, LOT_PRESETS, outlineOf, rectsOf } from './geometry.js';
import { newProject, lotOf, roomsOnFloor, FLOOR_KEYS } from './project.js';
import {
  listProjects,
  loadProject,
  saveProject,
  deleteProject,
  storageAvailable,
} from './store.js';
import { Editor, icon } from './editor.js';

const root = document.getElementById('app');
let editor = null;
let statusListener = null;

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

function go(hash) {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
}

function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (editor) {
    editor.destroy();
    editor = null;
  }
  window.removeEventListener('beforeunload', statusListener);

  if (hash.startsWith('/editor/')) {
    const id = hash.slice('/editor/'.length);
    const project = loadProject(id);
    if (!project) {
      go('/');
      return;
    }
    renderEditor(project);
    return;
  }
  if (hash === '/new') {
    renderCreate();
    return;
  }
  renderHome();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

/* ------------------------------------------------------------------ */
/* Home                                                              */
/* ------------------------------------------------------------------ */

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function previewSvg(entry) {
  // Tiny schematic of the saved rooms on its lot.
  const lot = LOT_PRESETS[entry.lot] || LOT_PRESETS.standard;
  const project = loadProject(entry.id);
  const rooms = project ? roomsOnFloor(project, '1') : [];
  const scale = 100 / Math.max(lot.w, lot.h);
  const w = lot.w * scale;
  const h = lot.h * scale;
  const offX = (120 - w) / 2;
  const offY = (120 - h) / 2;
  const shapes = rooms
    .map((r) => {
      const pts = outlineOf(r)
        .map(([x, y]) => `${offX + x * scale},${offY + y * scale}`)
        .join(' ');
      return `<polygon points="${pts}" fill="#bcd7f7" stroke="#7ea9dc" stroke-width="0.8"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 120 120" class="thumb-svg" aria-hidden="true">
    <rect x="${offX}" y="${offY}" width="${w}" height="${h}" rx="2" fill="#ffffff" stroke="#d6e2f1"/>
    ${shapes}
  </svg>`;
}

function roomCountLabel(n) {
  return `${n} room${n === 1 ? '' : 's'}`;
}

function renderHome() {
  const projects = listProjects();
  const canStore = storageAvailable();

  root.innerHTML = `
    <div class="page home">
      <header class="home-head">
        <div class="brand">
          <span class="brand-mark">${icon('grid')}</span>
          <div>
            <h1>Floor Planner</h1>
            <p>Sims&nbsp;FreePlay style 2D house planning</p>
          </div>
        </div>
        <div class="head-actions">
          <button class="primary-btn" id="btn-new">+ New Project</button>
        </div>
      </header>

      ${canStore ? '' : `<div class="banner warn">Local storage is blocked in this browser context, so projects live in memory only for this session. Use <b>Export</b> to keep a permanent copy.</div>`}

      <section class="panel">
        <div class="panel-head">
          <h2>Your Projects</h2>
          <span class="muted">${projects.length} saved</span>
        </div>
        ${
          projects.length
            ? `<div class="proj-grid">
                ${projects
                  .map((p) => {
                    const lot = LOT_PRESETS[p.lot] || LOT_PRESETS.standard;
                    return `<article class="proj-card" data-id="${p.id}">
                      <button class="thumb" data-open="${p.id}" title="Open ${escapeAttr(p.name)}">${previewSvg(p)}</button>
                      <div class="proj-meta">
                        <h3 title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</h3>
                        <p class="muted">${lot.name} · ${lot.w} × ${lot.h} · ${roomCountLabel(FLOOR_KEYS.reduce((count, floor) => count + (p.floors?.[floor]?.length || 0), 0))}</p>
                        <p class="muted small">Edited ${fmtDate(p.updatedAt)}</p>
                      </div>
                      <div class="card-actions">
                        <button class="ghost-btn sm" data-open="${p.id}">Open</button>
                        <button class="ghost-btn sm danger" data-del="${p.id}">Delete</button>
                      </div>
                    </article>`;
                  })
                  .join('')}
              </div>`
            : `<div class="empty-state">
                <div class="empty-ico">${icon('rect')}</div>
                <p><strong>No projects yet</strong></p>
                <p class="muted">Create a project, pick a lot size, then drag rooms onto the grid.</p>
                <button class="primary-btn" id="btn-new-2">+ Create your first project</button>
              </div>`
        }
      </section>

      <footer class="home-foot">
        <p class="muted small">
          Rooms are limited to rectangles and FreePlay-style L shapes. The smallest room is 1 × 2 —
          a 1 × 1 room is never allowed. Lot presets: Standard 18 × 18, Ocean View / Premium 18 × 36,
          Penthouse 12 × 26.
        </p>
      </footer>
    </div>`;

  root.querySelector('#btn-new')?.addEventListener('click', () => go('/new'));
  root.querySelector('#btn-new-2')?.addEventListener('click', () => go('/new'));
  for (const b of root.querySelectorAll('[data-open]')) {
    b.addEventListener('click', () => go(`/editor/${b.dataset.open}`));
  }
  for (const b of root.querySelectorAll('[data-del]')) {
    b.addEventListener('click', () => {
      const card = b.closest('.proj-card');
      const id = b.dataset.del;
      const name = card.querySelector('h3').textContent;
      card.querySelector('.project-delete-popover')?.remove();
      const prompt = document.createElement('div');
      prompt.className = 'project-delete-popover';
      prompt.setAttribute('role', 'alertdialog');
      prompt.setAttribute('aria-label', `Delete ${name}`);
      prompt.innerHTML = `
        <strong>Delete “${escapeHtml(name)}”?</strong>
        <p>This cannot be undone.</p>
        <div class="project-delete-actions">
          <button class="ghost-btn sm" type="button" data-cancel-delete>Cancel</button>
          <button class="danger-btn sm" type="button" data-confirm-delete>Delete</button>
        </div>`;
      card.append(prompt);
      prompt.querySelector('[data-cancel-delete]').addEventListener('click', () => prompt.remove());
      prompt.querySelector('[data-confirm-delete]').addEventListener('click', () => {
        deleteProject(id);
        renderHome();
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Create project                                                     */
/* ------------------------------------------------------------------ */

let chosenLot = 'standard';

function renderCreate() {
  root.innerHTML = `
    <div class="page create">
      <header class="home-head">
        <div class="brand">
          <button class="icon-btn" id="c-back" title="Back">←</button>
          <div>
            <h1>Create Project</h1>
            <p>Pick a lot type, name it, then start building</p>
          </div>
        </div>
      </header>

      <div class="create-grid">
        <section class="panel">
          <div class="panel-head"><h2>1. Lot Type</h2></div>
          <div class="lot-list" id="lot-list">
            ${LOT_LIST.map(
              (l) => `<button class="lot-opt ${l.id === chosenLot ? 'active' : ''}" data-lot="${l.id}">
                <span class="lot-name">${l.name}</span>
                <span class="lot-size">${l.w} × ${l.h}</span>
                <span class="lot-blurb">${l.blurb}</span>
              </button>`,
            ).join('')}
          </div>
          <p class="hint">Lot sizes are fixed — the canvas is not customisable.</p>

          <div class="panel-head spaced"><h2>2. Project Name</h2></div>
          <label class="field">
            <span>Name</span>
            <input type="text" id="c-name" maxlength="60" placeholder="e.g. Riverside Cottage" value="My New Home" />
          </label>
          <p class="hint" id="c-err"></p>
          <button class="primary-btn wide" id="c-create">Create Project</button>
        </section>

        <section class="panel preview-panel">
          <div class="panel-head"><h2>Lot Preview</h2><span class="muted" id="c-size"></span></div>
          <div class="lot-preview" id="c-preview"></div>
          <p class="hint">One grid cell = one unit. Room sizes snap to whole cells.</p>
        </section>
      </div>
    </div>`;

  const input = root.querySelector('#c-name');
  const drawPreview = () => {
    const lot = LOT_PRESETS[chosenLot];
    const maxPx = 380;
    const s = maxPx / Math.max(lot.w, lot.h);
    const w = lot.w * s;
    const h = lot.h * s;
    root.querySelector('#c-size').textContent = `${lot.w} × ${lot.h} cells`;
    root.querySelector('#c-preview').innerHTML = `
      <svg viewBox="0 0 ${lot.w * s + 2} ${lot.h * s + 2}" width="${w + 2}" height="${h + 2}" class="lot-svg">
        <rect x="1" y="1" width="${w}" height="${h}" rx="3" fill="#ffffff" stroke="#b9cbe2" stroke-width="1.2"/>
        <g stroke="#e2ebf6" stroke-width="0.7">
          ${Array.from({ length: lot.w - 1 }, (_, i) => `<line x1="${1 + (i + 1) * s}" y1="1" x2="${1 + (i + 1) * s}" y2="${1 + h}"/>`).join('')}
          ${Array.from({ length: lot.h - 1 }, (_, j) => `<line x1="1" y1="${1 + (j + 1) * s}" x2="${1 + w}" y2="${1 + (j + 1) * s}"/>`).join('')}
        </g>
        <rect x="1" y="1" width="${w}" height="${h}" rx="3" fill="rgba(47,125,221,0.05)"/>
      </svg>`;
  };

  root.querySelector('#lot-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.lot-opt');
    if (!btn) return;
    chosenLot = btn.dataset.lot;
    for (const b of root.querySelectorAll('.lot-opt')) b.classList.toggle('active', b === btn);
    drawPreview();
  });

  root.querySelector('#c-back').addEventListener('click', () => go('/'));
  const create = () => {
    const name = input.value.trim();
    if (!name) {
      root.querySelector('#c-err').textContent = 'Please give your project a name.';
      input.focus();
      return;
    }
    const project = newProject(name, chosenLot);
    saveProject(project);
    go(`/editor/${project.id}`);
  };
  root.querySelector('#c-create').addEventListener('click', create);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });

  drawPreview();
  input.select();
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */

function renderEditor(project) {
  root.innerHTML = '<div id="editor-host"></div>';
  const host = root.querySelector('#editor-host');
  const saveState = { timer: null };

  editor = new Editor(host, project, {
    onBack: () => go('/'),
    onChange: (p) => {
      try {
        saveProject(p);
      } catch (err) {
        // Storage full / blocked: keep the user informed but don't break edits.
        console.warn('Save failed', err);
        setSaveState('error');
      }
    },
    onStatus: (s) => setSaveState(s),
  });

  function setSaveState(state) {
    const textEl = host.querySelector('#fp-savetext');
    const wrap = host.querySelector('#fp-savestate');
    if (!textEl) return;
    if (state === 'dirty') {
      textEl.textContent = 'Saving…';
      wrap.dataset.state = 'dirty';
      clearTimeout(saveState.timer);
      saveState.timer = setTimeout(() => setSaveState('saved'), 700);
    } else if (state === 'error') {
      textEl.textContent = 'Not saved';
      wrap.dataset.state = 'error';
    } else {
      textEl.textContent = 'Saved';
      wrap.dataset.state = 'saved';
    }
  }

  // Editor auto-saves on changes; make sure a refresh mid-drag is still safe.
  statusListener = () => editor?.flushSave();
  window.addEventListener('beforeunload', statusListener);
}

/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const escapeAttr = escapeHtml;

route();

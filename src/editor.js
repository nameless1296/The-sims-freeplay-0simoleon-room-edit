/**
 * editor.js — canvas engine, camera, tools, interaction and rendering.
 *
 * FreePlay-inspired interaction model:
 *   - Create rooms by dragging on the grid (green = buildable, red = blocked).
 *   - Select / move / resize / delete rooms.
 *   - Build mode: yellow corner anchors extend a wall outwards to form an L.
 */
import {
  LOT_PRESETS,
  isL,
  rectsOf,
  pointInRoom,
  validateRoom,
  makeRoom,
  resizeEdge,
  resizeCorner,
  renovatorExtend,
  innerCornerOf,
  setInnerCorner,
  toRectangle,
  normalizeShape,
  outlineOf,
  centroidOf,
  areaOf,
  clamp,
  uid,
  roomSupported,
  validateBalcony,
  validatePool,
  validatePatio,
  validateMezzanine,
  validateDoor,
  validateStair,
  STAIR_TYPES,
  stairSize,
  floorAbove,
  poolOuterRect,
  poolBlockedCells,
} from './geometry.js';
import {
  nextRoomName,
  lotOf,
  touch,
  roomsOnFloor,
  balconiesOnFloor,
  withFloorRooms,
  withFloorBalconies,
  emptyBalconies,
  emptyDoors,
  emptyMezzanines,
  doorsOnFloor,
  mezzaninesOnFloor,
  UPPER_FLOOR_KEYS,
  floorKeysForProject,
} from './project.js';

const COLORS = {
  bg: '#eef3f9',
  lot: '#ffffff',
  lotEdge: '#b9cbe2',
  grid: '#e4ecf6',
  gridMajor: '#cfdcee',
  roomFill: '#d9e8fb',
  roomFillAlt: '#d2e3f9',
  roomWall: '#93b6e0',
  roomLabel: '#4a6690',
  selectedFill: '#bfdcff',
  selectedWall: '#2f7ddd',
  selectGlow: 'rgba(47,125,221,0.28)',
  valid: '#22a56b',
  validFill: 'rgba(34,165,107,0.22)',
  invalid: '#d64545',
  invalidFill: 'rgba(214,69,69,0.20)',
  anchor: '#ffd93d',
  anchorEdge: '#e3ab00',
  handle: '#ffffff',
  handleEdge: '#2f7ddd',
  pool: '#75c9e8',
  poolRing: '#c9eef8',
  poolEdge: '#3098bd',
};

const HIT_PX = 9; // handle hit tolerance in screen px
const MIN_ROOM = { w: 1, h: 1 };

export class Editor {
  /**
   * @param {HTMLElement} host
   * @param {object} project
   * @param {{onChange:(p:object)=>void, onBack:()=>void, onStatus:(s:string)=>void}} hooks
   */
  constructor(host, project, hooks) {
    this.host = host;
    this.project = project;
    this.hooks = hooks;

    this.selectionId = null;
    this.tool = 'select';
    this.editMode = 'create';
    this.stairType = 'narrow';
    this.stairRotated = false;
    this.floor = '1';
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.drag = null;
    this.hoverId = null;
    this.preview = null; // {room, ok, message, code}
    this.history = [{
      floor: this.floor,
      floors: clone(this.project.floors),
      balconies: clone(this.project.balconies || emptyBalconies()),
      pools: clone(this.project.pools || []),
      patios: clone(this.project.patios || []),
      doors: clone(this.project.doors || emptyDoors()),
      mezzanines: clone(this.project.mezzanines || emptyMezzanines()),
      selection: null,
    }];
    this.hIndex = 0;
    this.toastTimer = null;
    this.spaceDown = false;

    this.buildDom();
    this.bind();
    this.resize();
    this.fit();
    this.commitView();
    this.syncPanels();
    requestAnimationFrame(() => this.render());
  }

  /* ---------------------------------------------------------------- */
  /* DOM                                                              */
  /* ---------------------------------------------------------------- */

  buildDom() {
    const lot = lotOf(this.project);
    this.host.innerHTML = `
      <div class="editor">
        <header class="topbar">
          <button class="icon-btn" id="fp-back" title="Back to projects">←</button>
          <div class="proj-title">
            <input id="fp-name" class="name-input" value="" spellcheck="false" aria-label="Project name" />
            <span class="lot-chip">${lot.name} · ${lot.w} × ${lot.h}</span>
          </div>
          <div class="save-state" id="fp-savestate"><span class="dot"></span><span id="fp-savetext">Saved</span></div>
          <div class="topbar-actions">
            <button class="ghost-btn" id="fp-undo" title="Undo (Ctrl+Z)">↶ Undo</button>
            <button class="ghost-btn" id="fp-redo" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
            <button class="primary-btn" id="fp-save">Save</button>
            <button class="ghost-btn" id="fp-export-png">PNG</button>
          </div>
        </header>

        <div class="editor-body">
          <aside class="tool-rail" id="fp-tools">
            <button class="tool" data-tool="select" data-shortcut="V">
              <span class="tool-ico">${icon('select')}</span><span class="tool-lbl">Select</span>
            </button>
            <button class="tool" data-tool="edit" data-shortcut="E">
              <span class="tool-ico">${icon('edit')}</span><span class="tool-lbl">Edit</span>
            </button>
            <button class="tool tool-danger" data-tool="delete" data-shortcut="D">
              <span class="tool-ico">${icon('trash')}</span><span class="tool-lbl">Delete</span>
            </button>
            <div class="rail-spacer"></div>
            <div class="rail-hint" id="fp-toolhint"></div>
          </aside>

          <div class="canvas-wrap" id="fp-canvaswrap">
            <canvas id="fp-canvas"></canvas>
            <div class="floor-switcher" id="fp-floors" role="group" aria-label="House floor">
              ${this.floorSwitcherMarkup()}
            </div>
            <div class="canvas-badge" id="fp-mode-badge"></div>
            <div class="canvas-toast" id="fp-toast" role="status" aria-live="polite"></div>
            <button class="create-fab balcony-fab" id="fp-balcony-toggle" type="button" aria-label="Balcony mode" title="Balcony mode" hidden>${icon('balcony')}</button>
            <button class="create-fab patio-fab" id="fp-patio-toggle" type="button" aria-label="Patio mode" title="Patio mode" hidden>${icon('balcony')}</button>
            <button class="create-fab pool-fab" id="fp-pool-toggle" type="button" aria-label="Pool mode" title="Pool mode" hidden>${icon('pool')}</button>
            <button class="create-fab door-fab" id="fp-door-toggle" type="button" aria-label="Door mode" title="Door mode" hidden>${icon('door')}</button>
            <button class="create-fab stair-fab" id="fp-stair-toggle" type="button" aria-label="Stair mode" title="Stair mode" hidden>${icon('stair')}</button>
            <button class="create-fab mezzanine-fab" id="fp-mezzanine-toggle" type="button" aria-label="Mezzanine mode" title="Mezzanine mode" hidden>${icon('mezzanine')}</button>
            <button class="create-fab" id="fp-create-toggle" type="button" aria-label="Create room" title="Create room (C)" hidden>${icon('rect')}</button>
            <div class="zoombar">
              <button class="zoom-btn" id="fp-zoom-out" title="Zoom out (−)">−</button>
              <span class="zoom-val" id="fp-zoom-val">100%</span>
              <button class="zoom-btn" id="fp-zoom-in" title="Zoom in (+)">+</button>
              <button class="zoom-btn fit" id="fp-fit" title="Fit canvas (F)">${icon('fit')} Fit</button>
            </div>
          </div>

          <aside class="props" id="fp-props"></aside>
        </div>
      </div>`;

    this.el = {
      back: this.host.querySelector('#fp-back'),
      name: this.host.querySelector('#fp-name'),
      savetext: this.host.querySelector('#fp-savetext'),
      savestate: this.host.querySelector('#fp-savestate'),
      undo: this.host.querySelector('#fp-undo'),
      redo: this.host.querySelector('#fp-redo'),
      save: this.host.querySelector('#fp-save'),
      exportPng: this.host.querySelector('#fp-export-png'),
      tools: this.host.querySelector('#fp-tools'),
      floors: this.host.querySelector('#fp-floors'),
      toolhint: this.host.querySelector('#fp-toolhint'),
      canvaswrap: this.host.querySelector('#fp-canvaswrap'),
      canvas: this.host.querySelector('#fp-canvas'),
      toast: this.host.querySelector('#fp-toast'),
      badge: this.host.querySelector('#fp-mode-badge'),
      props: this.host.querySelector('#fp-props'),
      balconyToggle: this.host.querySelector('#fp-balcony-toggle'),
      patioToggle: this.host.querySelector('#fp-patio-toggle'),
      poolToggle: this.host.querySelector('#fp-pool-toggle'),
      doorToggle: this.host.querySelector('#fp-door-toggle'),
      stairToggle: this.host.querySelector('#fp-stair-toggle'),
      mezzanineToggle: this.host.querySelector('#fp-mezzanine-toggle'),
      createToggle: this.host.querySelector('#fp-create-toggle'),
      zoomVal: this.host.querySelector('#fp-zoom-val'),
      zoomIn: this.host.querySelector('#fp-zoom-in'),
      zoomOut: this.host.querySelector('#fp-zoom-out'),
      fit: this.host.querySelector('#fp-fit'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    this.el.name.value = this.project.name;
  }

  bind() {
    const e = this.el;

    e.back.addEventListener('click', () => {
      this.flushSave();
      this.hooks.onBack();
    });

    e.name.addEventListener('input', () => {
      this.project.name = e.name.value.slice(0, 60) || 'Untitled Home';
      this.markDirty();
    });

    e.undo.addEventListener('click', () => this.undo());
    e.redo.addEventListener('click', () => this.redo());
    e.save.addEventListener('click', () => {
      this.flushSave(true);
      this.toast('Project saved locally');
    });
    e.exportPng.addEventListener('click', async () => {
      try {
        await this.downloadPng();
      } catch (err) {
        console.error('PNG export failed', err);
        this.toast(`PNG export failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    });

    e.tools.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.tool');
      if (!btn) return;
      this.setTool(btn.dataset.tool);
    });
    e.floors.addEventListener('click', (ev) => {
      const deleteBtn = ev.target.closest('[data-delete-floor]');
      if (deleteBtn) {
        this.openFloorDeletePrompt(deleteBtn.dataset.deleteFloor);
        return;
      }
      if (ev.target.closest('#fp-confirm-delete-floor')) {
        const floor = this.floorDeleteTarget;
        if (floor) this.deleteFloor(floor);
        return;
      }
      if (ev.target.closest('#fp-confirm-create-floor')) {
        const acknowledged = this.el.floors.querySelector('#fp-third-floor-acknowledge')?.checked === true;
        this.closeFloorDeletePrompt();
        if (acknowledged) {
          this.project = touch({ ...this.project, penthouseThirdFloorAcknowledged: true });
        }
        this.createUpperFloor('3');
        return;
      }
      if (ev.target.closest('#fp-cancel-delete-floor')) {
        this.closeFloorDeletePrompt();
        return;
      }
      const btn = ev.target.closest('[data-floor]');
      if (btn) this.setFloor(btn.dataset.floor);
      if (ev.target.closest('#fp-add-floor')) this.addFloor();
      if (ev.target.closest('#fp-add-basement')) this.addBasement();
    });
    e.createToggle.addEventListener('click', () => {
      if (this.tool !== 'edit') return;
      this.cycleEditMode();
    });
    e.balconyToggle.addEventListener('click', () => this.toggleBalconyMode());
    e.patioToggle.addEventListener('click', () => this.togglePatioMode());
    e.poolToggle.addEventListener('click', () => this.togglePoolMode());
    e.doorToggle.addEventListener('click', () => this.toggleDoorMode());
    e.stairToggle.addEventListener('click', () => this.toggleStairMode());
    e.mezzanineToggle.addEventListener('click', () => this.toggleMezzanineMode());

    e.zoomIn.addEventListener('click', () => this.zoomAt(1.25));
    e.zoomOut.addEventListener('click', () => this.zoomAt(1 / 1.25));
    e.fit.addEventListener('click', () => this.fit());

    const cv = e.canvas;
    cv.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    cv.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    cv.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    cv.addEventListener('pointercancel', (ev) => this.onPointerUp(ev));
    cv.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hoverId = null;
        this.render();
      }
    });
    cv.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    cv.addEventListener('contextmenu', (ev) => ev.preventDefault());

    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
    window.addEventListener('keyup', (ev) => {
      if (ev.code === 'Space') this.spaceDown = false;
    });

    // Debug / automation handle
    window.__fp = this;

    this.ro = new ResizeObserver(() => {
      this.resize();
      this.render();
    });
    this.ro.observe(e.canvaswrap);

    this.onUnload = () => this.flushSave();
    window.addEventListener('beforeunload', this.onUnload);
  }

  destroy() {
    this.ro?.disconnect();
    window.removeEventListener('beforeunload', this.onUnload);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                           */
  /* ---------------------------------------------------------------- */

  resize() {
    const rect = this.el.canvaswrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cw = Math.max(1, Math.round(rect.width));
    this.ch = Math.max(1, Math.round(rect.height));
    this.el.canvas.width = this.cw * dpr;
    this.el.canvas.height = this.ch * dpr;
    this.el.canvas.style.width = `${this.cw}px`;
    this.el.canvas.style.height = `${this.ch}px`;
    this.minScale = this.fitScale() * 0.35;
    if (this.el?.zoomVal) this.commitView();
  }

  fitScale() {
    const lot = lotOf(this.project);
    const pad = 56;
    const sx = (this.cw - pad * 2) / lot.w;
    const sy = (this.ch - pad * 2) / lot.h;
    return Math.max(6, Math.min(sx, sy));
  }

  fit() {
    const lot = lotOf(this.project);
    const s = this.fitScale();
    this.view.scale = s;
    this.view.tx = (this.cw - lot.w * s) / 2;
    this.view.ty = (this.ch - lot.h * s) / 2;
    this.commitView();
  }

  commitView() {
    this.prevScale = this.view.scale;
    const base = this.fitScale();
    const pct = Math.round((this.view.scale / base) * 100);
    this.el.zoomVal.textContent = `${pct}%`;
    this.el.zoomVal.title = pct === 100 ? 'Fitted to the lot' : 'Relative to fit view';
  }

  zoomAt(factor, screenX, screenY) {
    const sx = screenX ?? this.cw / 2;
    const sy = screenY ?? this.ch / 2;
    const v = this.view;
    const next = clamp(v.scale * factor, this.minScale, this.fitScale() * 8);
    if (next === v.scale) return;
    const wx = (sx - v.tx) / v.scale;
    const wy = (sy - v.ty) / v.scale;
    v.scale = next;
    v.tx = sx - wx * next;
    v.ty = sy - wy * next;
    this.commitView();
    this.render();
  }

  onWheel(ev) {
    ev.preventDefault();
    const rect = this.el.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    if (ev.ctrlKey || ev.metaKey) {
      this.zoomAt(Math.exp(-ev.deltaY * 0.0025), px, py);
      return;
    }
    // Trackpad/two-finger: pan; mouse wheel: zoom (feels right for a planner).
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      this.view.tx -= ev.deltaX;
      this.view.ty -= ev.deltaY;
      this.render();
    } else {
      this.zoomAt(Math.exp(-ev.deltaY * 0.0018), px, py);
    }
  }

  toWorld(ev) {
    const rect = this.el.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    return {
      x: (px - this.view.tx) / this.view.scale,
      y: (py - this.view.ty) / this.view.scale,
      px,
      py,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tools                                                            */
  /* ---------------------------------------------------------------- */

  setTool(tool) {
    if (tool === this.tool) return;
    this.tool = tool;
    if (tool === 'edit') this.editMode = 'create';
    this.drag = null;
    this.preview = null;
    this.syncToolUi();
    this.syncPanels();
    this.render();
  }

  get rooms() {
    return roomsOnFloor(this.project, this.floor);
  }

  get supportRooms() {
    const floor = Number(this.floor);
    if (!Number.isFinite(floor) || floor <= 1) return null;
    return roomsOnFloor(this.project, '1');
  }

  get blockedBalconyCells() {
    const floor = Number(this.floor);
    if (!Number.isFinite(floor) || floor <= 2) return null;
    const cells = new Set();
    for (const below of ['2', '3', '4'].filter((key) => Number(key) < floor)) {
      for (const balcony of balconiesOnFloor(this.project, below)) {
        for (let x = balcony.x; x < balcony.x + balcony.w; x += 1) {
          for (let y = balcony.y; y < balcony.y + balcony.h; y += 1) {
            cells.add(`${x},${y}`);
          }
        }
      }
    }
    return cells;
  }

  get pools() {
    return this.project.pools || [];
  }

  get patios() {
    return this.project.patios || [];
  }

  get blockedPoolCells() {
    return poolBlockedCells(this.pools);
  }

  get blockedRoomCells() {
    return this.floor === 'basement' ? this.blockedPoolCells : this.blockedBalconyCells;
  }

  get roomObstacles() {
    const pools = this.floor === '1'
      ? this.pools.map((pool) => ({ ...poolOuterRect(pool), id: pool.id, name: pool.name }))
      : [];
    const patios = this.floor === '1' ? this.patios : [];
    return [...this.rooms, ...this.balconies, ...pools, ...patios];
  }

  get balconies() {
    return balconiesOnFloor(this.project, this.floor);
  }

  get poolModeAvailable() {
    return this.floor === '1';
  }

  get patioModeAvailable() {
    return this.floor === '1';
  }

  get balconyModeAvailable() {
    return Number(this.floor) >= 2 && Number(this.floor) <= 5;
  }

  get stairUpperFloor() {
    const upperFloor = floorAbove(this.floor);
    return floorKeysForProject(this.project).includes(upperFloor) ? upperFloor : null;
  }

  get stairModeAvailable() {
    return this.stairUpperFloor !== null;
  }

  get placementReferenceFloor() {
    if (this.tool !== 'edit') return null;
    if (this.editMode === 'stairs') return this.stairUpperFloor;
    if (this.editMode === 'mezzanine') return this.lowerMezzanineFloor;
    return null;
  }

  get mezzanineModeAvailable() {
    const lowerFloor = this.lowerMezzanineFloor;
    return lowerFloor !== null && floorKeysForProject(this.project).includes(lowerFloor);
  }

  cycleEditMode() {
    const modes = ['create', 'lroom'];
    const index = modes.indexOf(this.editMode);
    const leavingBalconyMode = ['balcony', 'pool', 'patio'].includes(this.editMode);
    this.editMode = modes[(index + 1) % modes.length];
    if (leavingBalconyMode) this.selectionId = null;
    this.syncToolUi();
    this.syncPanels();
    this.render();
    const messages = {
      create: 'Create Room: drag on the grid to draw a room',
      lroom: 'L-Shape: select a room, then drag a yellow corner anchor outward',
    };
    this.toast(messages[this.editMode]);
  }

  toggleBalconyMode() {
    if (this.tool !== 'edit' || !this.balconyModeAvailable) return;
    this.editMode = this.editMode === 'balcony' ? 'create' : 'balcony';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'balcony'
      ? 'Balcony: drag across the grid to create, or select a balcony to move or resize'
      : 'Create Room: drag on the grid to draw a room');
  }

  togglePoolMode() {
    if (this.tool !== 'edit' || !this.poolModeAvailable) return;
    this.editMode = this.editMode === 'pool' ? 'create' : 'pool';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'pool'
      ? 'Pool: drag a core at least 3 × 3. Its 1-cell outer ring blocks Basement.'
      : 'Create Room: drag on the grid to draw a room');
  }

  togglePatioMode() {
    if (this.tool !== 'edit' || !this.patioModeAvailable) return;
    this.editMode = this.editMode === 'patio' ? 'create' : 'patio';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'patio'
      ? 'Patio: drag on the grid to create, or select a patio to move or resize it.'
      : 'Create Room: drag on the grid to draw a room');
  }

  toggleDoorMode() {
    if (this.tool !== 'edit') return;
    this.editMode = this.editMode === 'door' ? 'create' : 'door';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'door'
      ? 'Door: click or drag on a room wall to place a door 1-4 cells wide.'
      : 'Create Room: drag on the grid to draw a room');
  }

  toggleStairMode() {
    if (this.tool !== 'edit') return;
    if (!this.stairModeAvailable) {
      this.toast('Add the next floor before placing stairs.', true);
      return;
    }
    this.editMode = this.editMode === 'stairs' ? 'create' : 'stairs';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'stairs'
      ? 'Stairs: choose a type, then click inside a room to place them.'
      : 'Create Room: drag on the grid to draw a room');
  }

  toggleMezzanineMode() {
    if (this.tool !== 'edit') return;
    if (!this.mezzanineModeAvailable) {
      this.toast('A mezzanine requires an existing floor directly below.', true);
      return;
    }
    this.editMode = this.editMode === 'mezzanine' ? 'create' : 'mezzanine';
    this.selectionId = null;
    this.preview = null;
    this.syncPanels();
    this.render();
    this.toast(this.editMode === 'mezzanine'
      ? 'Mezzanine: drag an area fully inside one room on the floor below.'
      : 'Create Room: drag on the grid to draw a room');
  }

  supportedCells(rooms = this.supportRooms) {
    const cells = new Set();
    if (this.floor === 'basement') {
      const lot = lotOf(this.project);
      for (let x = 0; x < lot.w; x += 1) {
        for (let y = 0; y < lot.h; y += 1) {
          if (!this.blockedPoolCells.has(`${x},${y}`)) cells.add(`${x},${y}`);
        }
      }
      return cells;
    }
    if (!rooms) return null;
    for (const room of rooms) {
      for (const rect of rectsOf(room)) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          for (let y = rect.y; y < rect.y + rect.h; y += 1) {
            cells.add(`${x},${y}`);
          }
        }
      }
    }
    const blocked = this.blockedBalconyCells;
    if (blocked) for (const key of blocked) cells.delete(key);
    return cells;
  }

  setFloor(floor) {
    if (!floorKeysForProject(this.project).includes(floor) || floor === this.floor) return;
    this.floor = floor;
    if (this.editMode === 'balcony' && !this.balconyModeAvailable) this.editMode = 'create';
    if (this.editMode === 'pool' && !this.poolModeAvailable) this.editMode = 'create';
    if (this.editMode === 'patio' && !this.patioModeAvailable) this.editMode = 'create';
    if (this.editMode === 'stairs' && !this.stairModeAvailable) this.editMode = 'create';
    if (this.editMode === 'mezzanine' && !this.mezzanineModeAvailable) this.editMode = 'create';
    this.selectionId = null;
    this.drag = null;
    this.preview = null;
    this.setFloorUi();
    this.syncPanels();
    this.render();
  }

  setFloorUi() {
    this.el.floors.innerHTML = this.floorSwitcherMarkup();
  }

  floorSwitcherMarkup() {
    const floors = floorKeysForProject(this.project);
    const maxUpperFloor = Math.max(...floors.filter((floor) => floor !== 'basement').map(Number));
    const canAddFloor = maxUpperFloor < UPPER_FLOOR_KEYS.length;
    const canAddBasement = !floors.includes('basement');
    return [
      ...floors.map((floor) => `
        <span class="floor-option">
          <button class="floor-btn ${floor === this.floor ? 'active' : ''}" type="button" data-floor="${floor}" aria-pressed="${floor === this.floor}">
            ${floor === 'basement' ? 'Basement' : `${floor}F`}
          </button>
          ${floor === 'basement' || floor !== '1' && Number(floor) === maxUpperFloor
            ? `<button class="floor-delete-btn" type="button" data-delete-floor="${floor}" aria-label="Delete ${floor === 'basement' ? 'Basement' : `${floor}F`}" title="Delete ${floor === 'basement' ? 'Basement' : `${floor}F`}">×</button>`
            : ''}
        </span>`),
      canAddFloor
        && maxUpperFloor < (this.project.lot === 'penthouse' ? 3 : UPPER_FLOOR_KEYS.length)
        ? '<button class="floor-btn floor-add-btn" id="fp-add-floor" type="button">+ Add Floor</button>'
        : '',
      canAddBasement && this.project.lot !== 'penthouse'
        ? '<button class="floor-btn floor-add-btn" id="fp-add-basement" type="button">+ Add Basement</button>'
        : '',
      this.floorDeletePrompt || '',
    ].join('');
  }

  openFloorDeletePrompt(floor) {
    const floors = floorKeysForProject(this.project);
    const maxUpperFloor = Math.max(...floors.filter((key) => key !== 'basement').map(Number));
    const removableFloors = floors.filter((key) =>
      key === 'basement' || key !== '1' && Number(key) === maxUpperFloor,
    );
    if (!removableFloors.includes(floor)) return;
    this.floorDeleteTarget = floor;
    this.floorPromptKind = 'delete-floor';
    const label = floor === 'basement' ? 'Basement' : `${floor}F`;
    this.floorDeletePrompt = `
      <div class="floor-delete-popover" role="dialog" aria-label="Delete floor">
        <strong>Delete ${label}?</strong>
        <p>Only ${label} and its rooms will be removed. Other floors will remain.</p>
        <div class="floor-delete-actions">
          <button class="ghost-btn sm" id="fp-cancel-delete-floor" type="button">Cancel</button>
          <button class="danger-btn sm" id="fp-confirm-delete-floor" type="button">Delete</button>
        </div>
      </div>`;
    this.setFloorUi();
  }

  closeFloorDeletePrompt() {
    this.floorDeletePrompt = '';
    this.floorDeleteTarget = null;
    this.floorPromptKind = null;
    this.setFloorUi();
  }

  addFloor() {
    const floors = floorKeysForProject(this.project);
    const currentTop = Math.max(...floors.filter((floor) => floor !== 'basement').map(Number));
    const nextFloor = UPPER_FLOOR_KEYS[currentTop];
    if (!nextFloor || Number(nextFloor) > (this.project.lot === 'penthouse' ? 3 : 5)) return;
    if (this.project.lot === 'penthouse' && nextFloor === '3' &&
        !this.project.penthouseThirdFloorAcknowledged) {
      this.openThirdFloorPrompt();
      return;
    }
    this.createUpperFloor(nextFloor);
  }

  openThirdFloorPrompt() {
    this.floorPromptKind = 'create-third-floor';
    this.floorDeletePrompt = `
      <div class="floor-delete-popover penthouse-floor-prompt" role="dialog" aria-labelledby="fp-third-floor-title">
        <strong id="fp-third-floor-title">Create 3F?</strong>
        <p>This includes Development Site content.</p>
        <label class="floor-acknowledge">
          <input id="fp-third-floor-acknowledge" type="checkbox">
          <span>I understand. Don't show this again.</span>
        </label>
        <div class="floor-delete-actions">
          <button class="ghost-btn sm" id="fp-cancel-delete-floor" type="button">Cancel</button>
          <button class="primary-btn sm" id="fp-confirm-create-floor" type="button">Create 3F</button>
        </div>
      </div>`;
    this.setFloorUi();
  }

  createUpperFloor(nextFloor) {
    if (!UPPER_FLOOR_KEYS.includes(nextFloor) || floorKeysForProject(this.project).includes(nextFloor)) return;
    this.project = touch(withFloorRooms(this.project, nextFloor, []));
    this.floor = nextFloor;
    if (['balcony', 'pool', 'patio'].includes(this.editMode)) this.editMode = 'create';
    this.selectionId = null;
    this.preview = null;
    this.drag = null;
    this.pushHistory(`Add ${nextFloor}F`);
    this.markDirty();
    this.setFloorUi();
    this.syncPanels();
    this.render();
  }

  addBasement() {
    if (this.project.lot === 'penthouse' || floorKeysForProject(this.project).includes('basement')) return;
    this.project = touch(withFloorRooms(this.project, 'basement', []));
    this.floor = 'basement';
    if (['balcony', 'pool', 'patio'].includes(this.editMode)) this.editMode = 'create';
    this.selectionId = null;
    this.preview = null;
    this.drag = null;
    this.pushHistory('Add Basement');
    this.markDirty();
    this.setFloorUi();
    this.syncPanels();
    this.render();
  }

  deleteFloor(floor) {
    const availableFloors = floorKeysForProject(this.project);
    const maxUpperFloor = Math.max(...availableFloors.filter((key) => key !== 'basement').map(Number));
    if (!availableFloors.includes(floor) ||
        floor !== 'basement' && (floor === '1' || Number(floor) !== maxUpperFloor)) {
      this.toast('Delete the highest floor first.', true);
      return;
    }
    const label = floor === 'basement' ? 'Basement' : `${floor}F`;

    if (this.floor === floor && this.hIndex >= 0) {
      this.history[this.hIndex] = {
        ...this.history[this.hIndex],
        floor,
        selection: this.selectionId,
      };
    }
    const floors = { ...this.project.floors };
    const balconies = { ...this.project.balconies };
    const doors = { ...this.project.doors };
    const mezzanines = { ...this.project.mezzanines };
    const stairs = (this.project.stairs || []).filter((stair) =>
      stair.lowerFloor !== floor && floorAbove(stair.lowerFloor) !== floor,
    );
    delete floors[floor];
    delete balconies[floor];
    delete doors[floor];
    delete mezzanines[floor];
    const upperFloor = floor === 'basement' ? '1' : String(Number(floor) + 1);
    if (upperFloor) delete mezzanines[upperFloor];
    this.project = touch({ ...this.project, floors, balconies, doors, stairs, mezzanines });
    this.floorDeletePrompt = '';
    this.floorDeleteTarget = null;
    if (this.floor === floor) {
      this.floor = floor === 'basement' ? '1' : String(Math.max(1, Number(floor) - 1));
    }
    this.selectionId = null;
    this.preview = null;
    this.drag = null;
    this.pushHistory(`Delete ${label}`);
    this.markDirty();
    this.setFloorUi();
    this.syncPanels();
    this.render();
    this.toast(`${label} deleted`);
  }

  syncToolUi() {
    for (const btn of this.el.tools.querySelectorAll('.tool')) {
      btn.classList.toggle('active', btn.dataset.tool === this.tool);
    }
    const isEditing = this.tool === 'edit';
    const lMode = isEditing && this.editMode === 'lroom';
    const balconyMode = isEditing && this.editMode === 'balcony';
    const poolMode = isEditing && this.editMode === 'pool';
    const patioMode = isEditing && this.editMode === 'patio';
    const doorMode = isEditing && this.editMode === 'door';
    const stairMode = isEditing && this.editMode === 'stairs';
    const mezzanineMode = isEditing && this.editMode === 'mezzanine';
    this.el.balconyToggle.hidden = !isEditing || !this.balconyModeAvailable;
    this.el.balconyToggle.classList.toggle('active', balconyMode);
    this.el.balconyToggle.setAttribute('aria-pressed', String(balconyMode));
    this.el.poolToggle.hidden = !isEditing || !this.poolModeAvailable;
    this.el.poolToggle.classList.toggle('active', poolMode);
    this.el.poolToggle.setAttribute('aria-pressed', String(poolMode));
    this.el.patioToggle.hidden = !isEditing || !this.patioModeAvailable;
    this.el.patioToggle.classList.toggle('active', patioMode);
    this.el.patioToggle.setAttribute('aria-pressed', String(patioMode));
    this.el.doorToggle.hidden = !isEditing;
    this.el.doorToggle.classList.toggle('active', doorMode);
    this.el.doorToggle.setAttribute('aria-pressed', String(doorMode));
    this.el.stairToggle.hidden = !isEditing || !this.stairModeAvailable;
    this.el.stairToggle.classList.toggle('active', stairMode);
    this.el.stairToggle.setAttribute('aria-pressed', String(stairMode));
    this.el.mezzanineToggle.hidden = !isEditing || !this.mezzanineModeAvailable;
    this.el.mezzanineToggle.classList.toggle('active', mezzanineMode);
    this.el.mezzanineToggle.setAttribute('aria-pressed', String(mezzanineMode));
    this.el.createToggle.hidden = !isEditing;
    this.el.createToggle.classList.toggle('active', lMode);
    this.el.createToggle.innerHTML = icon(lMode ? 'lshape' : 'rect');
    const modeLabel = lMode ? 'L-shape mode' : 'Create room';
    this.el.createToggle.setAttribute('aria-label', modeLabel);
    this.el.createToggle.setAttribute('aria-pressed', String(lMode));
    this.el.createToggle.title = lMode
      ? 'L-Shape mode: select a room and drag a yellow anchor'
      : 'Create room: drag on empty grid';
    const hints = {
      select: 'Select any room, balcony, patio, pool, door, stairs, or mezzanine. Drag an object to move it or drag a handle to resize it.',
      edit: this.editMode === 'lroom'
        ? 'Drag a yellow corner anchor to extend the selected room into an L. Drag its inner corner to adjust the extension.'
        : balconyMode
          ? 'Drag across the grid to create a balcony. Select an existing balcony to move it or drag an outer handle to resize it.'
          : patioMode
            ? 'Drag across the grid to create a patio. Drag an existing patio to move it or an outer handle to resize it. Patios cannot overlap rooms or pool cores or outer rings.'
            : poolMode
              ? 'Drag to create a pool core at least 3 × 3. Drag an existing pool to move it or an edge handle to resize it. The outer ring also blocks Basement rooms.'
              : doorMode
                ? 'Click or drag along a room wall to place a door 1-4 cells wide. Doors can sit on exterior or shared walls.'
                : stairMode
                ? 'Choose a stair type and click inside a room. The next floor is shown as a translucent overlay.'
                  : mezzanineMode
                  ? 'Drag to place a mezzanine inside one room on the floor below, shown as a translucent overlay.'
          : this.supportRooms
          ? 'Gray cells are outside 1F room support, covered by a balcony below, or blocked by a pool in Basement.'
          : this.floor === 'basement'
            ? 'Basement is unrestricted except for pool core and outer-ring cells, shown in gray.'
            : 'Drag empty grid space to create a room. Drag an existing room or its handles to move or resize it.',
      delete: 'Click a room, balcony, patio, pool, door, stairs, or mezzanine to remove it.',
    };
    this.el.toolhint.textContent = hints[this.tool] || '';
    this.el.floors.dataset.activeFloor = this.floor;
    const badge = this.el.badge;
    if (isEditing) {
      const referenceFloor = this.placementReferenceFloor;
      const referenceLabel = referenceFloor
        ? ` · ${referenceFloor === 'basement' ? 'BASEMENT' : `${referenceFloor}F`} GHOST`
        : '';
      badge.textContent = (lMode ? 'L-SHAPE MODE' : balconyMode ? 'BALCONY MODE' : poolMode ? 'POOL MODE' : patioMode ? 'PATIO MODE' : doorMode ? 'DOOR MODE' : stairMode ? 'STAIR MODE' : mezzanineMode ? 'MEZZANINE MODE' : 'EDIT MODE') + referenceLabel;
      badge.classList.add('show');
      badge.classList.toggle('renovator', lMode);
    } else {
      badge.classList.remove('show');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pointer interaction                                              */
  /* ---------------------------------------------------------------- */

  get selected() {
    return this.rooms.find((r) => r.id === this.selectionId) || null;
  }

  get selectedBalcony() {
    return this.balconies.find((balcony) => balcony.id === this.selectionId) || null;
  }

  get selectedPatio() {
    return this.patioModeAvailable
      ? this.patios.find((patio) => patio.id === this.selectionId) || null
      : null;
  }

  get selectedPool() {
    return this.poolModeAvailable
      ? this.pools.find((pool) => pool.id === this.selectionId) || null
      : null;
  }

  get doors() {
    return doorsOnFloor(this.project, this.floor);
  }

  get selectedDoor() {
    return this.doors.find((door) => door.id === this.selectionId) || null;
  }

  get stairs() {
    return this.project.stairs || [];
  }

  get mezzanines() {
    return mezzaninesOnFloor(this.project, this.floor);
  }

  get selectedMezzanine() {
    return this.mezzanines.find((mezzanine) => mezzanine.id === this.selectionId) || null;
  }

  get lowerMezzanineFloor() {
    const floor = Number(this.floor);
    if (this.floor === '1' && this.project.floors?.basement) return 'basement';
    return Number.isInteger(floor) && floor >= 2 ? String(floor - 1) : null;
  }

  mezzanineFloorLabel(floor) {
    return floor === 'basement' ? 'Basement' : `${floor}F`;
  }

  mezzanineCandidateAt(x, y, w, h, id = '__new_mezzanine__') {
    return { id, name: 'Mezzanine', x, y, w, h };
  }

  validateMezzanineCandidate(candidate, excludeId = null) {
    const lowerFloor = this.lowerMezzanineFloor;
    if (!lowerFloor || !this.mezzanineModeAvailable) {
      return { ok: false, code: 'floor', message: 'A mezzanine needs an existing floor directly below.' };
    }
    return validateMezzanine(
      candidate,
      roomsOnFloor(this.project, lowerFloor),
      this.mezzanines.filter((item) => item.id !== excludeId),
      lotOf(this.project),
      this.rooms,
    );
  }

  get stairsOnFloor() {
    return this.stairs.filter((stair) =>
      stair.lowerFloor === this.floor || floorAbove(stair.lowerFloor) === this.floor,
    );
  }

  get selectedStair() {
    return this.stairsOnFloor.find((stair) => stair.id === this.selectionId) || null;
  }

  stairRooms(floor, rooms = null) {
    return floor === this.floor && rooms ? rooms : roomsOnFloor(this.project, floor);
  }

  validateStairCandidate(stair, excludeId = null, roomsOverride = null) {
    const upperFloor = floorAbove(stair.lowerFloor);
    const floors = floorKeysForProject(this.project);
    return validateStair(
      stair,
      this.stairRooms(stair.lowerFloor, roomsOverride?.floor === stair.lowerFloor ? roomsOverride.rooms : null),
      this.stairRooms(upperFloor, roomsOverride?.floor === upperFloor ? roomsOverride.rooms : null),
      this.stairs.filter((item) => item.id !== excludeId),
      lotOf(this.project),
      floors,
    );
  }

  stairAt(wx, wy) {
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    return this.stairsOnFloor.find((stair) => {
      const { w, h } = stairSize(stair);
      return x >= stair.x && x < stair.x + w && y >= stair.y && y < stair.y + h;
    }) || null;
  }

  stairAtCell(x, y) {
    return this.stairAt(x + 0.5, y + 0.5);
  }

  stairCandidateAt(x, y, { type = this.stairType, rotated = this.stairRotated, lowerFloor = this.floor } = {}) {
    return {
      id: '__new_stair__',
      type,
      rotated,
      x,
      y,
      lowerFloor,
    };
  }

  balconyHandleEdges(balcony) {
    return ['N', 'E', 'S', 'W'];
  }

  balconyHandleAt(balcony, wx, wy, tolerance) {
    for (const edge of this.balconyHandleEdges(balcony)) {
      const vertical = edge === 'E' || edge === 'W';
      const x = edge === 'W' ? balcony.x : edge === 'E' ? balcony.x + balcony.w : balcony.x + balcony.w / 2;
      const y = edge === 'N' ? balcony.y : edge === 'S' ? balcony.y + balcony.h : balcony.y + balcony.h / 2;
      const distance = vertical ? Math.abs(wx - x) : Math.abs(wy - y);
      const along = vertical ? wy : wx;
      const min = vertical ? balcony.y : balcony.x;
      const max = vertical ? balcony.y + balcony.h : balcony.x + balcony.w;
      if (distance <= tolerance && along >= min - tolerance && along <= max + tolerance) return edge;
    }
    return null;
  }

  poolHandleAt(pool, wx, wy, tolerance) {
    return this.balconyHandleAt(pool, wx, wy, tolerance);
  }

  roomAt(wx, wy) {
    // topmost first
    for (let i = this.rooms.length - 1; i >= 0; i -= 1) {
      if (pointInRoom(this.rooms[i], wx, wy)) return this.rooms[i];
    }
    return null;
  }

  balconyAt(wx, wy) {
    const cx = Math.floor(wx);
    const cy = Math.floor(wy);
    return this.balconies.find((balcony) =>
      cx >= balcony.x && cx < balcony.x + balcony.w &&
      cy >= balcony.y && cy < balcony.y + balcony.h,
    ) || null;
  }

  poolAt(wx, wy) {
    if (!this.poolModeAvailable) return null;
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    const inCore = this.pools.find((pool) =>
      x >= pool.x && x < pool.x + pool.w &&
      y >= pool.y && y < pool.y + pool.h,
    );
    if (inCore) return inCore;
    return this.pools.find((pool) => {
      const outer = poolOuterRect(pool);
      return x >= outer.x && x < outer.x + outer.w && y >= outer.y && y < outer.y + outer.h;
    }) || null;
  }

  doorAt(wx, wy) {
    const tolerance = 0.2;
    return this.doors.find((door) => door.orientation === 'horizontal'
      ? Math.abs(wy - door.y) <= tolerance &&
        wx >= door.x - tolerance && wx <= door.x + door.length + tolerance
      : Math.abs(wx - door.x) <= tolerance &&
        wy >= door.y - tolerance && wy <= door.y + door.length + tolerance) || null;
  }

  doorWallAt(wx, wy, orientation = null) {
    const candidates = [
      { orientation: 'horizontal', x: Math.floor(wx), y: Math.round(wy), distance: Math.abs(wy - Math.round(wy)) },
      { orientation: 'vertical', x: Math.round(wx), y: Math.floor(wy), distance: Math.abs(wx - Math.round(wx)) },
    ].filter((candidate) =>
      (!orientation || candidate.orientation === orientation) &&
      candidate.distance <= 0.25 &&
      validateDoor(
        { ...candidate, length: 1 },
        this.rooms,
        this.doors,
        { interiorOnly: this.floor === 'basement' },
      ).ok,
    );
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0] || null;
  }

  doorHandleAt(door, wx, wy, tolerance) {
    const vertical = door.orientation === 'vertical';
    const axis = vertical ? wy : wx;
    const lineDistance = vertical ? Math.abs(wx - door.x) : Math.abs(wy - door.y);
    if (lineDistance > tolerance) return null;
    const start = vertical ? door.y : door.x;
    const startOffset = door.length === 1 ? 0.25 : 0.5;
    const endOffset = door.length === 1 ? 0.75 : door.length - 0.5;
    const startDistance = Math.abs(axis - (start + startOffset));
    const endDistance = Math.abs(axis - (start + endOffset));
    if (startDistance <= tolerance && startDistance < endDistance) return 'start';
    if (endDistance <= tolerance) return 'end';
    return null;
  }

  patioAt(wx, wy) {
    if (!this.patioModeAvailable) return null;
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    return this.patios.find((patio) =>
      x >= patio.x && x < patio.x + patio.w &&
      y >= patio.y && y < patio.y + patio.h,
    ) || null;
  }

  mezzanineAt(wx, wy) {
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    return this.mezzanines.find((mezzanine) =>
      x >= mezzanine.x && x < mezzanine.x + mezzanine.w &&
      y >= mezzanine.y && y < mezzanine.y + mezzanine.h,
    ) || null;
  }

  onPointerDown(ev) {
    if (ev.button === 1 || ev.button === 2 || this.spaceDown) {
      this.startPan(ev);
      return;
    }
    if (ev.button !== 0) return;
    const p = this.toWorld(ev);
    const cell = { cx: Math.floor(p.x), cy: Math.floor(p.y) };
    this.el.canvas.setPointerCapture(ev.pointerId);

    if (this.tool === 'delete') {
      const door = this.doorAt(p.x, p.y);
      if (door) {
        this.deleteDoor(door.id);
        return;
      }
      const mezzanine = this.mezzanineAt(p.x, p.y);
      if (mezzanine) {
        this.deleteMezzanine(mezzanine.id);
        return;
      }
      const stair = this.stairAt(p.x, p.y);
      if (stair) {
        this.deleteStair(stair.id);
        return;
      }
      const pool = this.poolAt(p.x, p.y);
      if (pool) {
        this.deletePool(pool.id);
        return;
      }
      const balcony = this.balconyAt(p.x, p.y);
      if (balcony) {
        this.deleteBalcony(balcony.id);
        return;
      }
      const patio = this.patioAt(p.x, p.y);
      if (patio) {
        this.deletePatio(patio.id);
        return;
      }
      const room = this.roomAt(p.x, p.y);
      if (room) this.deleteRoom(room.id);
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'mezzanine') {
      const handleTarget = this.mezzanines.find((item) =>
        this.balconyHandleAt(item, p.x, p.y, HIT_PX / this.view.scale),
      );
      const mezzanine = handleTarget || this.mezzanineAt(p.x, p.y);
      if (mezzanine) {
        this.selectionId = mezzanine.id;
        const handle = handleTarget
          ? this.balconyHandleAt(mezzanine, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'mezzanine-resize' : 'mezzanine-move',
          orig: clone(mezzanine),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = null;
      this.drag = { kind: 'mezzanine', start: cell, pointerId: ev.pointerId };
      this.syncPanels();
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'stairs') {
      const existing = this.stairAt(p.x, p.y);
      if (existing) {
        this.selectionId = existing.id;
        this.drag = {
          kind: 'stair-move',
          orig: clone(existing),
          start: { cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      const candidate = this.stairCandidateAt(cell.cx, cell.cy);
      const check = this.validateStairCandidate(candidate);
      if (!check.ok) {
        this.toast(check.message, true);
        return;
      }
      const created = { ...candidate, id: uid('stair') };
      this.applyStairs([...this.stairs, created], 'Place stairs');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'door') {
      const door = this.doorAt(p.x, p.y);
      if (door) {
        this.selectionId = door.id;
        this.drag = {
          kind: 'door-move',
          orig: clone(door),
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      const wall = this.doorWallAt(p.x, p.y);
      if (!wall) {
        this.toast('Doors must be placed on a room wall.', true);
        return;
      }
      this.selectionId = null;
      this.drag = { kind: 'door', start: wall, pointerId: ev.pointerId };
      this.updateDoorPreview(wall.x, wall.y);
      this.syncPanels();
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'patio') {
      const handleTarget = this.patios.find((patio) =>
        this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale),
      );
      const patio = handleTarget || this.patioAt(p.x, p.y);
      if (patio) {
        this.selectionId = patio.id;
        const handle = handleTarget
          ? this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'patio-resize' : 'patio-move',
          patioId: patio.id,
          orig: clone(patio),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = null;
      this.drag = { kind: 'patio', start: cell, pointerId: ev.pointerId };
      this.syncPanels();
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'pool') {
      const handleTarget = this.pools.find((pool) =>
        this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale),
      );
      const pool = handleTarget || this.poolAt(p.x, p.y);
      if (pool) {
        this.selectionId = pool.id;
        const handle = handleTarget ? this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale) : null;
        this.drag = {
          kind: handle ? 'pool-resize' : 'pool-move',
          poolId: pool.id,
          orig: clone(pool),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = null;
      this.drag = { kind: 'pool', start: cell, pointerId: ev.pointerId };
      this.syncPanels();
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'lroom') {
      const selected = this.selected;
      if (selected) {
        const tol = HIT_PX / this.view.scale;
        if (isL(selected)) {
          const ic = innerCornerOf(selected);
          if (Math.abs(p.x - ic.x) <= tol + 0.3 && Math.abs(p.y - ic.y) <= tol + 0.3) {
            this.drag = {
              kind: 'renovator-inner',
              roomId: selected.id,
              orig: clone(selected),
              pointerId: ev.pointerId,
            };
            return;
          }
        } else {
          const anchor = this.anchorAt(selected, p.x, p.y, tol);
          if (anchor) {
            this.drag = {
              kind: 'renovator',
              roomId: selected.id,
              orig: clone(selected),
              anchor: anchor.anchor,
              dir: anchor.dir,
              start: { x: p.x, y: p.y },
              pointerId: ev.pointerId,
            };
            return;
          }
        }
      }

      const room = this.roomAt(p.x, p.y);
      if (room) {
        this.selectionId = room.id;
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = null;
      this.syncPanels();
      this.toast('Select a room first to make it L-shaped');
      this.render();
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'balcony') {
      if (!this.balconyModeAvailable) {
        this.toast('Balconies can only be built on floors 2F–5F.', true);
        return;
      }
      const balconyHandleTarget = this.balconies.find((item) =>
        this.balconyHandleAt(item, p.x, p.y, HIT_PX / this.view.scale),
      );
      const balcony = balconyHandleTarget || this.balconyAt(p.x, p.y);
      if (balcony) {
        this.selectionId = balcony.id;
        const handle = balconyHandleTarget
          ? this.balconyHandleAt(balcony, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'balcony-resize' : 'balcony-move',
          balconyId: balcony.id,
          orig: clone(balcony),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = null;
      this.drag = {
        kind: 'balcony',
        start: cell,
        pointerId: ev.pointerId,
      };
      this.syncPanels();
      this.render();
      return;
    }

    /* ---- select tool ---- */
    if (this.tool === 'select') {
      const mezzanineHandle = this.mezzanines.find((item) =>
        this.balconyHandleAt(item, p.x, p.y, HIT_PX / this.view.scale),
      );
      const mezzanine = mezzanineHandle || this.mezzanineAt(p.x, p.y);
      if (mezzanine) {
        this.selectionId = mezzanine.id;
        const handle = mezzanineHandle
          ? this.balconyHandleAt(mezzanine, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'mezzanine-resize' : 'mezzanine-move',
          orig: clone(mezzanine),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      const door = this.doorAt(p.x, p.y);
      if (door) {
        this.selectionId = door.id;
        const handle = this.doorHandleAt(door, p.x, p.y, HIT_PX / this.view.scale);
        this.drag = {
          kind: handle ? 'door-resize' : 'door-move',
          orig: clone(door),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
      const stair = this.stairAt(p.x, p.y);
      if (stair) {
        this.selectionId = stair.id;
        this.drag = {
          kind: 'stair-move',
          orig: clone(stair),
          start: { cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }

      const balconyHandle = this.balconies.find((balcony) =>
        this.balconyHandleAt(balcony, p.x, p.y, HIT_PX / this.view.scale),
      );
      const balcony = balconyHandle || this.balconyAt(p.x, p.y);
      if (balcony) {
        this.selectionId = balcony.id;
        const handle = balconyHandle
          ? this.balconyHandleAt(balcony, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'balcony-resize' : 'balcony-move',
          balconyId: balcony.id,
          orig: clone(balcony),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }

      const poolHandle = this.pools.find((pool) =>
        this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale),
      );
      const pool = poolHandle || this.poolAt(p.x, p.y);
      if (pool) {
        this.selectionId = pool.id;
        const handle = poolHandle
          ? this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'pool-resize' : 'pool-move',
          poolId: pool.id,
          orig: clone(pool),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }

      const patioHandle = this.patios.find((patio) =>
        this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale),
      );
      const patio = patioHandle || this.patioAt(p.x, p.y);
      if (patio) {
        this.selectionId = patio.id;
        const handle = patioHandle
          ? this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale)
          : null;
        this.drag = {
          kind: handle ? 'patio-resize' : 'patio-move',
          patioId: patio.id,
          orig: clone(patio),
          handle,
          start: { x: p.x, y: p.y, cx: cell.cx, cy: cell.cy },
          moved: false,
          pointerId: ev.pointerId,
        };
        this.syncPanels();
        this.render();
        return;
      }
    }

    const sel = this.selected;
    if (this.tool === 'edit' && sel && isL(sel)) {
      const ic = innerCornerOf(sel);
      const tol = HIT_PX / this.view.scale;
      if (Math.abs(p.x - ic.x) <= tol + 0.3 && Math.abs(p.y - ic.y) <= tol + 0.3) {
        this.drag = {
          kind: 'renovator-inner',
          roomId: sel.id,
          orig: clone(sel),
          pointerId: ev.pointerId,
        };
        return;
      }
    }
    if ((this.tool === 'edit' || this.tool === 'select') && sel) {
      const onHandle = this.handleAt(sel, p.x, p.y, HIT_PX / this.view.scale);
      if (onHandle) {
        this.drag = {
          kind: onHandle.type === 'corner' ? 'resize-corner' : 'resize-edge',
          roomId: sel.id,
          orig: clone(sel),
          handle: onHandle,
          start: { x: p.x, y: p.y },
          pointerId: ev.pointerId,
        };
        return;
      }
    }

    const room = this.roomAt(p.x, p.y);
    if (room) {
      this.selectionId = room.id;
      this.drag = {
        kind: 'move',
        roomId: room.id,
        orig: clone(room),
        start: cell,
        pointerId: ev.pointerId,
        moved: false,
      };
      this.syncPanels();
      this.render();
      return;
    }

    // empty space -> pan
    this.selectionId = null;
    this.syncPanels();
    if (this.tool === 'edit' && this.editMode === 'create') {
      this.drag = {
        kind: 'create',
        anchor: cell,
        pointerId: ev.pointerId,
      };
      this.updateCreatePreview(cell);
      this.render();
      return;
    }
    this.startPan(ev);
  }

  startPan(ev) {
    this.drag = {
      kind: 'pan',
      startTx: this.view.tx,
      startTy: this.view.ty,
      startPx: ev.clientX,
      startPy: ev.clientY,
      pointerId: ev.pointerId,
    };
    this.el.canvas.setPointerCapture?.(ev.pointerId);
    this.el.canvas.style.cursor = 'grabbing';
  }

  onPointerMove(ev) {
    const p = this.toWorld(ev);
    const cell = { cx: Math.floor(p.x), cy: Math.floor(p.y) };

    if (!this.drag) {
      const room = this.roomAt(p.x, p.y);
      const balcony = this.balconyAt(p.x, p.y);
      const mezzanine = this.mezzanineAt(p.x, p.y);
      const stair = this.stairAt(p.x, p.y);
      const door = this.doorAt(p.x, p.y);
      const patio = this.patioAt(p.x, p.y);
      const pool = this.poolAt(p.x, p.y);
      const nextHover = door ? door.id : stair ? stair.id : mezzanine ? mezzanine.id : room ? room.id : balcony ? balcony.id : pool ? pool.id : patio ? patio.id : null;
      if (this.tool === 'edit' && this.editMode === 'stairs') {
        this.updateStairPreview(cell.cx, cell.cy);
        this.render();
      } else if (this.tool === 'edit' && this.editMode === 'mezzanine') {
        this.updateMezzaninePreview(cell);
        this.render();
      } else if (nextHover !== this.hoverId) {
        this.hoverId = nextHover;
        this.render();
      }
      this.updateCursor(p);
      return;
    }

    switch (this.drag.kind) {
      case 'pan': {
        this.view.tx = this.drag.startTx + (ev.clientX - this.drag.startPx);
        this.view.ty = this.drag.startTy + (ev.clientY - this.drag.startPy);
        this.render();
        break;
      }
      case 'create': {
        this.updateCreatePreview(cell);
        this.render();
        break;
      }
      case 'balcony': {
        this.updateBalconyPreview(cell);
        this.render();
        break;
      }
      case 'patio': {
        this.updatePatioPreview(cell);
        this.render();
        break;
      }
      case 'mezzanine': {
        this.updateMezzaninePreview(cell);
        this.render();
        break;
      }
      case 'door': {
        this.updateDoorPreview(cell.cx, cell.cy);
        this.render();
        break;
      }
      case 'door-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updateDoorEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'door-resize': {
        const { orig, handle } = this.drag;
        const axisCell = orig.orientation === 'horizontal' ? cell.cx : cell.cy;
        const start = orig.orientation === 'horizontal' ? orig.x : orig.y;
        const length = handle === 'end'
          ? axisCell - start + 1
          : start + orig.length - axisCell;
        const candidate = { ...orig, length };
        if (length !== orig.length) this.drag.moved = true;
        if (handle === 'start') {
          if (orig.orientation === 'horizontal') candidate.x = axisCell;
          else candidate.y = axisCell;
        }
        this.updateDoorEditPreview(candidate);
        this.render();
        break;
      }
      case 'stair-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updateStairEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'mezzanine-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updateMezzanineEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'mezzanine-resize': {
        const { orig, handle, start } = this.drag;
        const dx = Math.round(p.x - start.x);
        const dy = Math.round(p.y - start.y);
        const candidate = { ...orig };
        if (handle === 'E') candidate.w += dx;
        if (handle === 'W') { candidate.x += dx; candidate.w -= dx; }
        if (handle === 'S') candidate.h += dy;
        if (handle === 'N') { candidate.y += dy; candidate.h -= dy; }
        if (dx || dy) this.drag.moved = true;
        this.updateMezzanineEditPreview(candidate);
        this.render();
        break;
      }
      case 'patio-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updatePatioEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'patio-resize': {
        const { orig, handle, start } = this.drag;
        const dx = Math.round(p.x - start.x);
        const dy = Math.round(p.y - start.y);
        const candidate = { ...orig };
        if (handle === 'E') candidate.w += dx;
        if (handle === 'W') { candidate.x += dx; candidate.w -= dx; }
        if (handle === 'S') candidate.h += dy;
        if (handle === 'N') { candidate.y += dy; candidate.h -= dy; }
        if (dx || dy) this.drag.moved = true;
        this.updatePatioEditPreview(candidate);
        this.render();
        break;
      }
      case 'pool': {
        this.updatePoolPreview(cell);
        this.render();
        break;
      }
      case 'pool-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updatePoolEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'pool-resize': {
        const { orig, handle, start } = this.drag;
        const dx = Math.round(p.x - start.x);
        const dy = Math.round(p.y - start.y);
        const candidate = { ...orig };
        if (handle === 'E') candidate.w += dx;
        if (handle === 'W') { candidate.x += dx; candidate.w -= dx; }
        if (handle === 'S') candidate.h += dy;
        if (handle === 'N') { candidate.y += dy; candidate.h -= dy; }
        if (dx || dy) this.drag.moved = true;
        this.updatePoolEditPreview(candidate);
        this.render();
        break;
      }
      case 'balcony-move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        this.updateBalconyEditPreview({
          ...this.drag.orig,
          x: this.drag.orig.x + dx,
          y: this.drag.orig.y + dy,
        });
        this.render();
        break;
      }
      case 'balcony-resize': {
        const { orig, handle, start } = this.drag;
        const dx = Math.round(p.x - start.x);
        const dy = Math.round(p.y - start.y);
        const candidate = { ...orig };
        if (handle === 'E') candidate.w += dx;
        if (handle === 'W') { candidate.x += dx; candidate.w -= dx; }
        if (handle === 'S') candidate.h += dy;
        if (handle === 'N') { candidate.y += dy; candidate.h -= dy; }
        if (dx || dy) this.drag.moved = true;
        this.updateBalconyEditPreview(candidate);
        this.render();
        break;
      }
      case 'move': {
        const dx = cell.cx - this.drag.start.cx;
        const dy = cell.cy - this.drag.start.cy;
        if (dx || dy) this.drag.moved = true;
        const cand = { ...this.drag.orig, x: this.drag.orig.x + dx, y: this.drag.orig.y + dy };
        this.setPreview(cand);
        this.render();
        break;
      }
      case 'resize-edge': {
        const h = this.drag.handle;
        const o = this.drag.orig;
        // Apply the pointer's snapped movement to the dragged boundary.
        let d = 0;
        if (h.edge === 'E') d = Math.round(p.x - this.drag.start.x);
        if (h.edge === 'W') d = Math.round(p.x - this.drag.start.x);
        if (h.edge === 'S') d = Math.round(p.y - this.drag.start.y);
        if (h.edge === 'N') d = Math.round(p.y - this.drag.start.y);
        const cand = resizeEdge(o, h.edge, d);
        this.setPreview(cand);
        this.render();
        break;
      }
      case 'resize-corner': {
        const h = this.drag.handle;
        const o = this.drag.orig;
        let dx = 0;
        let dy = 0;
        if (h.corner.includes('E') || h.corner.includes('W')) {
          dx = Math.round(p.x - this.drag.start.x);
        }
        if (h.corner.includes('S') || h.corner.includes('N')) {
          dy = Math.round(p.y - this.drag.start.y);
        }
        const cand = resizeCorner(o, h.corner, dx, dy);
        this.setPreview(cand);
        this.render();
        break;
      }
      case 'renovator': {
        const { orig, anchor, dir, start } = this.drag;
        let k = 0;
        if (dir === 'right') k = Math.round(p.x - start.x);
        if (dir === 'left') k = Math.round(start.x - p.x);
        if (dir === 'down') k = Math.round(p.y - start.y);
        if (dir === 'up') k = Math.round(start.y - p.y);
        k = Math.max(0, k);
        this.drag.k = k;
        if (k === 0) {
          this.preview = null;
        } else {
          const cand = renovatorExtend(orig, anchor, dir, k);
          this.setPreview(cand, 'Cannot extend the room there.');
        }
        this.render();
        break;
      }
      case 'renovator-inner': {
        const cand = setInnerCorner(this.drag.orig, cell.cx, cell.cy);
        this.setPreview(cand, 'Cannot shrink the room like that.');
        this.render();
        break;
      }
      default:
        break;
    }
  }

  onPointerUp(ev) {
    const drag = this.drag;
    this.el.canvas.style.cursor = '';
    if (!drag) return;
    this.drag = null;

    try {
      this.el.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }

    if (drag.kind === 'pan') {
      this.render();
      return;
    }

    if (drag.kind === 'door') {
      const candidate = this.preview?.door;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const created = { ...candidate, id: uid('door') };
      this.applyDoors([...this.doors, created], 'Place door');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'door-move' || drag.kind === 'door-resize') {
      const candidate = this.preview?.door;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyDoors(
        this.doors.map((door) => door.id === candidate.id ? candidate : door),
        drag.kind === 'door-move' ? 'Move door' : 'Resize door',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'stair-move') {
      const candidate = this.preview?.stair;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyStairs(
        this.stairs.map((stair) => stair.id === candidate.id ? candidate : stair),
        'Move stairs',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'mezzanine') {
      const candidate = this.preview?.mezzanine;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const created = { ...candidate, id: uid('mezz') };
      this.applyMezzanines([...this.mezzanines, created], 'Build mezzanine');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'mezzanine-move' || drag.kind === 'mezzanine-resize') {
      const candidate = this.preview?.mezzanine;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyMezzanines(
        this.mezzanines.map((item) => item.id === candidate.id ? candidate : item),
        drag.kind === 'mezzanine-move' ? 'Move mezzanine' : 'Resize mezzanine',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'balcony') {
      const candidate = this.preview?.balcony;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const created = {
        ...candidate,
        id: uid('balcony'),
        name: `Balcony ${this.balconies.length + 1}`,
      };
      this.applyBalconies([...this.balconies, created], 'Build balcony');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'patio') {
      const candidate = this.preview?.patio;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const created = {
        ...candidate,
        id: uid('patio'),
        name: `Patio ${this.patios.length + 1}`,
      };
      this.applyPatios([...this.patios, created], 'Build patio');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'patio-move' || drag.kind === 'patio-resize') {
      const candidate = this.preview?.patio;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyPatios(
        this.patios.map((patio) => patio.id === candidate.id ? candidate : patio),
        drag.kind === 'patio-move' ? 'Move patio' : 'Resize patio',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'pool') {
      const candidate = this.preview?.pool;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const created = {
        ...candidate,
        id: uid('pool'),
        name: `Pool ${this.pools.length + 1}`,
      };
      this.applyPools([...this.pools, created], 'Build pool');
      this.selectionId = created.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'pool-move' || drag.kind === 'pool-resize') {
      const candidate = this.preview?.pool;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyPools(
        this.pools.map((pool) => pool.id === candidate.id ? candidate : pool),
        drag.kind === 'pool-move' ? 'Move pool' : 'Resize pool',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'balcony-move' || drag.kind === 'balcony-resize') {
      const candidate = this.preview?.balcony;
      if (!candidate) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      if (!drag.moved) {
        this.preview = null;
        this.render();
        return;
      }
      this.applyBalconies(
        this.balconies.map((balcony) => balcony.id === candidate.id ? candidate : balcony),
        drag.kind === 'balcony-move' ? 'Move balcony' : 'Resize balcony',
      );
      this.selectionId = candidate.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    if (drag.kind === 'create') {
      const cand = this.preview?.room;
      if (!cand) {
        if (this.preview) this.toast(this.preview.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const check = validateRoom(
        cand,
        this.roomObstacles,
        lotOf(this.project),
        this.supportRooms,
        this.blockedRoomCells,
      );
      if (!check.ok) {
        this.toast(check.message, true);
        this.preview = null;
        this.render();
        return;
      }
      const room = makeRoom({
        ...cand,
        id: uid('room'),
        name: nextRoomName(this.project, this.rooms),
      });
      if (!this.applyRooms([...this.rooms, room], 'Create room')) {
        this.preview = null;
        this.syncPanels();
        this.render();
        return;
      }
      this.selectionId = room.id;
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }

    // An invalid candidate leaves preview.room as null — nothing to commit.
    const cand = this.preview?.room;
    if (!cand) {
      if (this.preview) this.toast(this.preview.message, true);
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }
    if (drag.kind === 'move' && !drag.moved) {
      this.preview = null;
      this.render();
      return;
    }
    if (!this.applyRooms(
      this.rooms.map((r) => (r.id === cand.id ? cand : r)),
      drag.kind === 'move' ? 'Move room' : drag.kind === 'renovator' || drag.kind === 'renovator-inner' ? 'Reshape room' : 'Resize room',
    )) {
      this.preview = null;
      this.syncPanels();
      this.render();
      return;
    }
    this.selectionId = cand.id;
    this.preview = null;
    this.syncPanels();
    this.render();
  }

  updateCursor(p) {
    const cv = this.el.canvas;
    if (this.tool === 'delete') {
      cv.style.cursor = this.mezzanineAt(p.x, p.y) || this.doorAt(p.x, p.y) || this.stairAt(p.x, p.y) || this.roomAt(p.x, p.y) || this.balconyAt(p.x, p.y) || this.poolAt(p.x, p.y) || this.patioAt(p.x, p.y)
        ? 'pointer'
        : 'default';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'stairs') {
      cv.style.cursor = 'crosshair';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'mezzanine') {
      const handle = this.mezzanines.find((item) =>
        this.balconyHandleAt(item, p.x, p.y, HIT_PX / this.view.scale),
      );
      cv.style.cursor = handle ? 'nwse-resize' : this.mezzanineAt(p.x, p.y) ? 'grab' : 'crosshair';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'door') {
      cv.style.cursor = this.doorAt(p.x, p.y) || this.doorWallAt(p.x, p.y) ? 'crosshair' : 'not-allowed';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'patio') {
      const handle = this.patios.find((patio) =>
        this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale),
      );
      cv.style.cursor = handle ? 'nwse-resize' : this.patioAt(p.x, p.y) ? 'grab' : 'crosshair';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'pool') {
      const handle = this.pools.find((pool) =>
        this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale),
      );
      cv.style.cursor = handle ? 'nwse-resize' : this.poolAt(p.x, p.y) ? 'grab' : 'crosshair';
      return;
    }
    if (this.tool === 'select') {
      const mezzanine = this.mezzanineAt(p.x, p.y);
      if (mezzanine) {
        const handle = this.balconyHandleAt(mezzanine, p.x, p.y, HIT_PX / this.view.scale);
        cv.style.cursor = handle ? 'nwse-resize' : 'grab';
        return;
      }
      const door = this.doorAt(p.x, p.y);
      if (door) {
        cv.style.cursor = this.doorHandleAt(door, p.x, p.y, HIT_PX / this.view.scale)
          ? 'ew-resize'
          : 'grab';
        return;
      }
      if (this.stairAt(p.x, p.y)) {
        cv.style.cursor = 'grab';
        return;
      }
      const balcony = this.balconyAt(p.x, p.y);
      if (balcony) {
        const handle = this.balconyHandleAt(balcony, p.x, p.y, HIT_PX / this.view.scale);
        cv.style.cursor = handle ? 'nwse-resize' : 'grab';
        return;
      }
      const pool = this.poolAt(p.x, p.y);
      if (pool) {
        const handle = this.poolHandleAt(pool, p.x, p.y, HIT_PX / this.view.scale);
        cv.style.cursor = handle ? 'nwse-resize' : 'grab';
        return;
      }
      const patio = this.patioAt(p.x, p.y);
      if (patio) {
        const handle = this.balconyHandleAt(patio, p.x, p.y, HIT_PX / this.view.scale);
        cv.style.cursor = handle ? 'nwse-resize' : 'grab';
        return;
      }
      const room = this.roomAt(p.x, p.y);
      if (room && room.id === this.selectionId) {
        const handle = this.handleAt(room, p.x, p.y, HIT_PX / this.view.scale);
        if (handle) {
          cv.style.cursor = handle.type === 'corner'
            ? handle.corner === 'NW' || handle.corner === 'SE' ? 'nwse-resize' : 'nesw-resize'
            : handle.edge === 'N' || handle.edge === 'S' ? 'ns-resize' : 'ew-resize';
          return;
        }
        cv.style.cursor = 'move';
        return;
      }
      if (room) {
        cv.style.cursor = 'pointer';
        return;
      }
    }
    if (this.tool === 'edit' && this.editMode === 'balcony') {
      const balconyHandle = this.balconies.find((item) =>
        this.balconyHandleAt(item, p.x, p.y, HIT_PX / this.view.scale),
      );
      const balcony = balconyHandle || this.balconyAt(p.x, p.y);
      if (balcony) {
        cv.style.cursor = balconyHandle
          || this.balconyHandleAt(balcony, p.x, p.y, HIT_PX / this.view.scale)
          ? 'nwse-resize'
          : 'grab';
      } else {
        cv.style.cursor = this.roomAt(p.x, p.y) ? 'crosshair' : 'default';
      }
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'lroom') {
      const selected = this.selected;
      if (selected) {
        const tol = HIT_PX / this.view.scale;
        if (isL(selected)) {
          const ic = innerCornerOf(selected);
          if (Math.abs(p.x - ic.x) <= tol + 0.3 && Math.abs(p.y - ic.y) <= tol + 0.3) {
            cv.style.cursor = 'grab';
            return;
          }
        } else if (this.anchorAt(selected, p.x, p.y, tol)) {
          cv.style.cursor = 'grab';
          return;
        }
      }
      cv.style.cursor = 'crosshair';
      return;
    }
    if (this.tool === 'edit' && this.editMode === 'create') {
      const selected = this.selected;
      if (selected) {
        const tol = HIT_PX / this.view.scale;
        if (isL(selected)) {
          const ic = innerCornerOf(selected);
          if (Math.abs(p.x - ic.x) <= tol + 0.3 && Math.abs(p.y - ic.y) <= tol + 0.3) {
            cv.style.cursor = 'grab';
            return;
          }
        }
        const handle = this.handleAt(selected, p.x, p.y, tol);
        if (handle) {
          cv.style.cursor =
            handle.type === 'corner'
              ? handle.corner === 'NW' || handle.corner === 'SE'
                ? 'nwse-resize'
                : 'nesw-resize'
              : handle.edge === 'N' || handle.edge === 'S'
                ? 'ns-resize'
                : 'ew-resize';
          return;
        }
        if (this.roomAt(p.x, p.y)) {
          cv.style.cursor = 'move';
          return;
        }
      }
      cv.style.cursor = 'crosshair';
      return;
    }
    if (this.tool === 'select') {
      cv.style.cursor = this.roomAt(p.x, p.y) ? 'pointer' : 'grab';
      return;
    }
    const sel = this.selected;
    if (sel && isL(sel)) {
      const ic = innerCornerOf(sel);
      const tol = HIT_PX / this.view.scale;
      if (Math.abs(p.x - ic.x) <= tol + 0.3 && Math.abs(p.y - ic.y) <= tol + 0.3) {
        cv.style.cursor = 'grab';
        return;
      }
    }
    if (sel) {
      const h = this.handleAt(sel, p.x, p.y, HIT_PX / this.view.scale);
      if (h) {
        cv.style.cursor =
          h.type === 'corner'
            ? h.corner === 'NW' || h.corner === 'SE'
              ? 'nwse-resize'
              : 'nesw-resize'
            : h.edge === 'N' || h.edge === 'S'
              ? 'ns-resize'
              : 'ew-resize';
        return;
      }
    }
    cv.style.cursor = this.roomAt(p.x, p.y) ? 'move' : 'grab';
  }

  /* ---------------------------------------------------------------- */
  /* Handles                                                          */
  /* ---------------------------------------------------------------- */

  rectHandles(room) {
    const { x, y, w, h } = room;
    const hx = x + w / 2;
    const hy = y + h / 2;
    const all = [
      { type: 'corner', corner: 'NW', x, y },
      { type: 'corner', corner: 'NE', x: x + w, y },
      { type: 'corner', corner: 'SW', x, y: y + h },
      { type: 'corner', corner: 'SE', x: x + w, y: y + h },
      { type: 'edge', edge: 'N', x: hx, y },
      { type: 'edge', edge: 'S', x: hx, y: y + h },
      { type: 'edge', edge: 'W', x, y: hy },
      { type: 'edge', edge: 'E', x: x + w, y: hy },
    ];
    if (!isL(room)) return all;
    // L rooms: hide the handles that sit on (or inside) the missing notch.
    // The extension itself is driven by the inner-corner diamond.
    return all.filter((hd) => {
      if (hd.type === 'corner') return hd.corner !== room.lshape;
      return !room.lshape.includes(hd.edge);
    });
  }

  handleAt(room, wx, wy, tol) {
    const list = this.rectHandles(room);
    let best = null;
    let bestD = Infinity;
    for (const hd of list) {
      const d = Math.max(Math.abs(hd.x - wx), Math.abs(hd.y - wy));
      if (d <= tol && d < bestD) {
        best = hd;
        bestD = d;
      }
    }
    return best;
  }

  /** Yellow renovator anchors: 2 per corner, only for rectangular rooms. */
  anchorsOf(room) {
    if (isL(room)) return [];
    const { x, y, w, h } = room;
    const list = [];
    const corners = [
      ['NW', x, y, ['left', 'up']],
      ['NE', x + w, y, ['right', 'up']],
      ['SW', x, y + h, ['left', 'down']],
      ['SE', x + w, y + h, ['right', 'down']],
    ];
    for (const [corner, cx, cy, dirs] of corners) {
      for (const dir of dirs) {
        // FreePlay draws a yellow bracket around each extendable corner: one
        // arrow on the horizontal wall, one on the vertical wall.
        const inset = 0.55; // pull the dot in from the corner along the wall
        const out = 0.4; // and sit just outside the wall
        let ax = cx;
        let ay = cy;
        if (dir === 'right' || dir === 'left') {
          ay = cy + (cy === room.y ? out : -out); // on the top or bottom wall
          ax = cx + (dir === 'right' ? inset : -inset);
        } else {
          ax = cx + (cx === room.x ? out : -out); // on the left or right wall
          ay = cy + (dir === 'down' ? inset : -inset);
        }
        list.push({ anchor: corner, dir, x: ax, y: ay });
      }
    }
    return list;
  }

  anchorAt(room, wx, wy, tol) {
    const list = this.anchorsOf(room);
    let best = null;
    let bestD = Infinity;
    for (const a of list) {
      const d = Math.hypot(a.x - wx, a.y - wy);
      if (d <= tol + 0.35 && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Preview / state mutation                                         */
  /* ---------------------------------------------------------------- */

  setPreview(room, fallbackMsg) {
    if (!room) {
      this.preview = { room: null, ok: false, message: fallbackMsg || 'Not allowed here.' };
      return;
    }
    const norm = normalizeShape(room);
    const check = validateRoom(
      norm,
      this.roomObstacles,
      lotOf(this.project),
      this.supportRooms,
      this.blockedRoomCells,
    );
    this.preview = {
      room: check.ok ? norm : null,
      candidate: norm,
      ok: check.ok,
      message: check.message || fallbackMsg || 'Not allowed here.',
    };
  }

  updateCreatePreview(cell) {
    const a = this.drag.anchor;
    const x = Math.min(a.cx, cell.cx);
    const y = Math.min(a.cy, cell.cy);
    const w = Math.abs(cell.cx - a.cx) + 1;
    const h = Math.abs(cell.cy - a.cy) + 1;
    this.setPreview({ id: '__new__', name: 'New room', x, y, w, h, lshape: null, armW: 0, armH: 0 }, 'Not allowed here.');
  }

  updateBalconyPreview(cell) {
    const { start } = this.drag;
    const x = Math.min(start.cx, cell.cx);
    const y = Math.min(start.cy, cell.cy);
    const candidate = {
      id: '__new_balcony__',
      name: 'Balcony',
      side: null,
      roomId: null,
      x,
      y,
      w: Math.abs(cell.cx - start.cx) + 1,
      h: Math.abs(cell.cy - start.cy) + 1,
    };
    const check = validateBalcony(
      candidate,
      this.rooms,
      this.balconies,
      lotOf(this.project),
      this.supportRooms || [],
    );
    this.preview = {
      balcony: check.ok ? candidate : null,
      candidate,
      type: 'balcony',
      ok: check.ok,
      message: check.message || 'Balcony cannot be built there.',
    };
  }

  updateBalconyEditPreview(candidate) {
    const check = validateBalcony(
      candidate,
      this.rooms,
      this.balconies.filter((balcony) => balcony.id !== candidate.id),
      lotOf(this.project),
      this.supportRooms || [],
    );
    this.preview = {
      balcony: check.ok ? candidate : null,
      candidate,
      type: 'balcony',
      ok: check.ok,
      message: check.message || 'Balcony cannot be changed that way.',
    };
  }

  updatePatioPreview(cell) {
    const { start } = this.drag;
    const candidate = {
      id: '__new_patio__',
      name: 'Patio',
      x: Math.min(start.cx, cell.cx),
      y: Math.min(start.cy, cell.cy),
      w: Math.abs(cell.cx - start.cx) + 1,
      h: Math.abs(cell.cy - start.cy) + 1,
    };
    const check = validatePatio(
      candidate,
      roomsOnFloor(this.project, '1'),
      this.pools,
      lotOf(this.project),
    );
    this.preview = {
      patio: check.ok ? candidate : null,
      candidate,
      type: 'patio',
      ok: check.ok,
      message: check.message || 'Patio cannot be built there.',
    };
  }

  updatePatioEditPreview(candidate) {
    const check = validatePatio(
      candidate,
      roomsOnFloor(this.project, '1'),
      this.pools,
      lotOf(this.project),
    );
    this.preview = {
      patio: check.ok ? candidate : null,
      candidate,
      type: 'patio',
      ok: check.ok,
      message: check.message || 'Patio cannot be changed that way.',
    };
  }

  updateDoorPreview(cx, cy) {
    const start = this.drag.start;
    const axisStart = start.orientation === 'horizontal' ? start.x : start.y;
    const axisEnd = start.orientation === 'horizontal' ? cx : cy;
    const door = {
      id: '__new_door__',
      orientation: start.orientation,
      x: start.orientation === 'horizontal' ? Math.min(axisStart, axisEnd) : start.x,
      y: start.orientation === 'vertical' ? Math.min(axisStart, axisEnd) : start.y,
      length: Math.abs(axisEnd - axisStart) + 1,
    };
    this.setDoorPreview(door, false);
  }

  updateDoorEditPreview(candidate) {
    this.setDoorPreview(candidate, true);
  }

  setDoorPreview(candidate, editing) {
    const check = validateDoor(
      candidate,
      this.rooms,
      this.doors.filter((door) => editing ? door.id !== candidate.id : true),
      { interiorOnly: this.floor === 'basement' },
    );
    this.preview = {
      door: check.ok ? candidate : null,
      candidate,
      type: 'door',
      ok: check.ok,
      message: check.message || (editing ? 'Door cannot be changed that way.' : 'Door cannot be placed there.'),
    };
  }

  updateStairPreview(x, y) {
    const candidate = this.stairCandidateAt(x, y);
    this.setStairPreview(candidate);
  }

  updateStairEditPreview(candidate) {
    this.setStairPreview(candidate, true);
  }

  setStairPreview(candidate, editing = false) {
    const check = this.validateStairCandidate(candidate, editing ? candidate.id : null);
    this.preview = {
      stair: check.ok ? candidate : null,
      candidate,
      type: 'stair',
      ok: check.ok,
      message: check.message || 'Stairs cannot be placed there.',
    };
  }

  updateMezzaninePreview(cell) {
    const start = this.drag?.start || { cx: cell.cx, cy: cell.cy };
    const candidate = this.mezzanineCandidateAt(
      Math.min(start.cx, cell.cx),
      Math.min(start.cy, cell.cy),
      Math.abs(cell.cx - start.cx) + 1,
      Math.abs(cell.cy - start.cy) + 1,
    );
    this.setMezzaninePreview(candidate);
  }

  updateMezzanineEditPreview(candidate) {
    this.setMezzaninePreview(candidate, true);
  }

  setMezzaninePreview(candidate, editing = false) {
    const check = this.validateMezzanineCandidate(candidate, editing ? candidate.id : null);
    this.preview = {
      mezzanine: check.ok ? candidate : null,
      candidate,
      type: 'mezzanine',
      ok: check.ok,
      message: check.message || 'Mezzanine cannot be placed there.',
    };
  }

  updatePoolPreview(cell) {
    const { start } = this.drag;
    const candidate = {
      id: '__new_pool__',
      name: 'Pool',
      x: Math.min(start.cx, cell.cx),
      y: Math.min(start.cy, cell.cy),
      w: Math.abs(cell.cx - start.cx) + 1,
      h: Math.abs(cell.cy - start.cy) + 1,
    };
    const check = validatePool(
      candidate,
      [...roomsOnFloor(this.project, '1'), ...roomsOnFloor(this.project, 'basement'), ...this.patios],
      this.pools,
      lotOf(this.project),
    );
    this.preview = {
      pool: check.ok ? candidate : null,
      candidate,
      type: 'pool',
      ok: check.ok,
      message: check.message || 'Pool cannot be built there.',
    };
  }

  updatePoolEditPreview(candidate) {
    const check = validatePool(
      candidate,
      [...roomsOnFloor(this.project, '1'), ...roomsOnFloor(this.project, 'basement'), ...this.patios],
      this.pools.filter((pool) => pool.id !== candidate.id),
      lotOf(this.project),
    );
    this.preview = {
      pool: check.ok ? candidate : null,
      candidate,
      type: 'pool',
      ok: check.ok,
      message: check.message || 'Pool cannot be changed that way.',
    };
  }

  applyRooms(rooms, label, { allowUnsupportedAbove = false } = {}) {
    if (this.doors.some((door) => !validateDoor(
      door,
      rooms,
      this.doors,
      { interiorOnly: this.floor === 'basement' },
    ).ok)) {
      this.toast('Cannot change this floor because it would leave a door without a room wall. Move or delete the door first.', true);
      return false;
    }
    const affectedStairs = this.stairs.filter((stair) =>
      stair.lowerFloor === this.floor || floorAbove(stair.lowerFloor) === this.floor,
    );
    if (affectedStairs.some((stair) => !this.validateStairCandidate(
      stair,
      stair.id,
      { floor: this.floor, rooms },
    ).ok)) {
      this.toast('Cannot change this floor because it would invalidate connected stairs or their opening.', true);
      return false;
    }
    const upperMezzanineFloor = this.floor === 'basement'
      ? '1'
      : String(Number(this.floor) + 1);
    const upperMezzanines = mezzaninesOnFloor(this.project, upperMezzanineFloor);
    if (upperMezzanines.some((mezzanine) => !validateMezzanine(
      mezzanine,
      rooms,
      upperMezzanines,
      lotOf(this.project),
      roomsOnFloor(this.project, upperMezzanineFloor),
    ).ok)) {
      this.toast('Cannot change this floor because it would leave a mezzanine spanning or outside a room.', true);
      return false;
    }
    const floorMezzanines = mezzaninesOnFloor(this.project, this.floor);
    if (floorMezzanines.some((mezzanine) => !validateMezzanine(
      mezzanine,
      roomsOnFloor(this.project, this.lowerMezzanineFloor),
      floorMezzanines,
      lotOf(this.project),
      rooms,
    ).ok)) {
      this.toast('Cannot change this floor because it would leave a mezzanine spanning or outside a room.', true);
      return false;
    }
    if (this.floor === '1') {
      for (const floor of ['2', '3', '4', '5']) {
        const floorRooms = roomsOnFloor(this.project, floor);
        const floorBalconies = balconiesOnFloor(this.project, floor);
        if (floorBalconies.some((balcony) => !validateBalcony(
          balcony,
          floorRooms,
          floorBalconies.filter((other) => other.id !== balcony.id),
          lotOf(this.project),
          rooms,
        ).ok)) {
          this.toast('Cannot change 1F because it would leave a balcony outside the supported area.', true);
          return false;
        }
      }
    }
    if (!allowUnsupportedAbove && this.floor === '1') {
      const removesExistingSupport = ['2', '3', '4', '5'].some((floor) => {
        const currentSupport = roomsOnFloor(this.project, '1');
        const nextSupport = rooms;
        return roomsOnFloor(this.project, floor).some((room) =>
          roomSupported(room, currentSupport) && !roomSupported(room, nextSupport),
        );
      });
      if (removesExistingSupport) {
        this.toast('Cannot change this floor because it would leave rooms above unsupported.', true);
        return false;
      }
    }
    this.project = touch(withFloorRooms(this.project, this.floor, rooms));
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyBalconies(balconies, label) {
    this.project = touch(withFloorBalconies(this.project, this.floor, balconies));
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyPools(pools, label) {
    this.project = touch({ ...this.project, pools });
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyPatios(patios, label) {
    this.project = touch({ ...this.project, patios });
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyDoors(doors, label) {
    this.project = touch({
      ...this.project,
      doors: { ...this.project.doors, [this.floor]: doors },
    });
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyStairs(stairs, label) {
    this.project = touch({ ...this.project, stairs });
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  applyMezzanines(mezzanines, label) {
    this.project = touch({
      ...this.project,
      mezzanines: { ...this.project.mezzanines, [this.floor]: mezzanines },
    });
    this.pushHistory(label);
    this.markDirty();
    this.syncPanels();
    return true;
  }

  pushHistory(label) {
    const snap = {
      floor: this.floor,
      floors: clone(this.project.floors),
      balconies: clone(this.project.balconies || emptyBalconies()),
      pools: clone(this.project.pools || []),
      patios: clone(this.project.patios || []),
      doors: clone(this.project.doors || emptyDoors()),
      stairs: clone(this.project.stairs || []),
      mezzanines: clone(this.project.mezzanines || emptyMezzanines()),
      selection: this.selectionId,
      label,
    };
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(snap);
    if (this.history.length > 80) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  undo() {
    if (this.hIndex <= 0) return;
    this.hIndex -= 1;
    if (!this.restore(this.history[this.hIndex])) this.hIndex += 1;
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex += 1;
    if (!this.restore(this.history[this.hIndex])) this.hIndex -= 1;
  }

  restore(snap) {
    this.floor = snap.floor || '1';
    const floors = clone(snap.floors);
    this.project = touch({
      ...this.project,
      floors,
      balconies: clone(snap.balconies || emptyBalconies()),
      pools: clone(snap.pools || []),
      patios: clone(snap.patios || []),
      doors: clone(snap.doors || emptyDoors()),
      stairs: clone(snap.stairs || []),
      mezzanines: clone(snap.mezzanines || emptyMezzanines()),
      rooms: floors['1'],
    });
    this.setFloorUi();
    this.selectionId = this.rooms.some((room) => room.id === snap.selection)
      || this.balconies.some((balcony) => balcony.id === snap.selection)
      || this.pools.some((pool) => pool.id === snap.selection)
      || this.patios.some((patio) => patio.id === snap.selection)
      || this.doors.some((door) => door.id === snap.selection)
      || (this.project.stairs || []).some((stair) => stair.id === snap.selection)
      || Object.values(this.project.mezzanines || {}).flat()
        .some((item) => item.id === snap.selection)
      ? snap.selection
      : null;
    this.preview = null;
    this.drag = null;
    this.markDirty();
    this.syncPanels();
    this.render();
    return true;
  }

  deleteRoom(id) {
    const room = this.rooms.find((r) => r.id === id);
    if (!room) return;
    if (!this.applyRooms(
      this.rooms.filter((r) => r.id !== id),
      'Delete room',
      { allowUnsupportedAbove: Number(this.floor) >= 2 },
    )) return;
    if (this.selectionId === id) this.selectionId = null;
    this.toast(`Deleted “${room.name}”`);
    this.syncPanels();
    this.render();
  }

  deleteBalcony(id) {
    const balcony = this.balconies.find((item) => item.id === id);
    if (!balcony) return;
    this.applyBalconies(
      this.balconies.filter((item) => item.id !== id),
      'Delete balcony',
    );
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted balcony');
    this.syncPanels();
    this.render();
  }

  deletePool(id) {
    const pool = this.pools.find((item) => item.id === id);
    if (!pool) return;
    this.applyPools(this.pools.filter((item) => item.id !== id), 'Delete pool');
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted pool');
    this.syncPanels();
    this.render();
  }

  deletePatio(id) {
    const patio = this.patios.find((item) => item.id === id);
    if (!patio) return;
    this.applyPatios(this.patios.filter((item) => item.id !== id), 'Delete patio');
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted patio');
    this.syncPanels();
    this.render();
  }

  deleteDoor(id) {
    if (!this.doors.some((door) => door.id === id)) return;
    this.applyDoors(this.doors.filter((door) => door.id !== id), 'Delete door');
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted door');
    this.syncPanels();
    this.render();
  }

  updateStair(stair, patch) {
    const candidate = { ...stair, ...patch };
    const check = this.validateStairCandidate(candidate, stair.id);
    if (!check.ok) {
      this.toast(check.message, true);
      this.syncPanels();
      return;
    }
    this.applyStairs(
      this.stairs.map((item) => item.id === stair.id ? candidate : item),
      patch.x !== undefined || patch.y !== undefined ? 'Move stairs' : 'Edit stairs',
    );
    this.selectionId = candidate.id;
    this.render();
  }

  deleteStair(id) {
    if (!this.stairs.some((stair) => stair.id === id)) return;
    this.applyStairs(this.stairs.filter((stair) => stair.id !== id), 'Delete stairs');
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted stairs');
    this.syncPanels();
    this.render();
  }

  deleteMezzanine(id) {
    if (!this.mezzanines.some((item) => item.id === id)) return;
    this.applyMezzanines(this.mezzanines.filter((item) => item.id !== id), 'Delete mezzanine');
    if (this.selectionId === id) this.selectionId = null;
    this.toast('Deleted mezzanine');
    this.syncPanels();
    this.render();
  }

  /** Update the selected room from the properties panel. */
  updateSelected(patch) {
    const sel = this.selected;
    if (!sel) return;
    let cand = normalizeShape({ ...sel, ...patch });
    // Keep the 1x1 ban and neighbours safe: reject silently with a toast.
    const check = validateRoom(
      cand,
      this.roomObstacles,
      lotOf(this.project),
      this.supportRooms,
      this.blockedRoomCells,
    );
    if (!check.ok) {
      this.toast(check.message, true);
      this.syncPanels();
      return;
    }
    if (patch.w === 1 && patch.h === 1) {
      this.toast('A 1 × 1 room is not allowed.', true);
      this.syncPanels();
      return;
    }
    if (!this.applyRooms(
      this.rooms.map((r) => (r.id === sel.id ? cand : r)),
      'Edit room',
    )) return;
    this.syncPanels();
    this.render();
  }

  restoreRectangle() {
    const sel = this.selected;
    if (!sel || !isL(sel)) return;
    const cand = toRectangle(sel);
    if (!this.applyRooms(
      this.rooms.map((r) => (r.id === sel.id ? cand : r)),
      'Restore rectangle',
    )) return;
    this.syncPanels();
    this.render();
    this.toast('Room restored to a rectangle');
  }

  /* ---------------------------------------------------------------- */
  /* Saving                                                           */
  /* ---------------------------------------------------------------- */

  markDirty() {
    this.hooks.onStatus('dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 600);
  }

  flushSave(explicit = false) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.hooks.onChange(this.project);
    this.hooks.onStatus('saved');
    if (explicit) this.el.savetext.textContent = 'Saved';
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                         */
  /* ---------------------------------------------------------------- */

  onKeyDown(ev) {
    const tag = (ev.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea';
    if (ev.key === 'Escape' && this.floorDeletePrompt) {
      this.closeFloorDeletePrompt();
      ev.preventDefault();
      return;
    }
    if (ev.code === 'Space' && !typing) {
      this.spaceDown = true;
      ev.preventDefault();
    }
    if (typing) {
      if (ev.key === 'Escape') ev.target.blur();
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.redo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      this.flushSave(true);
      this.toast('Project saved locally');
      return;
    }
    if (mod) return;

    switch (ev.key) {
      case 'v':
      case 'V':
        this.setTool('select');
        break;
      case 'e':
      case 'E':
        this.setTool('edit');
        break;
      case 'c':
      case 'C':
        if (this.tool !== 'edit') {
          this.setTool('edit');
        } else {
          this.cycleEditMode();
        }
        break;
      case 'd':
      case 'D':
        this.setTool('delete');
        break;
      case 'f':
      case 'F':
        this.fit();
        break;
      case '+':
      case '=':
        this.zoomAt(1.2);
        break;
      case '-':
      case '_':
        this.zoomAt(1 / 1.2);
        break;
      case 'Delete':
      case 'Backspace':
        if (this.tool === 'delete' && this.selectionId) {
          if (this.selectedMezzanine) this.deleteMezzanine(this.selectionId);
          else if (this.selectedStair) this.deleteStair(this.selectionId);
          else if (this.selectedDoor) this.deleteDoor(this.selectionId);
          else if (this.selectedPool) this.deletePool(this.selectionId);
          else if (this.selectedPatio) this.deletePatio(this.selectionId);
          else if (this.selectedBalcony) this.deleteBalcony(this.selectionId);
          else this.deleteRoom(this.selectionId);
        }
        break;
      case 'Escape':
        if (this.drag && this.drag.kind !== 'pan') {
          this.drag = null;
          this.preview = null;
          this.render();
        } else {
          this.selectionId = null;
          this.syncPanels();
          this.render();
        }
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Panels                                                           */
  /* ---------------------------------------------------------------- */

  syncPanels() {
    this.syncToolUi();
    const sel = this.selected;
    const balcony = this.selectedBalcony;
    const pool = this.selectedPool;
    const door = this.selectedDoor;
    const stair = this.selectedStair;
    const mezzanine = this.selectedMezzanine;
    const p = this.el.props;
    const lot = lotOf(this.project);

    if (mezzanine) {
      p.innerHTML = `
        <div class="props-head">
          <h2>Mezzanine Properties</h2>
          <span class="shape-chip">Platform</span>
        </div>
        <div class="props-body">
          <ul class="facts">
            <li><span>Dimensions</span><b>${mezzanine.w} × ${mezzanine.h}</b></li>
            <li><span>Position</span><b>${mezzanine.x}, ${mezzanine.y}</b></li>
            <li><span>Supported by</span><b>${this.mezzanineFloorLabel(this.lowerMezzanineFloor)} room</b></li>
          </ul>
          <p class="hint">The platform must stay inside one room on this floor and the floor below. Minimum size is 1 × 2 cells. Drag to move it or use an edge handle to resize it.</p>
          ${this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del-mezzanine">Delete Mezzanine</button>' : ''}
        </div>`;
      p.querySelector('#f-del-mezzanine')?.addEventListener('click', () => this.deleteMezzanine(mezzanine.id));
      return;
    }

    if (this.tool === 'edit' && this.editMode === 'mezzanine') {
      p.innerHTML = `
        <div class="props-head">
          <h2>Mezzanine</h2>
          <span class="shape-chip">Build mode</span>
        </div>
        <div class="props-body">
          <p class="hint">Drag to place a platform at least 1 × 2 cells. It must fit inside one room on both ${this.mezzanineFloorLabel(this.floor)} and ${this.mezzanineFloorLabel(this.lowerMezzanineFloor)}.</p>
        </div>`;
      return;
    }

    if (stair || this.tool === 'edit' && this.editMode === 'stairs') {
      const type = stair?.type || this.stairType;
      const rotated = stair?.rotated ?? this.stairRotated;
      const size = stairSize({ type, rotated });
      const lowerFloor = stair?.lowerFloor || this.floor;
      const upperFloor = floorAbove(lowerFloor);
      p.innerHTML = `
        <div class="props-head">
          <h2>Stairs</h2>
          <span class="shape-chip">${stair ? 'Placed' : 'Build mode'}</span>
        </div>
        <div class="props-body">
          <label class="field">
            <span>Type</span>
            <select id="f-stair-type" ${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'stairs' ? '' : 'disabled'}>
              ${Object.values(STAIR_TYPES).map((item) =>
                `<option value="${item.id}" ${item.id === type ? 'selected' : ''}>${item.name}</option>`,
              ).join('')}
            </select>
          </label>
          <button class="ghost-btn wide" id="f-stair-rotate" type="button" ${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'stairs' ? '' : 'disabled'}>
            Rotate · ${size.h >= size.w ? 'Vertical' : 'Horizontal'}
          </button>
          <ul class="facts">
            <li><span>Footprint</span><b>${size.w} × ${size.h}</b></li>
            <li><span>Connects</span><b>${lowerFloor === 'basement' ? 'Basement' : `${lowerFloor}F`} → ${upperFloor === 'basement' ? 'Basement' : `${upperFloor}F`}</b></li>
            ${stair ? `<li><span>Position</span><b>${stair.x}, ${stair.y}</b></li>` : ''}
          </ul>
          <p class="hint">${stair
            ? 'Drag the stairs to move them. Both floors need a room under the full footprint and an upper-floor exit in the direction shown.'
            : 'Click to place. Both floors need a room covering the footprint, with a matching upper-floor exit in the direction shown.'}</p>
          ${stair && this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del-stair">Delete Stairs</button>' : ''}
        </div>`;
      p.querySelector('#f-stair-type').addEventListener('change', (ev) => {
        if (stair) this.updateStair(stair, { type: ev.target.value });
        else {
          this.stairType = ev.target.value;
          this.preview = null;
          this.render();
          this.syncPanels();
        }
      });
      p.querySelector('#f-stair-rotate').addEventListener('click', () => {
        if (stair) this.updateStair(stair, { rotated: !stair.rotated });
        else {
          this.stairRotated = !this.stairRotated;
          this.preview = null;
          this.render();
          this.syncPanels();
        }
      });
      p.querySelector('#f-del-stair')?.addEventListener('click', () => this.deleteStair(stair.id));
      return;
    }

    if (door) {
      p.innerHTML = `
        <div class="props-head">
          <h2>Door Properties</h2>
          <span class="shape-chip">Door</span>
        </div>
        <div class="props-body">
          <label class="field">
            <span>Width (1–4 cells)</span>
            <input type="number" id="f-door-length" value="${door.length}" min="1" max="4" step="1" ${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'door' ? '' : 'disabled'}>
          </label>
          <ul class="facts">
            <li><span>Wall</span><b>${door.orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}</b></li>
            <li><span>Position</span><b>${door.x}, ${door.y}</b></li>
          </ul>
          <p class="hint">${this.tool === 'select'
            ? 'Drag the door to move it, or change its width here.'
            : this.tool === 'edit' && this.editMode === 'door'
              ? 'Drag the door to move it, or use Delete to remove it.'
              : 'Use Select to move or resize this door.'}</p>
          ${this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del-door">Delete Door</button>' : ''}
        </div>`;
      p.querySelector('#f-door-length').addEventListener('change', (ev) => {
        const length = Math.round(Number(ev.target.value));
        if (!Number.isFinite(length)) {
          this.syncPanels();
          return;
        }
        const candidate = { ...door, length: clamp(length, 1, 4) };
        const check = validateDoor(
          candidate,
          this.rooms,
          this.doors.filter((item) => item.id !== door.id),
          { interiorOnly: this.floor === 'basement' },
        );
        if (!check.ok) {
          this.toast(check.message, true);
          this.syncPanels();
          return;
        }
        this.applyDoors(
          this.doors.map((item) => item.id === door.id ? candidate : item),
          'Resize door',
        );
        this.render();
      });
      p.querySelector('#f-del-door')?.addEventListener('click', () => this.deleteDoor(door.id));
      return;
    }

    if (pool) {
      const outer = poolOuterRect(pool);
      p.innerHTML = `
        <div class="props-head">
          <h2>Pool Properties</h2>
          <span class="shape-chip">Pool</span>
        </div>
        <div class="props-body">
          <ul class="facts">
            <li><span>Core</span><b>${pool.w} × ${pool.h}</b></li>
            <li><span>Outer ring</span><b>${outer.w} × ${outer.h}</b></li>
            <li><span>Position</span><b>${pool.x}, ${pool.y}</b></li>
          </ul>
          <p class="hint">${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'pool'
            ? 'Drag the pool to move it. Drag a core edge handle to resize it; the outer ring stays 1 cell wide.'
            : 'Pool editing is disabled. Choose Edit, then the pool button to modify it.'}</p>
          ${this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del-pool">Delete Pool</button>' : ''}
        </div>`;
      p.querySelector('#f-del-pool')?.addEventListener('click', () => this.deletePool(pool.id));
      return;
    }

    if (balcony) {
      p.innerHTML = `
        <div class="props-head">
          <h2>Balcony Properties</h2>
          <span class="shape-chip">Balcony</span>
        </div>
        <div class="props-body">
          <ul class="facts">
            <li><span>Dimensions</span><b>${balcony.w} × ${balcony.h}</b></li>
            <li><span>Position</span><b>${balcony.x}, ${balcony.y}</b></li>
          </ul>
          <p class="hint">${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'balcony'
            ? 'Drag the balcony to move it. Drag any outer handle to change its size.'
            : 'Balcony editing is disabled. Choose Edit, then the balcony button to modify it.'}</p>
        </div>`;
      return;
    }

    const patio = this.selectedPatio;
    if (patio) {
      p.innerHTML = `
        <div class="props-head">
          <h2>Patio Properties</h2>
          <span class="shape-chip">Patio</span>
        </div>
        <div class="props-body">
          <ul class="facts">
            <li><span>Dimensions</span><b>${patio.w} × ${patio.h}</b></li>
            <li><span>Position</span><b>${patio.x}, ${patio.y}</b></li>
          </ul>
          <p class="hint">${this.tool === 'select' || this.tool === 'edit' && this.editMode === 'patio'
            ? 'Drag the patio to move it. Drag any outer handle to change its size.'
            : 'Patio editing is disabled. Choose Edit, then the patio button to modify it.'}</p>
          ${this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del-patio">Delete Patio</button>' : ''}
        </div>`;
      p.querySelector('#f-del-patio')?.addEventListener('click', () => this.deletePatio(patio.id));
      return;
    }

    if (!sel) {
      const n = this.rooms.length;
      p.innerHTML = `
        <div class="props-head"><h2>Room Properties</h2></div>
        <div class="props-empty">
          <div class="props-empty-ico">${icon('select')}</div>
          <p><strong>No room selected</strong></p>
          <p class="muted">Select an object to inspect it. Use Select to move or resize objects, or Edit to create and modify them.</p>
          <ul class="facts">
            <li><span>Rooms</span><b>${n}</b></li>
            <li><span>Lot</span><b>${lot.w} × ${lot.h}</b></li>
            <li><span>Grid cells used</span><b>${this.rooms.reduce((s, r) => s + areaOf(r), 0)}</b></li>
          </ul>
        </div>`;
      return;
    }

    const isLshaped = isL(sel);
    p.innerHTML = `
      <div class="props-head">
        <h2>Room Properties</h2>
        <span class="shape-chip ${isLshaped ? 'l' : ''}">${isLshaped ? 'L-Shape' : 'Rectangle'}</span>
      </div>
      <div class="props-body">
        <label class="field">
          <span>Name</span>
          <input type="text" id="f-name" value="${escapeAttr(sel.name)}" maxlength="40" />
        </label>
        <div class="field-row">
          <label class="field"><span>Width</span><input type="number" id="f-w" value="${sel.w}" min="1" max="${lot.w}" step="1"></label>
          <label class="field"><span>Height</span><input type="number" id="f-h" value="${sel.h}" min="1" max="${lot.h}" step="1"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Position X</span><input type="number" id="f-x" value="${sel.x}" min="0" max="${lot.w - sel.w}" step="1"></label>
          <label class="field"><span>Position Y</span><input type="number" id="f-y" value="${sel.y}" min="0" max="${lot.h - sel.h}" step="1"></label>
        </div>

        ${
          isLshaped
            ? `<div class="l-block">
                 <div class="l-block-head">L extension</div>
                 <div class="field-row">
                   <label class="field"><span>Arm W</span><input type="number" id="f-armw" value="${sel.armW}" min="0" max="${sel.w - 1}" step="1"></label>
                   <label class="field"><span>Arm H</span><input type="number" id="f-armh" value="${sel.armH}" min="0" max="${sel.h - 1}" step="1"></label>
                 </div>
                 <p class="hint">Notch at <b>${sel.lshape}</b>. Drag the yellow diamond on the canvas, or set either arm to 0 to restore a rectangle.</p>
                 <button class="ghost-btn wide" id="f-rect">Restore Rectangle</button>
               </div>`
            : `<p class="hint">${this.tool === 'edit' || this.tool === 'select' ? 'Drag the room to move it or use an edge or corner handle to resize it. Switch to L-Shape mode to reshape it.' : 'Room editing is disabled. Choose Select or Edit to modify this room.'}</p>`
        }

        <ul class="facts">
          <li><span>Footprint</span><b>${sel.w} × ${sel.h}</b></li>
          <li><span>Floor area</span><b>${areaOf(sel)} cells</b></li>
          <li><span>Minimum rule</span><b>${sel.w === 1 && sel.h === 1 ? 'ILLEGAL' : 'OK (not 1 × 1)'}</b></li>
        </ul>
        ${this.tool === 'edit' ? '<button class="danger-btn wide" id="f-del">Delete Room</button>' : ''}
      </div>`;

    const commit = (patch) => this.updateSelected(patch);
    if (this.tool !== 'edit' && this.tool !== 'select') {
      for (const input of p.querySelectorAll('input, #f-rect')) input.disabled = true;
      return;
    }
    p.querySelector('#f-name').addEventListener('change', (ev) => {
      this.applyRooms(
        this.rooms.map((r) =>
          r.id === sel.id ? { ...r, name: ev.target.value.slice(0, 40) || 'Room' } : r,
        ),
        'Rename room',
      );
      this.render();
    });
    for (const key of ['w', 'h', 'x', 'y']) {
      p.querySelector(`#f-${key}`).addEventListener('change', (ev) => {
        let v = Math.round(Number(ev.target.value));
        if (!Number.isFinite(v)) {
          this.syncPanels();
          return;
        }
        if (key === 'w' || key === 'h') {
          const limit = key === 'w' ? lot.w - sel.x : lot.h - sel.y;
          v = clamp(v, 1, Math.max(1, limit));
          const next = { ...sel, [key]: Math.max(MIN_ROOM[key], v) };
          if (next.w === 1 && next.h === 1) {
            this.toast('A 1 × 1 room is not allowed. Minimum is 1 × 2.', true);
            this.syncPanels();
            return;
          }
          commit({ [key]: Math.max(1, v) });
        } else {
          commit({ [key]: Math.max(0, v) });
        }
      });
    }
    if (isLshaped) {
      p.querySelector('#f-armw').addEventListener('change', (ev) =>
        commit({ armW: Math.max(0, Math.round(Number(ev.target.value) || 0)) }),
      );
      p.querySelector('#f-armh').addEventListener('change', (ev) =>
        commit({ armH: Math.max(0, Math.round(Number(ev.target.value) || 0)) }),
      );
      p.querySelector('#f-rect').addEventListener('click', () => this.restoreRectangle());
    }
    p.querySelector('#f-del')?.addEventListener('click', () => this.deleteRoom(sel.id));
    this.syncToolUi();
  }

  toast(msg, isError = false) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.paint();
    });
  }

  paint() {
    const { ctx, dpr, cw, ch } = this;
    const lot = lotOf(this.project);
    const v = this.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cw * dpr, ch * dpr);

    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
    const px = 1 / v.scale; // 1 screen px in world units

    /* lot */
    ctx.save();
    ctx.shadowColor = 'rgba(30,60,100,0.16)';
    ctx.shadowBlur = 24 * px * v.scale * 0.6;
    ctx.shadowOffsetY = 6 * px;
    ctx.fillStyle = COLORS.lot;
    roundRect(ctx, 0, 0, lot.w, lot.h, 0.18);
    ctx.fill();
    ctx.restore();

    const support = this.supportedCells();
    if (support) {
      ctx.fillStyle = '#d9dde3';
      for (let x = 0; x < lot.w; x += 1) {
        for (let y = 0; y < lot.h; y += 1) {
          if (!support.has(`${x},${y}`)) ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    /* grid */
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, lot.w, lot.h);
    ctx.clip();
    ctx.lineWidth = px;
    for (let i = 1; i < lot.w; i += 1) {
      ctx.strokeStyle = i % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, lot.h);
      ctx.stroke();
    }
    for (let j = 1; j < lot.h; j += 1) {
      ctx.strokeStyle = j % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, j);
      ctx.lineTo(lot.w, j);
      ctx.stroke();
    }
    /* 5-cell rulers */
    ctx.restore();

    /* lot border */
    ctx.lineWidth = 2 * px; // 2 screen px
    ctx.strokeStyle = COLORS.lotEdge;
    ctx.beginPath();
    roundRect(ctx, 0, 0, lot.w, lot.h, 0.18);
    ctx.stroke();

    /* rooms */
    if (this.floor === '1') {
      this.drawPoolRings(px);
      for (const pool of this.pools) this.drawPoolCore(pool, px);
      if ((this.tool === 'edit' && this.editMode === 'pool' || this.tool === 'select') && this.selectedPool) {
        this.drawPoolHandles(this.selectedPool, px);
      }
    }
    for (const room of this.rooms) {
      this.drawRoom(room, px);
    }
    this.drawPlacementReferenceFloor(px);
    for (const stair of this.stairsOnFloor) this.drawStair(stair, px);
    for (const mezzanine of this.mezzanines) this.drawMezzanine(mezzanine, px);
    if ((this.tool === 'select' || this.tool === 'edit' && this.editMode === 'mezzanine') && this.selectedMezzanine) {
      this.drawBalconyHandles(this.selectedMezzanine, px);
    }
    if (this.floor === '1') {
      for (const patio of this.patios) this.drawPatio(patio, px);
      if ((this.tool === 'edit' && this.editMode === 'patio' || this.tool === 'select') && this.selectedPatio) {
        this.drawPatioHandles(this.selectedPatio, px);
      }
    }
    for (const balcony of this.balconies) this.drawBalcony(balcony, px);
    if ((this.tool === 'edit' && this.editMode === 'balcony' || this.tool === 'select') && this.selectedBalcony) {
      this.drawBalconyHandles(this.selectedBalcony, px);
    }
    for (const door of this.doors) this.drawDoor(door, px);
    if ((this.tool === 'select' || this.tool === 'edit' && this.editMode === 'door') && this.selectedDoor) {
      this.drawDoorHandles(this.selectedDoor, px);
    }

    /* selection */
    const sel = this.selected;
    if (sel) this.drawSelection(sel, px);

    /* renovator overlay */
    if (this.tool === 'edit' && this.editMode === 'lroom' && this.selected) {
      this.drawRenovator(this.selected, px);
    }

    /* preview */
    if (this.preview) this.drawPreview(px);

    /* labels in screen space */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const room of this.rooms) {
      this.drawLabel(room, v);
    }
    if (this.floor === '1') {
      for (const patio of this.patios) this.drawPatioLabel(patio, v);
    }
    this.drawEmptyHint(v, lot);
    this.commitView();
  }

  drawPlacementReferenceFloor(px) {
    const floor = this.placementReferenceFloor;
    if (!floor) return;
    const rooms = roomsOnFloor(this.project, floor);
    if (!rooms.length) return;

    const selectionId = this.selectionId;
    const hoverId = this.hoverId;
    this.selectionId = null;
    this.hoverId = null;
    this.ctx.save();
    this.ctx.globalAlpha = 0.32;
    try {
      for (const room of rooms) this.drawRoom(room, px);
      this.ctx.globalAlpha = 1;
      const stroke = this.editMode === 'stairs' ? '#008da8' : '#9852c8';
      for (const room of rooms) {
        const polygon = outlineOf(room);
        this.ctx.beginPath();
        polygon.forEach(([x, y], index) =>
          index ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y),
        );
        this.ctx.closePath();
        this.ctx.lineJoin = 'round';
        this.ctx.lineWidth = 5 * px;
        this.ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        this.ctx.stroke();
        this.ctx.lineWidth = 3 * px;
        this.ctx.strokeStyle = stroke;
        this.ctx.stroke();
      }
    } finally {
      this.ctx.restore();
      this.selectionId = selectionId;
      this.hoverId = hoverId;
    }
  }

  async downloadPng() {
    const lot = lotOf(this.project);
    const scale = 48;
    const padding = 40;
    const canvas = document.createElement('canvas');
    canvas.width = lot.w * scale + padding * 2;
    canvas.height = lot.h * scale + padding * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create an image canvas.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, padding, padding);

    ctx.save();
    ctx.shadowColor = 'rgba(30,60,100,0.16)';
    ctx.shadowBlur = 12 / scale;
    ctx.shadowOffsetY = 3 / scale;
    ctx.fillStyle = COLORS.lot;
    roundRect(ctx, 0, 0, lot.w, lot.h, 0.18);
    ctx.fill();
    ctx.restore();

    const support = this.supportedCells();
    if (support) {
      ctx.fillStyle = '#d9dde3';
      for (let x = 0; x < lot.w; x += 1) {
        for (let y = 0; y < lot.h; y += 1) {
          if (!support.has(`${x},${y}`)) ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, lot.w, lot.h);
    ctx.clip();
    ctx.lineWidth = 1 / scale;
    for (let x = 1; x < lot.w; x += 1) {
      ctx.strokeStyle = x % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, lot.h);
      ctx.stroke();
    }
    for (let y = 1; y < lot.h; y += 1) {
      ctx.strokeStyle = y % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(lot.w, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = COLORS.lotEdge;
    ctx.beginPath();
    roundRect(ctx, 0, 0, lot.w, lot.h, 0.18);
    ctx.stroke();

    const originalCtx = this.ctx;
    const originalSelection = this.selectionId;
    const originalHover = this.hoverId;
    try {
      this.ctx = ctx;
      this.selectionId = null;
      this.hoverId = null;
      if (this.floor === '1') {
        this.drawPoolRings(1 / scale);
        for (const pool of this.pools) this.drawPoolCore(pool, 1 / scale);
      }
      for (const room of this.rooms) this.drawRoom(room, 1 / scale);
      if (this.floor === '1') {
        for (const patio of this.patios) this.drawPatio(patio, 1 / scale);
      }
      for (const balcony of this.balconies) this.drawBalcony(balcony, 1 / scale);
      for (const stair of this.stairsOnFloor) this.drawStair(stair, 1 / scale);
      for (const mezzanine of this.mezzanines) this.drawMezzanine(mezzanine, 1 / scale);
      for (const door of this.doors) this.drawDoor(door, 1 / scale);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const room of this.rooms) {
        this.drawLabel(room, { scale, tx: padding, ty: padding });
      }
      for (const balcony of this.balconies) {
        this.drawBalconyLabel(balcony, { scale, tx: padding, ty: padding });
      }
      if (this.floor === '1') {
        for (const patio of this.patios) this.drawPatioLabel(patio, { scale, tx: padding, ty: padding });
      }
    } finally {
      this.ctx = originalCtx;
      this.selectionId = originalSelection;
      this.hoverId = originalHover;
    }

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('The browser could not encode the floor plan.'));
      }, 'image/png');
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName =
      this.project.name.replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '-') ||
      'floor-plan';
    a.href = url;
    const floorName = this.floor === 'basement' ? 'basement' : `${this.floor}F`;
    a.download = `${safeName}-${floorName}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast('PNG image exported');
  }

  drawRoom(room, px) {
    const { ctx } = this;
    const selId = this.selectionId;
    const hover = this.hoverId;
    const selected = room.id === selId;
    const rects = rectsOf(room);
    const isLshaped = isL(room);

    ctx.save();
    // Notch ghost (shows the missing corner of an L room)
    if (isLshaped) {
      const a = room.armW;
      const b = room.armH;
      let nx = room.lshape.includes('W') ? room.x : room.x + room.w - a;
      let ny = room.lshape.includes('N') ? room.y : room.y + room.h - b;
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.strokeStyle = 'rgba(120,150,190,0.55)';
      ctx.lineWidth = px;
      ctx.strokeRect(nx, ny, a, b);
      ctx.setLineDash([]);
    }

    // Glow / hover
    if (selected) {
      ctx.strokeStyle = COLORS.selectGlow;
      ctx.lineWidth = 8 * px;
      strokeRects(ctx, rects);
    } else if (hover === room.id) {
      ctx.strokeStyle = 'rgba(47,125,221,0.16)';
      ctx.lineWidth = 6 * px;
      strokeRects(ctx, rects);
    }

    // Floor
    ctx.fillStyle = selected ? COLORS.selectedFill : COLORS.roomFill;
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);

    // Interior corner emphasis for L
    if (isLshaped) {
      const ic = innerCornerOf(room);
      ctx.strokeStyle = selected ? 'rgba(47,125,221,0.5)' : 'rgba(147,182,224,0.75)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(ic.x, ic.y);
      ctx.stroke();
    }

    // Walls (outline of the true polygon, not per-rect, so no internal lines)
    ctx.strokeStyle = selected ? COLORS.selectedWall : COLORS.roomWall;
    ctx.lineWidth = (selected ? 3.2 : 2.6) * px;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const poly = outlineOf(room);
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  drawBalcony(balcony, px) {
    const { ctx } = this;
    const selected = balcony.id === this.selectionId;
    const hovered = balcony.id === this.hoverId;
    ctx.save();
    ctx.fillStyle = selected ? '#f3d9a8' : '#f6dfb4';
    ctx.fillRect(balcony.x, balcony.y, balcony.w, balcony.h);
    ctx.strokeStyle = selected ? '#2f7ddd' : hovered ? '#aa701c' : '#c9872b';
    ctx.lineWidth = (selected ? 3 : hovered ? 2.5 : 2) * px;
    if (!selected) ctx.setLineDash([3 * px, 2 * px]);
    ctx.strokeRect(balcony.x + px, balcony.y + px, balcony.w - 2 * px, balcony.h - 2 * px);
    ctx.setLineDash([]);
    if (['N', 'E', 'S', 'W'].includes(balcony.side)) {
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      if (balcony.side === 'N') {
        ctx.moveTo(balcony.x, balcony.y);
        ctx.lineTo(balcony.x + balcony.w, balcony.y);
      } else if (balcony.side === 'S') {
        ctx.moveTo(balcony.x, balcony.y + balcony.h);
        ctx.lineTo(balcony.x + balcony.w, balcony.y + balcony.h);
      } else if (balcony.side === 'W') {
        ctx.moveTo(balcony.x, balcony.y);
        ctx.lineTo(balcony.x, balcony.y + balcony.h);
      } else {
        ctx.moveTo(balcony.x + balcony.w, balcony.y);
        ctx.lineTo(balcony.x + balcony.w, balcony.y + balcony.h);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPatio(patio, px) {
    const { ctx } = this;
    const selected = patio.id === this.selectionId;
    const hovered = patio.id === this.hoverId;
    ctx.save();
    ctx.fillStyle = selected ? '#f3d9a8' : '#f6dfb4';
    ctx.fillRect(patio.x, patio.y, patio.w, patio.h);
    ctx.strokeStyle = selected ? '#2f7ddd' : hovered ? '#aa701c' : '#c9872b';
    ctx.lineWidth = (selected ? 3 : hovered ? 2.5 : 2) * px;
    if (!selected) ctx.setLineDash([3 * px, 2 * px]);
    ctx.strokeRect(patio.x + px, patio.y + px, patio.w - 2 * px, patio.h - 2 * px);
    ctx.restore();
  }

  drawMezzanine(mezzanine, px) {
    const { ctx } = this;
    const selected = mezzanine.id === this.selectionId;
    const hovered = mezzanine.id === this.hoverId;
    ctx.save();
    ctx.fillStyle = selected ? 'rgba(128,107,78,0.48)' : 'rgba(177,154,119,0.4)';
    ctx.fillRect(mezzanine.x, mezzanine.y, mezzanine.w, mezzanine.h);
    ctx.strokeStyle = selected ? COLORS.selectedWall : hovered ? '#806b4e' : '#9a815d';
    ctx.lineWidth = (selected ? 3 : hovered ? 2.5 : 2) * px;
    ctx.setLineDash([4 * px, 2 * px]);
    ctx.strokeRect(
      mezzanine.x + px,
      mezzanine.y + px,
      mezzanine.w - 2 * px,
      mezzanine.h - 2 * px,
    );
    ctx.restore();
  }

  drawStair(stair, px) {
    const { ctx } = this;
    const { w, h } = stairSize(stair);
    const opening = this.floor !== stair.lowerFloor;
    const selected = stair.id === this.selectionId;
    const hovered = stair.id === this.hoverId;
    ctx.save();
    ctx.fillStyle = opening ? 'rgba(116,130,151,0.12)' : '#d8d1c5';
    ctx.fillRect(stair.x, stair.y, w, h);
    ctx.strokeStyle = selected ? COLORS.selectedWall : hovered ? '#8a6c45' : opening ? '#8995a5' : '#806b4e';
    ctx.lineWidth = (selected ? 3 : 2) * px;
    if (opening) ctx.setLineDash([4 * px, 2 * px]);
    ctx.strokeRect(stair.x + px, stair.y + px, w - 2 * px, h - 2 * px);
    ctx.setLineDash([]);

    if (opening) {
      ctx.strokeStyle = 'rgba(112,126,145,0.65)';
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.moveTo(stair.x + px * 2, stair.y + px * 2);
      ctx.lineTo(stair.x + w - px * 2, stair.y + h - px * 2);
      ctx.moveTo(stair.x + w - px * 2, stair.y + px * 2);
      ctx.lineTo(stair.x + px * 2, stair.y + h - px * 2);
      ctx.stroke();
    } else {
      const verticalRun = h >= w;
      const steps = Math.max(2, Math.max(w, h));
      ctx.strokeStyle = 'rgba(93,75,51,0.62)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let i = 1; i < steps; i += 1) {
        const t = i / steps;
        if (verticalRun) {
          ctx.moveTo(stair.x + px, stair.y + h * t);
          ctx.lineTo(stair.x + w - px, stair.y + h * t);
        } else {
          ctx.moveTo(stair.x + w * t, stair.y + px);
          ctx.lineTo(stair.x + w * t, stair.y + h - px);
        }
      }
      ctx.stroke();
      ctx.fillStyle = selected ? COLORS.selectedWall : '#725b3d';
      ctx.beginPath();
      if (verticalRun) {
        const cx = stair.x + w / 2;
        ctx.moveTo(cx - 0.18, stair.y + 0.42);
        ctx.lineTo(cx + 0.18, stair.y + 0.42);
        ctx.lineTo(cx, stair.y + 0.16);
      } else {
        const cy = stair.y + h / 2;
        ctx.moveTo(stair.x + w - 0.42, cy - 0.18);
        ctx.lineTo(stair.x + w - 0.42, cy + 0.18);
        ctx.lineTo(stair.x + w - 0.16, cy);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  drawDoor(door, px) {
    const { ctx } = this;
    const horizontal = door.orientation === 'horizontal';
    const x1 = horizontal ? door.x : door.x;
    const y1 = horizontal ? door.y : door.y;
    const x2 = horizontal ? door.x + door.length : door.x;
    const y2 = horizontal ? door.y : door.y + door.length;
    const selected = door.id === this.selectionId;
    const hovered = door.id === this.hoverId;
    const leaf = Math.min(0.78, door.length - 0.1);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5 * px;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = selected ? '#2f7ddd' : hovered ? '#a66b27' : '#76502d';
    ctx.fillStyle = selected ? '#2f7ddd' : '#76502d';
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1, y1 + leaf);
      ctx.arc(x1, y1, leaf, Math.PI / 2, 0, true);
    } else {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + leaf, y1);
      ctx.arc(x1, y1, leaf, 0, Math.PI / 2, false);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawDoorHandles(door, px) {
    const { ctx } = this;
    const horizontal = door.orientation === 'horizontal';
    const startOffset = door.length === 1 ? 0.25 : 0.5;
    const endOffset = door.length === 1 ? 0.75 : door.length - 0.5;
    const points = [
      horizontal ? [door.x + startOffset, door.y] : [door.x, door.y + startOffset],
      horizontal ? [door.x + endOffset, door.y] : [door.x, door.y + endOffset],
    ];
    ctx.save();
    for (const [x, y] of points) {
      const size = 8 * px;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2f7ddd';
      ctx.lineWidth = 1.8 * px;
      ctx.beginPath();
      ctx.rect(x - size / 2, y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPatioHandles(patio, px) {
    this.drawBalconyHandles(patio, px);
  }

  drawPatioLabel(patio, view) {
    const { ctx } = this;
    const x = (patio.x + patio.w / 2) * view.scale + view.tx;
    const y = (patio.y + patio.h / 2) * view.scale + view.ty;
    if (patio.w * view.scale < 32 || patio.h * view.scale < 20) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.min(11, Math.max(8, view.scale * 0.45))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = '#80551c';
    ctx.fillText('Patio', x, y);
    ctx.restore();
  }

  drawPoolRings(px) {
    const { ctx } = this;
    const cells = new Set();
    const rectangles = this.pools.map((pool) => ({
      pool,
      rect: poolOuterRect(pool),
    }));

    ctx.save();
    ctx.fillStyle = COLORS.poolRing;
    for (const { rect } of rectangles) {
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        for (let y = rect.y; y < rect.y + rect.h; y += 1) {
          cells.add(`${x},${y}`);
        }
      }
    }

    const edges = new Map([
      ['selected', []],
      ['hovered', []],
      ['normal', []],
    ]);
    const sides = [
      { dx: 0, dy: -1, x1: 0, y1: 0, x2: 1, y2: 0 },
      { dx: 1, dy: 0, x1: 1, y1: 0, x2: 1, y2: 1 },
      { dx: 0, dy: 1, x1: 0, y1: 1, x2: 1, y2: 1 },
      { dx: -1, dy: 0, x1: 0, y1: 0, x2: 0, y2: 1 },
    ];
    for (const key of cells) {
      const [x, y] = key.split(',').map(Number);
      for (const side of sides) {
        if (cells.has(`${x + side.dx},${y + side.dy}`)) continue;
        const owners = rectangles
          .filter(({ rect }) =>
            x >= rect.x && x < rect.x + rect.w &&
            y >= rect.y && y < rect.y + rect.h &&
            !(x + side.dx >= rect.x && x + side.dx < rect.x + rect.w &&
              y + side.dy >= rect.y && y + side.dy < rect.y + rect.h),
          )
          .map(({ pool }) => pool);
        const state = owners.some((pool) => pool.id === this.selectionId)
          ? 'selected'
          : owners.some((pool) => pool.id === this.hoverId) ? 'hovered' : 'normal';
        edges.get(state).push([
          x + side.x1, y + side.y1,
          x + side.x2, y + side.y2,
        ]);
      }
    }

    for (const [state, segments] of edges) {
      if (!segments.length) continue;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segments) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.lineWidth = (state === 'selected' ? 3 : state === 'hovered' ? 2.5 : 2) * px;
      ctx.strokeStyle = state === 'selected'
        ? '#2f7ddd'
        : state === 'hovered' ? '#18799e' : COLORS.poolEdge;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPoolCore(pool, px) {
    const { ctx } = this;
    const selected = pool.id === this.selectionId;
    const hovered = pool.id === this.hoverId;
    ctx.save();
    ctx.fillStyle = selected ? '#65bde0' : COLORS.pool;
    ctx.fillRect(pool.x, pool.y, pool.w, pool.h);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = selected ? '#2f7ddd' : hovered ? '#18799e' : COLORS.poolEdge;
    ctx.strokeRect(pool.x + px, pool.y + px, pool.w - 2 * px, pool.h - 2 * px);
    ctx.restore();
  }

  drawPoolHandles(pool, px) {
    const { ctx } = this;
    ctx.save();
    for (const edge of this.balconyHandleEdges(pool)) {
      const x = edge === 'W' ? pool.x : edge === 'E' ? pool.x + pool.w : pool.x + pool.w / 2;
      const y = edge === 'N' ? pool.y : edge === 'S' ? pool.y + pool.h : pool.y + pool.h / 2;
      const size = 8 * px;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2f7ddd';
      ctx.lineWidth = 1.8 * px;
      ctx.beginPath();
      ctx.rect(x - size / 2, y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBalconyHandles(balcony, px) {
    const { ctx } = this;
    ctx.save();
    for (const edge of this.balconyHandleEdges(balcony)) {
      const x = edge === 'W' ? balcony.x : edge === 'E' ? balcony.x + balcony.w : balcony.x + balcony.w / 2;
      const y = edge === 'N' ? balcony.y : edge === 'S' ? balcony.y + balcony.h : balcony.y + balcony.h / 2;
      const size = 8 * px;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2f7ddd';
      ctx.lineWidth = 1.8 * px;
      ctx.beginPath();
      ctx.rect(x - size / 2, y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBalconyLabel(balcony, view) {
    const { ctx } = this;
    const x = (balcony.x + balcony.w / 2) * view.scale + view.tx;
    const y = (balcony.y + balcony.h / 2) * view.scale + view.ty;
    if (balcony.w * view.scale < 32 || balcony.h * view.scale < 20) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.min(11, Math.max(8, view.scale * 0.45))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = '#80551c';
    ctx.fillText('Balcony', x, y);
    ctx.restore();
  }

  drawLabel(room, v) {
    const { ctx } = this;
    const c = centroidOf(room);
    const sx = c.x * v.scale + v.tx;
    const sy = c.y * v.scale + v.ty;
    const wpx = room.w * v.scale;
    const hpx = room.h * v.scale;
    if (wpx < 22 || hpx < 22) return;
    ctx.save();
    const vertical = wpx < 50 && hpx > wpx * 2.2;
    if (vertical) {
      ctx.translate(sx, sy);
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-sx, -sy);
    }
    const spanPx = vertical ? hpx : wpx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const small = Math.min(13, Math.max(10, spanPx / 9));
    const dims = isL(room) ? `${room.w} × ${room.h} · L` : `${room.w} × ${room.h}`;
    const nameFont = `600 ${small}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    const dimsFont = `500 ${small * 0.82}px ui-sans-serif, system-ui, sans-serif`;

    ctx.font = nameFont;
    const name = clampText(ctx, room.name, Math.max(18, spanPx - 12));
    const nameW = ctx.measureText(name).width;
    ctx.font = dimsFont;
    const dimsW = ctx.measureText(dims).width;

    // Very narrow rooms only get the rotated name — two lines won't fit.
    const plateW = (vertical ? nameW : Math.max(nameW, dimsW)) + 14;
    const plateH = vertical ? small * 1.7 : small * 2.35;

    // soft plate so labels stay readable on dense grids and small rooms
    roundRect(ctx, sx - plateW / 2, sy - plateH / 2, plateW, plateH, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = nameFont;
    ctx.fillStyle = C_COLORS_ROOM_LABEL;
    ctx.fillText(name, sx, vertical ? sy : sy - small * 0.5);
    if (!vertical) {
      ctx.font = dimsFont;
      ctx.fillStyle = 'rgba(74,102,144,0.72)';
      ctx.fillText(dims, sx, sy + small * 0.75);
    }
    ctx.restore();
  }

  drawSelection(room, px) {
    const { ctx } = this;
    if (this.tool !== 'edit' && this.tool !== 'select') return;
    if (this.tool === 'edit' && this.editMode === 'balcony') return;
    if (this.tool === 'edit' && this.editMode === 'lroom' && !isL(room)) return;
    ctx.save();
    if (isL(room) && this.tool === 'edit') {
      // Extension handle: drag to widen / narrow the L (FreePlay room mode)
      const ic = innerCornerOf(room);
      const r = 7 * px;
      ctx.beginPath();
      ctx.moveTo(ic.x, ic.y - r);
      ctx.lineTo(ic.x + r, ic.y);
      ctx.lineTo(ic.x, ic.y + r);
      ctx.lineTo(ic.x - r, ic.y);
      ctx.closePath();
      ctx.fillStyle = COLORS.anchor;
      ctx.fill();
      ctx.lineWidth = 1.8 * px;
      ctx.strokeStyle = COLORS.anchorEdge;
      ctx.stroke();
    }
    for (const h of this.rectHandles(room)) {
      const s = 9 * px;
      ctx.fillStyle = COLORS.handle;
      ctx.strokeStyle = COLORS.handleEdge;
      ctx.lineWidth = 1.6 * px;
      ctx.beginPath();
      ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRenovator(room, px) {
    const { ctx } = this;
    ctx.save();

    // footprint outline in yellow
    ctx.strokeStyle = 'rgba(255,209,26,0.95)';
    ctx.lineWidth = 3 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    const poly = outlineOf(room);
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    if (isL(room)) {
      const ic = innerCornerOf(room);
      this.drawAnchor(ic.x, ic.y, px, true);
      ctx.font = `${11 * px}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(120,95,0,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText('drag to resize extension', ic.x, ic.y + 0.95);
    } else {
      for (const a of this.anchorsOf(room)) {
        const active =
          this.drag &&
          this.drag.kind === 'renovator' &&
          this.drag.anchor === a.anchor &&
          this.drag.dir === a.dir;
        this.drawAnchor(a.x, a.y, px, false, active);
      }
      ctx.font = `${10.5 * px}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(120,95,0,0.9)';
      ctx.textAlign = 'center';
      ctx.fillText('pull a yellow anchor outward to extend', room.x + room.w / 2, room.y - 1.15);
    }
    ctx.restore();
  }

  drawAnchor(x, y, px, inner, active) {
    const { ctx } = this;
    const rad = (active ? 8.5 : 7) * px;
    ctx.save();
    ctx.shadowColor = 'rgba(255,200,0,0.55)';
    ctx.shadowBlur = 10 * px * 1.2;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#fff3b0' : COLORS.anchor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = COLORS.anchorEdge;
    ctx.stroke();
    if (inner) {
      ctx.beginPath();
      ctx.arc(x, y, rad * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.anchorEdge;
      ctx.fill();
    }
    ctx.restore();
  }

  drawPreview(px) {
    const { ctx } = this;
    const pv = this.preview;
    const cand = pv.room || pv.candidate;
    if (!cand) return;
    const ok = pv.ok;
    ctx.save();
    if (pv.type === 'stair') {
      const { w, h } = stairSize(cand);
      ctx.fillStyle = ok ? 'rgba(128,108,76,0.3)' : COLORS.invalidFill;
      ctx.fillRect(cand.x, cand.y, w, h);
      ctx.strokeStyle = ok ? '#806b4e' : COLORS.invalid;
      ctx.lineWidth = 2.5 * px;
      ctx.setLineDash([5 * px, 3 * px]);
      ctx.strokeRect(cand.x + px, cand.y + px, w - 2 * px, h - 2 * px);
      ctx.restore();
      return;
    }
    if (pv.type === 'mezzanine') {
      ctx.fillStyle = ok ? 'rgba(177,154,119,0.38)' : COLORS.invalidFill;
      ctx.fillRect(cand.x, cand.y, cand.w, cand.h);
      ctx.strokeStyle = ok ? '#9a815d' : COLORS.invalid;
      ctx.lineWidth = 2.5 * px;
      ctx.setLineDash([5 * px, 3 * px]);
      ctx.strokeRect(cand.x + px, cand.y + px, cand.w - 2 * px, cand.h - 2 * px);
      ctx.restore();
      return;
    }
    if (pv.type === 'door') {
      ctx.strokeStyle = ok ? '#22a56b' : COLORS.invalid;
      ctx.lineWidth = 5 * px;
      ctx.setLineDash([4 * px, 2 * px]);
      ctx.beginPath();
      if (cand.orientation === 'horizontal') {
        ctx.moveTo(cand.x, cand.y);
        ctx.lineTo(cand.x + cand.length, cand.y);
      } else {
        ctx.moveTo(cand.x, cand.y);
        ctx.lineTo(cand.x, cand.y + cand.length);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (pv.type === 'pool') {
      const outer = poolOuterRect(cand);
      ctx.fillStyle = ok ? 'rgba(80, 183, 219, 0.22)' : COLORS.invalidFill;
      ctx.fillRect(outer.x, outer.y, outer.w, outer.h);
      ctx.fillStyle = ok ? 'rgba(80, 183, 219, 0.42)' : 'rgba(214,69,69,0.28)';
      ctx.fillRect(cand.x, cand.y, cand.w, cand.h);
      ctx.strokeStyle = ok ? COLORS.poolEdge : COLORS.invalid;
      ctx.lineWidth = 2.5 * px;
      ctx.setLineDash([5 * px, 3 * px]);
      ctx.strokeRect(outer.x + px, outer.y + px, outer.w - 2 * px, outer.h - 2 * px);
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }
    const rects = rectsOf(cand);
    ctx.fillStyle = pv.type === 'balcony' || pv.type === 'patio'
      ? ok ? 'rgba(230,151,43,0.38)' : 'rgba(214,69,69,0.24)'
      : ok ? COLORS.validFill : COLORS.invalidFill;
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = pv.type === 'balcony' || pv.type === 'patio'
      ? ok ? '#c9872b' : COLORS.invalid
      : ok ? COLORS.valid : COLORS.invalid;
    ctx.lineWidth = 2.5 * px;
    ctx.setLineDash([5 * px, 3 * px]);
    const poly = outlineOf(cand);
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawEmptyHint(v, lot) {
    if (this.rooms.length) return;
    const { ctx } = this;
    const sx = (lot.w / 2) * v.scale + v.tx;
    const sy = (lot.h / 2) * v.scale + v.ty;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(90,112,145,0.62)';
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('Drag on the grid to build your first room', sx, sy - 8);
    ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(90,112,145,0.45)';
    ctx.fillText('Press C or the round button to enter Build mode', sx, sy + 14);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const C_COLORS_ROOM_LABEL = COLORS.roomLabel;

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function strokeRects(ctx, rects) {
  for (const r of rects) ctx.strokeRect(r.x, r.y, r.w, r.h);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function clampText(ctx, text, maxPx) {
  if (ctx.measureText(text).width <= maxPx) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxPx) t = t.slice(0, -1);
  return `${t}…`;
}

/* inline SVG icons (no external assets) */
export function icon(name) {
  const s = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  switch (name) {
    case 'select':
      return `<svg ${s}><path d="M4 3l7 17 2.5-6.5L20 11z"/></svg>`;
    case 'edit':
      return `<svg ${s}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>`;
    case 'rect':
      return `<svg ${s}><rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/></svg>`;
    case 'lshape':
      return `<svg ${s}><path d="M4 4h10v6h6v10H4z"/></svg>`;
    case 'balcony':
      return `<svg ${s}><path d="M4 5h16v6H4z"/><path d="M7 11v8M12 11v8M17 11v8"/><path d="M3 19h18"/></svg>`;
    case 'pool':
      return `<svg ${s}><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M7 12c1.2-1 2.4-1 3.6 0s2.4 1 3.6 0 2.4-1 3.6 0"/></svg>`;
    case 'door':
      return `<svg ${s}><path d="M5 21V4h14v17"/><path d="M8 21V7l8-2v16"/><circle cx="14" cy="14" r=".7" fill="currentColor"/></svg>`;
    case 'stair':
      return `<svg ${s}><path d="M4 20h4v-4h4v-4h4V8h4"/><path d="M4 16h4M8 12h4M12 8h4M16 4h4"/></svg>`;
    case 'mezzanine':
      return `<svg ${s}><path d="M4 8h16v12H4z"/><path d="M8 8V4h12v4M8 12h8M8 16h8"/></svg>`;
    case 'renovator':
      return `<svg ${s}><path d="M3 9V3h6"/><path d="M21 15v6h-6"/><path d="M9 3H3v6"/><path d="M15 21h6v-6"/><circle cx="12" cy="12" r="2.2"/></svg>`;
    case 'trash':
      return `<svg ${s}><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>`;
    case 'fit':
      return `<svg ${s}><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>`;
    case 'plus':
      return `<svg ${s}><path d="M12 5v14M5 12h14"/></svg>`;
    case 'file':
      return `<svg ${s}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>`;
    case 'grid':
      return `<svg ${s}><rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M9 4v16M15 4v16M4 9h16M4 15h16"/></svg>`;
    default:
      return `<svg ${s}><circle cx="12" cy="12" r="8"/></svg>`;
  }
}

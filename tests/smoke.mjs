// Headless smoke test: drives the real UI through the whole MVP flow.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('•', ...a);
const errors = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}01-home.png` });
log('home loaded:', await page.title());

// ---- create project ----
await page.click('#btn-new');
await page.waitForSelector('.lot-opt');
await page.click('[data-lot="ocean"]');
await page.fill('#c-name', 'Smoke Test House');
await page.screenshot({ path: `${OUT}02-create.png` });
await page.click('#c-create');
await page.waitForSelector('#fp-canvas');
log('editor opened at', page.url());
if (await page.locator('#fp-export').count()) throw new Error('JSON export button should not be shown');
if (await page.locator('#fp-create-toggle').isVisible()) {
  throw new Error('Create/L-Shape button should be hidden outside Edit mode');
}
if (await page.locator('#fp-pool-toggle').isVisible()) {
  throw new Error('pool button should be hidden outside Edit mode');
}
await page.click('[data-tool="edit"]');
if (!(await page.locator('#fp-create-toggle').isVisible())) {
  throw new Error('Create/L-Shape button should appear in Edit mode');
}
if (!(await page.locator('#fp-pool-toggle').isVisible())) {
  throw new Error('pool button should appear in Edit mode on 1F');
}

// ---- draw a rectangle room by dragging on the grid ----
const box = await page.locator('#fp-canvas').boundingBox();
// map grid coords -> screen using the app's own camera
const grid = async (cx, cy) => {
  const p = await page.evaluate(
    ([x, y]) => {
      const ed = window.__fp;
      return { x: ed.view.tx + x * ed.view.scale, y: ed.view.ty + y * ed.view.scale };
    },
    [cx, cy],
  );
  return { x: box.x + p.x, y: box.y + p.y };
};

async function dragCell(from, to) {
  const a = await grid(from[0] + 0.5, from[1] + 0.5);
  const b = await grid(to[0] + 0.5, to[1] + 0.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

const initialBuildState = await page.locator('#fp-create-toggle').getAttribute('aria-label');
if (initialBuildState !== 'Create room') throw new Error('editor should open in Create Room mode');
const createIcon = await page.locator('#fp-create-toggle svg').evaluate((svg) => svg.outerHTML);
const fabBox = await page.locator('#fp-create-toggle').boundingBox();
const iconBox = await page.locator('#fp-create-toggle svg').boundingBox();
if (Math.abs(fabBox.x + fabBox.width / 2 - iconBox.x - iconBox.width / 2) > 1 ||
    Math.abs(fabBox.y + fabBox.height / 2 - iconBox.y - iconBox.height / 2) > 1) {
  throw new Error('mode icon is not centered in the round button');
}
await page.click('#fp-create-toggle');
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'L-shape mode') {
  throw new Error('round button did not switch to L-Shape mode');
}
const lIcon = await page.locator('#fp-create-toggle svg').evaluate((svg) => svg.outerHTML);
if (createIcon === lIcon) throw new Error('Create Room and L-Shape buttons must use different icons');
if (!(await page.locator('#fp-toast').textContent()).includes('L-Shape')) {
  throw new Error('switching to L-Shape mode did not show a mode prompt');
}
await page.click('#fp-create-toggle');
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'Create room') {
  throw new Error('round button did not switch back to Create Room mode');
}
if (!(await page.locator('#fp-toast').textContent()).includes('Create Room')) {
  throw new Error('switching to Create Room mode did not show a mode prompt');
}
await page.click('#fp-create-toggle');
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'L-shape mode') {
  throw new Error('1F should not offer Balcony mode');
}
if (await page.locator('#fp-balcony-toggle').isVisible()) {
  throw new Error('balcony button should be hidden on 1F');
}
await page.click('#fp-create-toggle');
await dragCell([1, 1], [6, 5]);
let rooms = await page.evaluate(() => window.__fp.project.rooms);
log('after rect drag:', JSON.stringify(rooms.map((r) => [r.x, r.y, r.w, r.h])));
if (rooms.length !== 1) throw new Error('rectangle room was not created');

// 1x1 must be rejected
await dragCell([10, 10], [10, 10]);
rooms = await page.evaluate(() => window.__fp.project.rooms);
log('1x1 rejected?', rooms.length === 1);
if (rooms.length !== 1) throw new Error('1x1 room was accepted');

// 1x2 must be accepted
await dragCell([10, 10], [10, 11]);
rooms = await page.evaluate(() => window.__fp.project.rooms);
log('1x2 accepted?', rooms.length === 2);
if (rooms.length !== 2) throw new Error('1x2 room was rejected');

// overlap must be rejected
await dragCell([8, 2], [6, 4]);
rooms = await page.evaluate(() => window.__fp.project.rooms);
const firstRoomAfterOverlap = await page.evaluate(() => window.__fp.project.rooms[0]);
log('overlap rejected?', rooms.length === 2 && firstRoomAfterOverlap.x === 1 && firstRoomAfterOverlap.y === 1);
if (firstRoomAfterOverlap.x !== 1 || firstRoomAfterOverlap.y !== 1) {
  throw new Error('overlap attempt moved an existing room instead of testing creation');
}

// touching must be accepted
await dragCell([7, 4], [9, 6]);
rooms = await page.evaluate(() => window.__fp.project.rooms);
log('touching accepted?', rooms.length === 3, '| room count:', rooms.length);
if (rooms.length !== 3) throw new Error('touching rooms were not accepted as adjacent');

await page.screenshot({ path: `${OUT}03-rooms.png` });

// ---- L-Shape mode: right-side anchor should extend right ----
await page.click('#fp-create-toggle');
const room3 = await page.evaluate(() => window.__fp.project.rooms.find((room) => room.name === 'Room 3'));
const room3Point = await grid(room3.x + 1.5, room3.y + 1.5);
await page.mouse.click(room3Point.x, room3Point.y);
const rightAnchor = await page.evaluate((id) => {
  const ed = window.__fp;
  const room = ed.project.rooms.find((item) => item.id === id);
  return { ...ed.anchorsOf(room).find((anchor) => anchor.anchor === 'NE' && anchor.dir === 'right'), x0: room.x, w0: room.w };
}, room3.id);
const rightStart = await grid(rightAnchor.x, rightAnchor.y);
const rightDrop = await grid(rightAnchor.x + 1, rightAnchor.y);
await page.mouse.move(rightStart.x, rightStart.y);
await page.mouse.down();
await page.mouse.move(rightDrop.x, rightDrop.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
const rightExtended = await page.evaluate((id) => window.__fp.project.rooms.find((room) => room.id === id), room3.id);
if (rightExtended.x !== rightAnchor.x0 || rightExtended.w !== rightAnchor.w0 + 1) {
  throw new Error('right corner anchor did not extend the room to the right');
}

// ---- L-Shape mode: select room 1 and extend it to the left ----
await page.click('[data-tool="select"]');
if (await page.locator('#fp-create-toggle').isVisible()) throw new Error('button should hide in Select mode');
if (await page.locator('#fp-balcony-toggle').isVisible()) throw new Error('balcony button should hide in Select mode');
if (await page.locator('#fp-patio-toggle').isVisible()) throw new Error('patio button should hide in Select mode');
if (await page.locator('#fp-pool-toggle').isVisible()) throw new Error('pool button should hide in Select mode');
const selectOnlyRoom = await page.evaluate(() => window.__fp.project.rooms.find((room) => room.name === 'Room 1'));
const selectMove = await page.evaluate((roomId) => {
  const ed = window.__fp;
  const room = ed.rooms.find((item) => item.id === roomId);
  let start = null;
  for (let x = room.x; x < room.x + room.w && !start; x += 1) {
    for (let y = room.y; y < room.y + room.h; y += 1) {
      if (ed.roomAt(x + 0.5, y + 0.5)?.id === room.id) {
        start = { x, y };
        break;
      }
    }
  }
  let target = null;
  for (let y = 0; y <= 36 - room.h && !target; y += 1) {
    for (let x = 0; x <= 18 - room.w; x += 1) {
      let clear = true;
      for (let cx = x; cx < x + room.w && clear; cx += 1) {
        for (let cy = y; cy < y + room.h; cy += 1) {
          const other = ed.roomAt(cx + 0.5, cy + 0.5);
          if (other && other.id !== room.id) {
            clear = false;
            break;
          }
        }
      }
      if (clear && (x !== room.x || y !== room.y)) {
        target = { x, y };
        break;
      }
    }
  }
  if (!start || !target) return null;
  return {
    start,
    target,
    destination: { x: start.x + target.x - room.x, y: start.y + target.y - room.y },
  };
}, selectOnlyRoom.id);
if (!selectMove) throw new Error('Smoke test could not find a clear Select-mode room move');
const selectOnlyStart = await grid(selectMove.start.x + 0.5, selectMove.start.y + 0.5);
const selectOnlyEnd = await grid(selectMove.destination.x + 0.5, selectMove.destination.y + 0.5);
await page.mouse.move(selectOnlyStart.x, selectOnlyStart.y);
await page.mouse.down();
await page.mouse.move(selectOnlyEnd.x, selectOnlyEnd.y, { steps: 4 });
const selectMovePreview = await page.evaluate(() => ({
  drag: window.__fp.drag,
  preview: window.__fp.preview,
  tool: window.__fp.tool,
}));
await page.mouse.up();
const selectOnlyAfter = await page.evaluate((id) => window.__fp.project.rooms.find((room) => room.id === id), selectOnlyRoom.id);
if (selectOnlyAfter.x !== selectMove.target.x || selectOnlyAfter.y !== selectMove.target.y) {
  throw new Error(`Select mode should move a room: ${JSON.stringify({ selectOnlyAfter, selectMove, selectMovePreview })}`);
}
if (await page.locator('#f-w').isDisabled()) throw new Error('Select mode should allow room property editing');
if (await page.locator('#f-del').count()) throw new Error('Select mode should not show the room delete action');
await page.click('#fp-undo');
let selectRoomRestored = await page.evaluate((id) => window.__fp.project.rooms.find((room) => room.id === id), selectOnlyRoom.id);
if (selectRoomRestored.x !== selectOnlyRoom.x || selectRoomRestored.y !== selectOnlyRoom.y) {
  throw new Error('Undo should restore the room moved in Select mode');
}
const selectRoomCenter = await grid(selectRoomRestored.x + 0.5, selectRoomRestored.y + 0.5);
await page.mouse.click(selectRoomCenter.x, selectRoomCenter.y);
const selectResize = await page.evaluate((roomId) => {
  const ed = window.__fp;
  const room = ed.rooms.find((item) => item.id === roomId);
  for (const edge of ['E', 'W', 'S', 'N']) {
    const candidate = { ...room };
    if (edge === 'E' && room.x + room.w < 18) candidate.w += 1;
    else if (edge === 'W' && room.x > 0) { candidate.x -= 1; candidate.w += 1; }
    else if (edge === 'S' && room.y + room.h < 36) candidate.h += 1;
    else if (edge === 'N' && room.y > 0) { candidate.y -= 1; candidate.h += 1; }
    else continue;
    let clear = true;
    for (let x = candidate.x; x < candidate.x + candidate.w && clear; x += 1) {
      for (let y = candidate.y; y < candidate.y + candidate.h; y += 1) {
        const other = ed.roomAt(x + 0.5, y + 0.5);
        if (other && other.id !== room.id) {
          clear = false;
          break;
        }
      }
    }
    if (clear) return { edge, candidate };
  }
  return null;
}, selectOnlyRoom.id);
if (!selectResize) throw new Error('Smoke test could not find a clear Select-mode room resize');
const selectRoomEdgePoint = {
  E: [selectOnlyRoom.x + selectOnlyRoom.w, selectOnlyRoom.y + selectOnlyRoom.h / 2],
  W: [selectOnlyRoom.x, selectOnlyRoom.y + selectOnlyRoom.h / 2],
  S: [selectOnlyRoom.x + selectOnlyRoom.w / 2, selectOnlyRoom.y + selectOnlyRoom.h],
  N: [selectOnlyRoom.x + selectOnlyRoom.w / 2, selectOnlyRoom.y],
}[selectResize.edge];
const selectRoomResizeStart = await grid(selectRoomEdgePoint[0], selectRoomEdgePoint[1]);
const selectRoomResizeEnd = await grid(
  selectRoomEdgePoint[0] + (selectResize.edge === 'E' ? 1 : selectResize.edge === 'W' ? -1 : 0),
  selectRoomEdgePoint[1] + (selectResize.edge === 'S' ? 1 : selectResize.edge === 'N' ? -1 : 0),
);
await page.mouse.move(selectRoomResizeStart.x, selectRoomResizeStart.y);
await page.mouse.down();
await page.mouse.move(selectRoomResizeEnd.x, selectRoomResizeEnd.y, { steps: 6 });
const selectRoomResizePreview = await page.evaluate(() => ({
  drag: window.__fp.drag,
  preview: window.__fp.preview,
  tool: window.__fp.tool,
}));
await page.mouse.up();
selectRoomRestored = await page.evaluate((id) => window.__fp.project.rooms.find((room) => room.id === id), selectOnlyRoom.id);
if (selectRoomRestored.w !== selectResize.candidate.w || selectRoomRestored.h !== selectResize.candidate.h ||
    selectRoomRestored.x !== selectResize.candidate.x || selectRoomRestored.y !== selectResize.candidate.y) {
  throw new Error(`Select mode should resize a room: ${JSON.stringify({ selectRoomRestored, selectResize, selectRoomResizePreview })}`);
}
await page.click('#fp-undo');
await page.click('[data-tool="delete"]');
if (await page.locator('#fp-create-toggle').isVisible()) throw new Error('button should hide in Delete mode');
if (await page.locator('#fp-balcony-toggle').isVisible()) throw new Error('balcony button should hide in Delete mode');
if (await page.locator('#fp-patio-toggle').isVisible()) throw new Error('patio button should hide in Delete mode');
if (!(await page.locator('#f-w').isDisabled())) throw new Error('Delete mode should disable room properties');
if (await page.locator('#f-del').count()) throw new Error('Delete mode should not show the room delete action');
await page.click('[data-tool="edit"]');
if (!(await page.locator('#fp-create-toggle').isVisible())) throw new Error('button should show again in Edit mode');
const c1 = await grid(3.5, 3.5);
await page.mouse.click(c1.x, c1.y);
await page.click('#fp-create-toggle');
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'L-shape mode') {
  throw new Error('round button did not switch from Select to L-Shape mode');
}
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}04-build-mode.png` });

// drag the top-left horizontal anchor outwards to the left by 1 cell
const anchor = await page.evaluate(() => {
  const ed = window.__fp;
  // room 0 = the first rectangle built at (1,1)
  const room = ed.project.rooms.find((candidate) => candidate.name === 'Room 1');
  if (!room || room.lshape) throw new Error('the first room should still be rectangular before extension');
  ed.selectionId = room.id;
  ed.syncPanels();
  ed.render();
  const a = ed.anchorsOf(room).find((x) => x.anchor === 'NW' && x.dir === 'left');
  return { ...a, room: { x: room.x, w: room.w } };
});
log('anchor:', JSON.stringify(anchor));
const aPix = await grid(anchor.x, anchor.y);
const dropPix = await grid(anchor.x - 1, anchor.y);
await page.mouse.move(aPix.x, aPix.y);
await page.mouse.down();
await page.mouse.move(dropPix.x, dropPix.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const l = await page.evaluate(() => window.__fp.project.rooms[0]);
log('L room:', JSON.stringify({ w: l.w, h: l.h, lshape: l.lshape, armW: l.armW, armH: l.armH }));
if (!l.lshape) throw new Error('renovator did not produce an L room');
if (l.x !== anchor.room.x - 1 || l.w !== anchor.room.w + 1 || l.lshape !== 'SW') {
  throw new Error('left anchor drag did not extend left by the expected cell');
}
await page.screenshot({ path: `${OUT}05-lshape.png` });

// ---- properties panel edits ----
await page.click('[data-tool="edit"]');
await page.mouse.click(c1.x, c1.y);
await page.waitForTimeout(150);
await page.fill('#f-w', '1');
await page.locator('#f-w').press('Enter');
await page.waitForTimeout(150);
await page.fill('#f-h', '1');
await page.locator('#f-h').press('Enter');
await page.waitForTimeout(200);
const guarded = await page.evaluate(() => window.__fp.project.rooms[0]);
log('1x1 via panel blocked?', !(guarded.w === 1 && guarded.h === 1));
if (guarded.w === 1 && guarded.h === 1) throw new Error('property panel allowed 1x1');

// restore rectangle button
const hasRect = await page.$('#f-rect');
if (hasRect) {
  await page.click('#f-rect');
  await page.waitForTimeout(150);
  const rect = await page.evaluate(() => window.__fp.project.rooms[0]);
  log('restored to rectangle?', rect.lshape === null);
}
await page.screenshot({ path: `${OUT}06-props.png` });

// ---- move a room by dragging it ----
await page.click('[data-tool="select"]');
await page.click('[data-tool="edit"]');
const before3 = await page.evaluate(() => window.__fp.project.rooms.map((r) => ({ id: r.id, x: r.x, y: r.y })));
const bath = before3.find((r) => r.x === 7 && r.y === 1) || before3[before3.length - 1];
const from = await grid(bath.x + 1.5, bath.y + 1.5);
const to = await grid(bath.x + 1.5, bath.y + 4.5);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const moved = await page.evaluate((id) => window.__fp.project.rooms.find((r) => r.id === id), bath.id);
log('moved room?', JSON.stringify({ from: [bath.x, bath.y], to: [moved.x, moved.y] }));
if (moved.y === bath.y) throw new Error('room did not move');

// ---- move must be blocked when it would overlap ----
const first = (await page.evaluate(() => window.__fp.project.rooms))[0];
const f2 = await grid(moved.x + 0.5, moved.y + 0.5);
const t2 = await grid(first.x + 0.5, first.y + 0.5);
await page.mouse.click(f2.x, f2.y);
await page.mouse.move(f2.x, f2.y);
await page.mouse.down();
await page.mouse.move(t2.x, t2.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const stillThere = await page.evaluate((id) => window.__fp.project.rooms.find((r) => r.id === id), moved.id);
log('overlapping move rejected?', stillThere.x === moved.x && stillThere.y === moved.y);

// ---- edge resize via drag ----
await page.mouse.click(f2.x, f2.y);
await page.waitForTimeout(100);
const slimRoom = await page.evaluate(() => window.__fp.project.rooms.find((r) => r.x === 10 && r.y === 10));
const slimCenter = await grid(slimRoom.x + 0.5, slimRoom.y + 0.5);
await page.mouse.click(slimCenter.x, slimCenter.y);
const eastEdge = await grid(slimRoom.x + slimRoom.w, slimRoom.y + 1);
const eastTo = await grid(slimRoom.x + slimRoom.w + 1, slimRoom.y + 1);
await page.mouse.move(eastEdge.x, eastEdge.y);
await page.mouse.down();
await page.mouse.move(eastTo.x, eastTo.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
let resized = await page.evaluate((id) => window.__fp.project.rooms.find((r) => r.id === id), slimRoom.id);
log('east edge resize:', `${slimRoom.w} -> ${resized.w}`);
if (resized.w !== slimRoom.w + 1) throw new Error('east edge did not increase room width by one cell');

const westEdge = await grid(resized.x, resized.y + 1);
const westTo = await grid(resized.x - 1, resized.y + 1);
await page.mouse.move(westEdge.x, westEdge.y);
await page.mouse.down();
await page.mouse.move(westTo.x, westTo.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
resized = await page.evaluate((id) => window.__fp.project.rooms.find((r) => r.id === id), slimRoom.id);
log('west edge resize:', `${slimRoom.x} -> ${resized.x}, width ${resized.w}`);
if (resized.x !== slimRoom.x - 1 || resized.w !== slimRoom.w + 2) {
  throw new Error('west edge drag direction is reversed or did not resize by one cell');
}

// ---- delete tool ----
const countBefore = await page.evaluate(() => window.__fp.project.rooms.length);
await page.click('[data-tool="delete"]');
const delPt = await grid(resized.x + 0.5, resized.y + 0.5);
await page.mouse.click(delPt.x, delPt.y);
await page.waitForTimeout(150);
const countAfter = await page.evaluate(() => window.__fp.project.rooms.length);
log('delete tool removed one room?', countBefore - countAfter === 1);
if (countBefore - countAfter !== 1) throw new Error('delete tool failed');

// ---- floor layers and vertical support ----
if ((await page.locator('#fp-floors [data-floor]').count()) !== 1 ||
    !(await page.locator('#fp-add-floor').isVisible()) ||
    !(await page.locator('#fp-add-basement').isVisible())) {
  throw new Error('new projects should start with only 1F and offer Add Floor/Add Basement');
}
if (await page.locator('[data-delete-floor="1"]').count()) {
  throw new Error('1F must never show a delete button, even when it is the only floor');
}
await page.click('[data-tool="edit"]');
await page.click('#fp-pool-toggle');
await page.click('#fp-add-floor');
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'Create room') {
  throw new Error('adding an upper floor should exit 1F-only Pool mode');
}
for (let floor = 3; floor <= 5; floor += 1) {
  await page.click('#fp-add-floor');
  if (!(await page.locator(`[data-floor="${floor}"]`).count())) {
    throw new Error(`Add Floor did not create ${floor}F`);
  }
}
if (await page.locator('#fp-add-floor').count()) {
  throw new Error('Add Floor should disappear after creating 5F');
}
await page.click('#fp-add-basement');
if (!(await page.locator('[data-floor="basement"]').count())) {
  throw new Error('Add Basement did not create Basement');
}
if (await page.locator('#fp-add-basement').count()) {
  throw new Error('Add Basement should disappear after creating Basement');
}
for (const floor of ['2', '3', '4']) {
  if (await page.locator(`[data-delete-floor="${floor}"]`).count()) {
    throw new Error(`Deleting ${floor}F should be unavailable while a higher floor exists`);
  }
}
if (!(await page.locator('[data-delete-floor="5"]').count())) {
  throw new Error('The highest floor should have a delete button');
}
await page.evaluate(() => window.__fp.deleteFloor('2'));
let availableFloors = await page.evaluate(() => Object.keys(window.__fp.project.floors));
if (!availableFloors.includes('2') || !availableFloors.includes('3')) {
  throw new Error('The deleteFloor guard must block deleting a middle floor');
}
await page.click('[data-floor="5"]');
await page.click('[data-delete-floor="5"]');
if (!(await page.locator('.floor-delete-popover').isVisible()) ||
    !(await page.locator('.floor-delete-popover').textContent()).includes('Delete 5F?') ||
    await page.locator('#fp-delete-floor-select').count()) {
  throw new Error('floor delete prompt should confirm the clicked floor directly without a floor selector');
}
await page.click('#fp-cancel-delete-floor');
availableFloors = await page.evaluate(() => Object.keys(window.__fp.project.floors));
if (!availableFloors.includes('5') || !availableFloors.includes('4')) {
  throw new Error('canceling the floor dropdown should keep all floors');
}
await page.click('[data-delete-floor="5"]');
await page.click('#fp-confirm-delete-floor');
availableFloors = await page.evaluate(() => Object.keys(window.__fp.project.floors));
if (availableFloors.includes('5') || !availableFloors.includes('4') || !availableFloors.includes('3')) {
  throw new Error(`deleting 5F should remove only 5F and preserve lower floors: ${availableFloors}`);
}
if (!(await page.locator('[data-delete-floor="4"]').count())) {
  throw new Error('The next highest floor should become deletable after deleting the top floor');
}
if (await page.locator('[data-delete-floor="1"]').count()) {
  throw new Error('1F must not have a delete button');
}
await page.click('#fp-undo');
availableFloors = await page.evaluate(() => Object.keys(window.__fp.project.floors));
if (!availableFloors.includes('5') || await page.locator('[data-floor="5"]').getAttribute('aria-pressed') !== 'true') {
  throw new Error('undo should restore the removed floor and return to it');
}
await page.click('[data-floor="2"]');
await page.click('[data-tool="edit"]');
if (await page.locator('[data-floor="2"]').getAttribute('aria-pressed') !== 'true') {
  throw new Error('2F should become the active floor');
}
await dragCell([15, 30], [16, 31]);
let floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length) throw new Error('2F allowed a room outside the footprint below');
const grayPixel = await page.evaluate(() => {
  const ed = window.__fp;
  const rect = ed.el.canvas.getBoundingClientRect();
  const dpr = ed.el.canvas.width / rect.width;
  const x = Math.round((ed.view.tx + 15.5 * ed.view.scale) * dpr);
  const y = Math.round((ed.view.ty + 30.5 * ed.view.scale) * dpr);
  return Array.from(ed.ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
});
if (grayPixel[0] < 205 || grayPixel[0] > 230 || Math.abs(grayPixel[0] - grayPixel[1]) > 4) {
  throw new Error(`unsupported 2F cell was not gray: ${grayPixel}`);
}
const supportRoom = await page.evaluate(() => window.__fp.project.floors['1'].find((r) =>
  r.w >= 4 && r.h >= 2 && r.x + r.w + 2 <= 18,
));
if (!supportRoom) throw new Error('smoke test requires a 2x2 room on 1F');
const balconyHostStart = [supportRoom.x + 1, supportRoom.y];
await dragCell(balconyHostStart, [balconyHostStart[0] + 1, balconyHostStart[1] + 1]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 1) throw new Error('2F supported room was not created');
const balconyHost = floorState['2'][0];
await page.click('[data-floor="1"]');
const stairRoomPosition = await page.evaluate(() => {
  const ed = window.__fp;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 18; x += 1) {
      const candidate = { id: '__new__', name: 'Stair Room', x, y, w: 4, h: 2, lshape: null, armW: 0, armH: 0 };
      ed.setPreview(candidate);
      if (!ed.preview.ok) continue;
      let overlapsUpperRoom = false;
      overlapsUpperRoom = ed.project.floors['2'].some((room) =>
        x < room.x + room.w && room.x < x + 4 &&
        y < room.y + room.h && room.y < y + 2,
      );
      if (!overlapsUpperRoom) {
        ed.preview = null;
        return { x, y };
      }
    }
  }
  ed.preview = null;
  return null;
});
if (!stairRoomPosition) throw new Error('Smoke test could not find clear space for matching stair rooms');
await dragCell(
  [stairRoomPosition.x, stairRoomPosition.y],
  [stairRoomPosition.x + 3, stairRoomPosition.y + 1],
);
await page.click('[data-floor="2"]');
await dragCell(
  [stairRoomPosition.x, stairRoomPosition.y],
  [stairRoomPosition.x + 3, stairRoomPosition.y + 1],
);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 2) throw new Error('Matching upper-floor room for stairs was not created');
await page.click('[data-floor="1"]');
const stairPlacement = await page.evaluate(() => {
  const ed = window.__fp;
  for (const type of ['narrow', 'compact']) {
    for (const rotated of [false, true]) {
      for (let y = 0; y < 36; y += 1) {
        for (let x = 0; x < 18; x += 1) {
          const candidate = ed.stairCandidateAt(x, y, { type, rotated, lowerFloor: '1' });
          if (ed.validateStairCandidate(candidate).ok) return { x, y, type, rotated };
        }
      }
    }
  }
  return null;
});
if (!stairPlacement) throw new Error('Smoke test could not find a valid stair position between 1F and 2F');
if (!(await page.locator('#fp-stair-toggle').isVisible())) {
  throw new Error('Stair mode should be available when the next floor exists');
}
const actionButtonLayout = await page.evaluate(() => {
  const ids = ['#fp-stair-toggle', '#fp-door-toggle', '#fp-create-toggle'];
  return ids.map((id) => {
    const { x, y, width, height } = document.querySelector(id).getBoundingClientRect();
    return { x, y, width, height };
  });
});
if (actionButtonLayout.some((button) => Math.abs(button.x - actionButtonLayout[0].x) > 1) ||
    !actionButtonLayout.every((button, index) =>
      index === 0 || button.y > actionButtonLayout[index - 1].y,
    )) {
  throw new Error(`Stairs, Door and Create Room should form one vertical stack: ${JSON.stringify(actionButtonLayout)}`);
}
await page.click('#fp-stair-toggle');
if (await page.evaluate(() => window.__fp.placementReferenceFloor) !== '2' ||
    !(await page.locator('#fp-mode-badge').textContent()).includes('2F GHOST')) {
  throw new Error('Stair mode should show a translucent 2F reference overlay');
}
const stairReferenceBorder = await page.evaluate(({ x, y }) => {
  const ed = window.__fp;
  const rect = ed.el.canvas.getBoundingClientRect();
  const dpr = ed.el.canvas.width / rect.width;
  const px = Math.round((ed.view.tx + x * ed.view.scale) * dpr);
  const py = Math.round((ed.view.ty + y * ed.view.scale) * dpr);
  return Array.from(ed.ctx.getImageData(px, py, 1, 1).data).slice(0, 3);
}, { x: supportRoom.x, y: supportRoom.y + 0.5 });
if (!(stairReferenceBorder[1] > stairReferenceBorder[0] * 1.15 &&
      stairReferenceBorder[2] > stairReferenceBorder[0] * 1.1)) {
  throw new Error(`stair reference border should use a distinct teal color: ${stairReferenceBorder}`);
}
await page.locator('#f-stair-type').selectOption(stairPlacement.type);
if (stairPlacement.rotated) await page.click('#f-stair-rotate');
const stairPoint = await grid(stairPlacement.x + 0.5, stairPlacement.y + 0.5);
await page.mouse.click(stairPoint.x, stairPoint.y);
let stairs = await page.evaluate(() => window.__fp.project.stairs);
if (stairs.length !== 1 || stairs[0].x !== stairPlacement.x || stairs[0].y !== stairPlacement.y) {
  throw new Error(`Stairs were not placed in the validated position: ${JSON.stringify(stairs)}`);
}
await page.click('[data-floor="2"]');
await page.click('[data-tool="select"]');
const upperStairPoint = await grid(stairPlacement.x + 0.5, stairPlacement.y + 0.5);
await page.mouse.click(upperStairPoint.x, upperStairPoint.y);
if (!(await page.locator('#fp-props').textContent()).includes('Stairs')) {
  throw new Error('The stair opening should be selectable on the upper floor');
}
await page.click('[data-tool="edit"]');
const openingRoomStart = await grid(stairPlacement.x + 0.5, stairPlacement.y + 0.5);
const openingRoomEnd = await grid(stairPlacement.x + 1.5, stairPlacement.y + 1.5);
await page.mouse.move(openingRoomStart.x, openingRoomStart.y);
await page.mouse.down();
await page.mouse.move(openingRoomEnd.x, openingRoomEnd.y, { steps: 6 });
const openingRoomPreview = await page.evaluate(() => window.__fp.preview);
if (openingRoomPreview?.ok) throw new Error('Moving the upper stair room must not invalidate the stairs');
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 2) throw new Error('The upper-floor rooms should remain intact around the stair opening');
await page.click('#fp-stair-toggle');
if (!(await page.locator('#fp-mezzanine-toggle').isVisible())) {
  throw new Error('Mezzanine button should be visible on 2F');
}
const mezzanineButtonLayout = await page.evaluate(() => {
  const ids = ['#fp-mezzanine-toggle', '#fp-stair-toggle', '#fp-door-toggle', '#fp-create-toggle'];
  return ids.map((id) => {
    const { x, y } = document.querySelector(id).getBoundingClientRect();
    return { x, y };
  });
});
if (mezzanineButtonLayout.some((button) => Math.abs(button.x - mezzanineButtonLayout[0].x) > 1) ||
    !mezzanineButtonLayout.every((button, index) =>
      index === 0 || button.y > mezzanineButtonLayout[index - 1].y,
    )) {
  throw new Error(`Mezzanine, Stairs, Door and Create Room should form one vertical stack: ${JSON.stringify(mezzanineButtonLayout)}`);
}
const mezzaninePlacement = await page.evaluate((room) => {
  const ed = window.__fp;
  for (let y = room.y; y < room.y + room.h; y += 1) {
    for (let x = room.x; x < room.x + room.w - 1; x += 1) {
      const candidate = ed.mezzanineCandidateAt(x, y, 1, 2);
      const expanded = { ...candidate, w: 2 };
      if (ed.validateMezzanineCandidate(candidate).ok &&
          ed.validateMezzanineCandidate(expanded).ok) return candidate;
    }
  }
  return null;
}, supportRoom);
if (!mezzaninePlacement) throw new Error('Smoke test could not find a valid mezzanine position');
const oneCellMezzanine = await page.evaluate((position) => {
  const ed = window.__fp;
  return ed.validateMezzanineCandidate(
    ed.mezzanineCandidateAt(position.x, position.y, 1, 1),
  );
}, mezzaninePlacement);
if (oneCellMezzanine.ok) throw new Error('1x1 mezzanine should be rejected');
await page.click('#fp-mezzanine-toggle');
if (await page.evaluate(() => window.__fp.placementReferenceFloor) !== '1' ||
    !(await page.locator('#fp-mode-badge').textContent()).includes('1F GHOST')) {
  throw new Error('Mezzanine mode should show a translucent 1F reference overlay');
}
const mezzanineReferenceBorder = await page.evaluate(() => {
  const ed = window.__fp;
  const { data } = ed.ctx.getImageData(0, 0, ed.el.canvas.width, ed.el.canvas.height);
  let purplePixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 100 && data[i + 2] > 150 && data[i + 1] < 160) purplePixels += 1;
  }
  return purplePixels;
});
if (!mezzanineReferenceBorder) {
  throw new Error('mezzanine reference border should use a distinct purple color');
}
const mezzStart = await grid(mezzaninePlacement.x + 0.5, mezzaninePlacement.y + 0.5);
const mezzEnd = await grid(mezzaninePlacement.x + 0.5, mezzaninePlacement.y + 1.5);
await page.mouse.move(mezzStart.x, mezzStart.y);
await page.mouse.down();
await page.mouse.move(mezzEnd.x, mezzEnd.y, { steps: 4 });
const mezzaninePreview = await page.evaluate(() => window.__fp.preview);
if (!mezzaninePreview?.ok) throw new Error(`valid mezzanine preview rejected: ${JSON.stringify(mezzaninePreview)}`);
await page.mouse.up();
let mezzanineState = await page.evaluate(() => window.__fp.project.mezzanines);
if (mezzanineState['2'].length !== 1) throw new Error('mezzanine was not created');
await page.click('[data-tool="select"]');
const mezzCenter = await grid(mezzaninePlacement.x + 0.5, mezzaninePlacement.y + 0.5);
await page.mouse.move(mezzCenter.x, mezzCenter.y);
await page.mouse.down();
await page.mouse.move(mezzCenter.x + (await page.evaluate(() => window.__fp.view.scale)), mezzCenter.y, { steps: 4 });
await page.mouse.up();
mezzanineState = await page.evaluate(() => window.__fp.project.mezzanines);
if (mezzanineState['2'][0].x !== mezzaninePlacement.x + 1) {
  throw new Error('mezzanine should be movable in Select mode');
}
const mezzWestHandle = await grid(mezzanineState['2'][0].x, mezzanineState['2'][0].y + 0.5);
await page.mouse.move(mezzWestHandle.x, mezzWestHandle.y);
await page.mouse.down();
await page.mouse.move(mezzWestHandle.x - (await page.evaluate(() => window.__fp.view.scale)), mezzWestHandle.y, { steps: 4 });
await page.mouse.up();
mezzanineState = await page.evaluate(() => window.__fp.project.mezzanines);
if (mezzanineState['2'][0].w !== 2 || mezzanineState['2'][0].x !== mezzaninePlacement.x) {
  throw new Error('mezzanine should be resizable in Select mode');
}
await page.click('[data-tool="edit"]');
await page.click('#fp-stair-toggle');
if (!(await page.locator('#fp-balcony-toggle').isVisible())) {
  throw new Error('dedicated balcony button should be visible on 2F');
}
await page.click('#fp-balcony-toggle');
if ((await page.locator('#fp-balcony-toggle').getAttribute('aria-pressed')) !== 'true') {
  throw new Error('balcony button did not activate balcony mode');
}
const oneCellBalconyPoint = await grid(supportRoom.x + 0.5, supportRoom.y + 0.5);
await page.mouse.move(oneCellBalconyPoint.x, oneCellBalconyPoint.y);
await page.mouse.down();
await page.mouse.move(oneCellBalconyPoint.x + 1, oneCellBalconyPoint.y + 1);
const oneCellBalconyPreview = await page.evaluate(() => window.__fp.preview);
if (oneCellBalconyPreview?.ok || !oneCellBalconyPreview?.message?.includes('1 × 1 balcony')) {
  throw new Error(`a 1x1 balcony should be rejected: ${JSON.stringify(oneCellBalconyPreview)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'].length) throw new Error('a 1x1 balcony should not be created');
const balconyX = supportRoom.x + supportRoom.w;
const balconyY = supportRoom.y;
const overDepthStart = await grid(balconyX + 0.5, balconyY + 0.5);
const overDepthEnd = await grid(balconyX + 3.5, balconyY + 0.5);
await page.mouse.move(overDepthStart.x, overDepthStart.y);
await page.mouse.down();
await page.mouse.move(overDepthEnd.x, overDepthEnd.y, { steps: 6 });
const fourthGrayPreview = await page.evaluate(() => window.__fp.preview);
if (fourthGrayPreview?.ok) {
  throw new Error(`balcony preview should turn invalid after the fourth gray cell: ${JSON.stringify(fourthGrayPreview.candidate)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'].length) throw new Error('balcony depth over 3 cells should be rejected');
const balconyStart = await grid(balconyX + 0.5, balconyY + 0.5);
const balconyEnd = await grid(balconyX + 2.5, balconyY + 0.5);
await page.mouse.move(balconyStart.x, balconyStart.y);
await page.mouse.down();
await page.mouse.move(balconyEnd.x, balconyEnd.y, { steps: 6 });
const threeGrayPreview = await page.evaluate(() => window.__fp.preview);
if (!threeGrayPreview?.ok) {
  throw new Error(`balcony preview should remain valid through the third gray cell: ${threeGrayPreview?.message}; candidate=${JSON.stringify(threeGrayPreview?.candidate)}; host=${JSON.stringify(balconyHost)}; support=${JSON.stringify(supportRoom)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'].length !== 1 || floorState['2'][0].w !== 3 || floorState['2'][0].h !== 1) {
  throw new Error(`balcony with up to 3 gray cells beyond supported area was not created: ${JSON.stringify(floorState['2'])}`);
}
const balconyFootprint = floorState['2'][0];
if (!(await page.locator('#fp-props').textContent()).includes('Balcony Properties')) {
  throw new Error('created balcony should be selected with its properties shown');
}
const invalidResizeStart = await grid(balconyFootprint.x + balconyFootprint.w, balconyFootprint.y + 0.5);
const invalidResizeEnd = await grid(balconyFootprint.x + balconyFootprint.w + 1, balconyFootprint.y + 0.5);
await page.mouse.move(invalidResizeStart.x, invalidResizeStart.y);
await page.mouse.down();
await page.mouse.move(invalidResizeEnd.x, invalidResizeEnd.y, { steps: 6 });
const invalidBalconyResizePreview = await page.evaluate(() => window.__fp.preview);
if (invalidBalconyResizePreview?.ok || !invalidBalconyResizePreview?.message?.includes('more than 3 grid cells')) {
  throw new Error(`resizing should reject a gray cell more than 3 grid cells from support: ${JSON.stringify(invalidBalconyResizePreview)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].w !== 3) {
  throw new Error(`invalid resize changed the balcony despite exceeding the gray-cell limit: ${JSON.stringify(floorState['2'][0])}`);
}
const widthStart = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + balconyFootprint.h);
const widthEnd = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + balconyFootprint.h + 3);
await page.mouse.move(widthStart.x, widthStart.y);
await page.mouse.down();
await page.mouse.move(widthEnd.x, widthEnd.y, { steps: 6 });
const widerBalconyPreview = await page.evaluate(() => window.__fp.preview);
if (!widerBalconyPreview?.ok) {
  throw new Error(`a balcony wider than 3 cells should be allowed when its gray cells remain within 3 cells of support: ${JSON.stringify(widerBalconyPreview)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].h !== 4) {
  throw new Error(`balcony width greater than 3 cells was not saved: ${JSON.stringify(floorState['2'][0])}`);
}
const tooWideStart = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + 4);
const tooWideEnd = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + 6);
await page.mouse.move(tooWideStart.x, tooWideStart.y);
await page.mouse.down();
await page.mouse.move(tooWideEnd.x, tooWideEnd.y, { steps: 6 });
const tooWidePreview = await page.evaluate(() => window.__fp.preview);
if (tooWidePreview?.ok || !tooWidePreview?.message?.includes('more than 3 grid cells')) {
  throw new Error(`a balcony cell beyond 3 grid cells from support should be rejected: ${JSON.stringify(tooWidePreview)}`);
}
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].h !== 4) throw new Error('an invalid width edit changed the balcony');
const widthRestoreStart = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + 4);
const widthRestoreEnd = await grid(balconyFootprint.x + balconyFootprint.w / 2, balconyFootprint.y + 1);
await page.mouse.move(widthRestoreStart.x, widthRestoreStart.y);
await page.mouse.down();
await page.mouse.move(widthRestoreEnd.x, widthRestoreEnd.y, { steps: 6 });
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].h !== 1) throw new Error('balcony width should be restored to its original size');
const balconyResizeStart = await grid(balconyFootprint.x + balconyFootprint.w, balconyFootprint.y + 0.5);
const balconyResizeEnd = await grid(balconyFootprint.x + balconyFootprint.w - 1, balconyFootprint.y + 0.5);
await page.mouse.move(balconyResizeStart.x, balconyResizeStart.y);
await page.mouse.down();
await page.mouse.move(balconyResizeEnd.x, balconyResizeEnd.y, { steps: 6 });
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].w !== 2) throw new Error(`balcony outer edge was not resizable: ${JSON.stringify(floorState['2'][0])}`);
const balconyResized = floorState['2'][0];
const balconyRestoreStart = await grid(balconyResized.x + balconyResized.w, balconyResized.y + 0.5);
const balconyRestoreEnd = await grid(balconyResized.x + balconyResized.w + 1, balconyResized.y + 0.5);
await page.mouse.move(balconyRestoreStart.x, balconyRestoreStart.y);
await page.mouse.down();
await page.mouse.move(balconyRestoreEnd.x, balconyRestoreEnd.y, { steps: 6 });
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].w !== 3) throw new Error('balcony resize should restore its original width');
await page.click('[data-tool="select"]');
if (await page.locator('#fp-balcony-toggle').isVisible()) {
  throw new Error('Balcony tool button should be hidden in Select mode');
}
const selectBalcony = floorState['2'][0];
await dragCell(
  [selectBalcony.x, selectBalcony.y],
  [selectBalcony.x, selectBalcony.y + 1],
);
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].y !== selectBalcony.y + 1) {
  throw new Error(`Select mode should move a balcony: ${JSON.stringify(floorState['2'][0])}`);
}
const selectBalconyResizeStart = await grid(
  floorState['2'][0].x + floorState['2'][0].w,
  floorState['2'][0].y + 0.5,
);
const selectBalconyResizeEnd = await grid(
  floorState['2'][0].x + floorState['2'][0].w - 1,
  floorState['2'][0].y + 0.5,
);
await page.mouse.move(selectBalconyResizeStart.x, selectBalconyResizeStart.y);
await page.mouse.down();
await page.mouse.move(selectBalconyResizeEnd.x, selectBalconyResizeEnd.y, { steps: 6 });
await page.mouse.up();
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].w !== 2) {
  throw new Error(`Select mode should resize a balcony: ${JSON.stringify(floorState['2'][0])}`);
}
await page.click('#fp-undo');
await page.click('#fp-undo');
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'][0].w !== 3 || floorState['2'][0].y !== selectBalcony.y) {
  throw new Error('Undo should restore the balcony after Select-mode move and resize');
}
await page.click('[data-tool="edit"]');
const editedBalcony = floorState['2'][0];
await page.waitForTimeout(100);
const balconyPixel = await page.evaluate(({ x, y }) => {
  const ed = window.__fp;
  const rect = ed.el.canvas.getBoundingClientRect();
  const dpr = ed.el.canvas.width / rect.width;
  const px = Math.round((ed.view.tx + x * ed.view.scale) * dpr);
  const py = Math.round((ed.view.ty + y * ed.view.scale) * dpr);
  return Array.from(ed.ctx.getImageData(px, py, 1, 1).data).slice(0, 3);
}, { x: editedBalcony.x + 0.5, y: editedBalcony.y + 0.5 });
if (balconyPixel[0] < 230 || balconyPixel[1] < 190 || balconyPixel[2] > 210) {
  throw new Error(`balcony cells should be displayed with a distinct color: ${balconyPixel}`);
}
await page.click('[data-tool="delete"]');
const balconyCenter = await grid(editedBalcony.x + editedBalcony.w / 2, editedBalcony.y + editedBalcony.h / 2);
await page.mouse.click(balconyCenter.x, balconyCenter.y);
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'].length !== 0) throw new Error('Delete mode should remove a balcony');
await page.click('#fp-undo');
floorState = await page.evaluate(() => window.__fp.project.balconies);
if (floorState['2'].length !== 1) throw new Error('undo should restore a deleted balcony');
await page.click('[data-tool="edit"]');
await page.click('[data-floor="3"]');
await page.click('[data-tool="edit"]');
await dragCell([supportRoom.x, supportRoom.y], [supportRoom.x + 1, supportRoom.y + 1]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['3'].length !== 1) throw new Error('3F room should be supported directly by 1F, even without a 2F room');
await dragCell([balconyFootprint.x, balconyFootprint.y], [balconyFootprint.x + 1, balconyFootprint.y]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['3'].length !== 1) throw new Error('3F should not allow rooms on cells covered by a 2F balcony');
const balconyBlockedPixel = await page.evaluate(({ x, y }) => {
  const ed = window.__fp;
  const rect = ed.el.canvas.getBoundingClientRect();
  const dpr = ed.el.canvas.width / rect.width;
  const px = Math.round((ed.view.tx + x * ed.view.scale) * dpr);
  const py = Math.round((ed.view.ty + y * ed.view.scale) * dpr);
  return Array.from(ed.ctx.getImageData(px, py, 1, 1).data).slice(0, 3);
}, { x: balconyFootprint.x + 0.5, y: balconyFootprint.y + 0.5 });
if (balconyBlockedPixel[0] < 205 || balconyBlockedPixel[0] > 230 ||
    Math.abs(balconyBlockedPixel[0] - balconyBlockedPixel[1]) > 4) {
  throw new Error(`2F balcony cells should be gray on 3F: ${balconyBlockedPixel}`);
}
if (!(await page.locator('#fp-balcony-toggle').isVisible())) {
  throw new Error('3F should also offer the separate Balcony button');
}
if (await page.locator('#fp-patio-toggle').isVisible()) {
  throw new Error('Patio button should only appear on 1F');
}
for (const floor of ['4', '5']) {
  await page.click(`[data-floor="${floor}"]`);
  await page.click('[data-tool="edit"]');
  await dragCell([supportRoom.x, supportRoom.y], [supportRoom.x + 1, supportRoom.y + 1]);
  floorState = await page.evaluate(() => window.__fp.project.floors);
  if (floorState[floor].length !== 1) throw new Error(`${floor}F should block room placement on lower-floor balcony cells`);
  await dragCell([balconyFootprint.x, balconyFootprint.y], [balconyFootprint.x + 1, balconyFootprint.y]);
  floorState = await page.evaluate(() => window.__fp.project.floors);
  if (floorState[floor].length !== 1) throw new Error(`${floor}F should not allow room creation over a 2F balcony`);
}
if ((await page.locator('#fp-floors [data-floor]').count()) !== 6) {
  throw new Error('floor selector should contain Basement and exactly five above-ground floors');
}
const upperRoomIds = await page.evaluate(() => Object.fromEntries(
 ['3', '4', '5'].map((floor) => [floor, window.__fp.project.floors[floor].map((room) => room.id)]),
));
await page.click('[data-floor="2"]');
const mezzanineToRemove = await page.evaluate(() => window.__fp.project.mezzanines['2'][0]);
const protectedMezzanineRoom = await page.evaluate((mezzanine) => {
  const ed = window.__fp;
  const host = ed.roomAt(mezzanine.x + 0.5, mezzanine.y + 0.5);
  if (!host) return null;
  const before = ed.rooms.length;
  const applied = ed.applyRooms(
    ed.rooms.filter((room) => room.id !== host.id),
    'Attempt to remove mezzanine room',
  );
  return { applied, before, after: ed.rooms.length };
}, mezzanineToRemove);
if (!protectedMezzanineRoom || protectedMezzanineRoom.applied ||
    protectedMezzanineRoom.before !== protectedMezzanineRoom.after) {
  throw new Error('removing a room containing a mezzanine should be blocked');
}
const mezzanineDeletePoint = await grid(
  mezzanineToRemove.x + mezzanineToRemove.w / 2,
  mezzanineToRemove.y + mezzanineToRemove.h / 2,
);
await page.click('[data-tool="delete"]');
await page.mouse.click(mezzanineDeletePoint.x, mezzanineDeletePoint.y);
if ((await page.evaluate(() => window.__fp.project.mezzanines['2'].length)) !== 0) {
  throw new Error('mezzanine should be deletable before removing its host room');
}
await page.click('[data-tool="delete"]');
const secondFloorRoom = await page.evaluate((id) =>
  window.__fp.project.floors['2'].find((room) => room.id === id),
  balconyHost.id,
);
const secondFloorRoomPoint = await grid(secondFloorRoom.x + 0.5, secondFloorRoom.y + 0.5);
await page.mouse.click(secondFloorRoomPoint.x, secondFloorRoomPoint.y);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 1 || floorState['2'][0].id === balconyHost.id) {
  throw new Error('Unrelated 2F room could not be deleted while preserving the stair room');
}
let balconyState = await page.evaluate(() => window.__fp.project.balconies);
if (balconyState['2'].length !== 1) throw new Error('a balcony should remain when an unrelated room is deleted');
for (const floor of ['3', '4', '5']) {
  const remainingIds = floorState[floor].map((room) => room.id);
  if (remainingIds.join(',') !== upperRoomIds[floor].join(',')) {
    throw new Error(`${floor}F rooms should remain after deleting a 2F room`);
  }
}
await page.click('#fp-undo');
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 2 || floorState['3'].length !== upperRoomIds['3'].length) {
  throw new Error('undo should restore the deleted 2F room while keeping the upper floors');
}
await page.click('#fp-redo');
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 1 || floorState['3'].length !== upperRoomIds['3'].length) {
  throw new Error('redo should delete only the 2F room and keep upper floors');
}
await page.click('#fp-undo');
await page.click('[data-floor="1"]');
await page.click('[data-tool="delete"]');
const supportCenter = await grid(supportRoom.x + 0.5, supportRoom.y + 0.5);
await page.mouse.click(supportCenter.x, supportCenter.y);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (!floorState['1'].some((r) => r.id === supportRoom.id)) {
  throw new Error('1F allowed deletion of a room supporting a room above');
}
if (await page.locator('#fp-pool-toggle').isVisible()) throw new Error('pool button should hide in Delete mode');
if (await page.locator('#fp-patio-toggle').isVisible()) throw new Error('Patio button should hide in Delete mode');
await page.click('[data-floor="2"]');
await page.click('#fp-redo');
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['2'].length !== 1 || floorState['3'].length !== upperRoomIds['3'].length) {
  throw new Error('redo after switching floors should still keep the higher floors');
}
await page.click('#fp-undo');
balconyState = await page.evaluate(() => window.__fp.project.balconies);
if (balconyState['2'].length !== 1) throw new Error('undo should restore the 2F balcony with its host room');
await page.click('[data-tool="edit"]');
await page.click('#fp-mezzanine-toggle');
const persistedMezzaninePlacement = await page.evaluate(() => {
  const ed = window.__fp;
  for (const room of ed.rooms) {
    for (let y = room.y; y < room.y + room.h - 1; y += 1) {
      for (let x = room.x; x < room.x + room.w; x += 1) {
        const candidate = ed.mezzanineCandidateAt(x, y, 1, 2);
        if (ed.validateMezzanineCandidate(candidate).ok) return candidate;
      }
    }
  }
  return null;
});
if (!persistedMezzaninePlacement) throw new Error('could not restore a valid mezzanine for the persistence test');
await dragCell(
  [persistedMezzaninePlacement.x, persistedMezzaninePlacement.y],
  [persistedMezzaninePlacement.x, persistedMezzaninePlacement.y + 1],
);
if ((await page.evaluate(() => window.__fp.project.mezzanines['2'].length)) !== 1) {
  throw new Error('valid mezzanine should be placeable after room deletion is undone');
}
await page.click('#fp-mezzanine-toggle');
await page.click('[data-floor="basement"]');
await page.click('[data-tool="edit"]');
await dragCell([15, 30], [16, 31]);
await dragCell([supportRoom.x, supportRoom.y], [supportRoom.x + 1, supportRoom.y + 1]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState.basement.length !== 2) throw new Error('basement should allow rooms without support');
await page.click('[data-floor="1"]');
if (!(await page.locator('#fp-mezzanine-toggle').isVisible())) {
  throw new Error('1F should offer Mezzanine mode when Basement exists');
}
await page.click('#fp-mezzanine-toggle');
if (await page.evaluate(() => window.__fp.lowerMezzanineFloor) !== 'basement' ||
    !(await page.locator('#fp-mode-badge').textContent()).includes('BASEMENT GHOST')) {
  throw new Error('1F mezzanine mode should use Basement as its translucent support floor');
}
const basementMezzanineCandidate = await page.evaluate((room) => {
  const ed = window.__fp;
  for (let y = room.y; y < room.y + room.h - 1; y += 1) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      const candidate = ed.mezzanineCandidateAt(x, y, 1, 2);
      if (ed.validateMezzanineCandidate(candidate).ok) return candidate;
    }
  }
  return null;
}, supportRoom);
if (!basementMezzanineCandidate) throw new Error('1F mezzanine should fit in the 1F and Basement rooms');
const basementMezzanineOneCell = await page.evaluate((candidate) => {
  const ed = window.__fp;
  return ed.validateMezzanineCandidate({
    ...candidate,
    w: 1,
    h: 1,
  });
}, basementMezzanineCandidate);
if (basementMezzanineOneCell.ok) throw new Error('1F 1x1 mezzanine should be rejected');
await dragCell(
  [basementMezzanineCandidate.x, basementMezzanineCandidate.y],
  [basementMezzanineCandidate.x, basementMezzanineCandidate.y + 1],
);
if ((await page.evaluate(() => window.__fp.project.mezzanines['1'].length)) !== 1) {
  throw new Error('1F mezzanine supported by Basement was not created');
}
await page.click('#fp-mezzanine-toggle');

// ---- pools block their core and one-cell outer ring in the Basement ----
await page.click('[data-tool="edit"]');
if (!(await page.locator('#fp-patio-toggle').isVisible())) {
  throw new Error('Patio button should be available on 1F in Edit mode');
}
await page.click('#fp-patio-toggle');
await dragCell([14, 30], [15, 31]);
let patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1 || patios[0].w !== 2 || patios[0].h !== 2) {
  throw new Error(`Patio drag should create a 2x2 patio: ${JSON.stringify(patios)}`);
}
if (!(await page.locator('#fp-props').textContent()).includes('Patio Properties')) {
  throw new Error('Created patio should show Patio Properties');
}
const targetRoom = await page.evaluate(() => window.__fp.project.floors['1'][0]);
const patioMoveStart = await grid(patios[0].x + 0.5, patios[0].y + 0.5);
const patioMoveTarget = await grid(targetRoom.x + 0.5, targetRoom.y + 0.5);
await page.mouse.move(patioMoveStart.x, patioMoveStart.y);
await page.mouse.down();
await page.mouse.move(patioMoveTarget.x, patioMoveTarget.y);
const roomOverPatioPreview = await page.evaluate(() => window.__fp.preview);
if (roomOverPatioPreview?.ok ||
    !roomOverPatioPreview?.message?.includes('Patio cannot overlap a room')) {
  throw new Error(`Patio preview should reject overlap with a room: ${JSON.stringify(roomOverPatioPreview)}`);
}
await page.mouse.up();
const roomCountBeforePatioOverlap = await page.evaluate(() => window.__fp.project.floors['1'].length);
await page.click('#fp-create-toggle');
await dragCell([patios[0].x, patios[0].y], [patios[0].x + 1, patios[0].y + 1]);
const roomCountAfterPatioOverlap = await page.evaluate(() => window.__fp.project.floors['1'].length);
if (roomCountAfterPatioOverlap !== roomCountBeforePatioOverlap) {
  throw new Error('A room should not be created over a patio');
}
await page.click('[data-tool="select"]');
if (await page.locator('#fp-patio-toggle').isVisible()) {
  throw new Error('Patio tool button should be hidden in Select mode');
}
await dragCell([patios[0].x, patios[0].y], [12, patios[0].y]);
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios[0].x !== 12 || patios[0].y !== 30) {
  throw new Error(`An existing patio should be movable after switching modes: ${JSON.stringify(patios[0])}`);
}
const patioResizeStart = await grid(patios[0].x + patios[0].w, patios[0].y + 0.5);
const patioResizeEnd = await grid(patios[0].x + patios[0].w + 1, patios[0].y + 0.5);
await page.mouse.move(patioResizeStart.x, patioResizeStart.y);
await page.mouse.down();
await page.mouse.move(patioResizeEnd.x, patioResizeEnd.y, { steps: 6 });
await page.mouse.up();
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios[0].w !== 3 || patios[0].h !== 2) {
  throw new Error(`An existing patio should be resizable after switching modes: ${JSON.stringify(patios[0])}`);
}
await page.click('#fp-undo');
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1 || patios[0].w !== 2) throw new Error('Undo should restore the patio before its resize');
await page.click('#fp-redo');
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1 || patios[0].w !== 3) throw new Error('Redo should restore the patio resize');
await page.click('#fp-undo');
await page.click('#fp-undo');
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1 || patios[0].x !== 14) throw new Error('Undo should restore the patio original position');
await page.click('#fp-redo');
await page.click('#fp-redo');
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1 || patios[0].x !== 12 || patios[0].w !== 3) {
  throw new Error('Redo should restore patio move and resize');
}
await page.click('[data-tool="edit"]');
await page.click('#fp-patio-toggle');
if (!(await page.locator('#fp-pool-toggle').isVisible())) throw new Error('pool button should be available on 1F');
await page.click('#fp-patio-toggle');
await page.click('#fp-pool-toggle');
let poolPosition = await page.evaluate(() => {
  const project = window.__fp.project;
  const lot = { w: 18, h: 36 };
  const allRooms = [...project.floors['1'], ...project.floors.basement];
  for (let y = 1; y < lot.h - 3; y += 1) {
    for (let x = 1; x < lot.w - 6; x += 1) {
      const outer = { x: x - 1, y: y - 1, w: 7, h: 5 };
      if (allRooms.some((room) =>
        room.x < outer.x + outer.w && outer.x < room.x + room.w &&
        room.y < outer.y + outer.h && outer.y < room.y + room.h
      )) continue;
      if (project.patios.some((patio) =>
        patio.x < outer.x + outer.w && outer.x < patio.x + patio.w &&
        patio.y < outer.y + outer.h && outer.y < patio.y + patio.h
      )) continue;
      return { x, y };
    }
  }
  return null;
});
if (!poolPosition) throw new Error('smoke test could not find a clear 5x5 pool footprint');
await dragCell([poolPosition.x, poolPosition.y], [poolPosition.x + 2, poolPosition.y + 2]);
let pools = await page.evaluate(() => window.__fp.project.pools);
if (pools.length !== 1 || pools[0].w !== 3 || pools[0].h !== 3) {
  throw new Error(`pool core should be created as a 3x3 rectangle: ${JSON.stringify(pools)}`);
}
if (!(await page.locator('#fp-props').textContent()).includes('Pool Properties')) {
  throw new Error('created pool should show its properties');
}
await page.click('#fp-undo');
pools = await page.evaluate(() => window.__fp.project.pools);
if (pools.length !== 0) throw new Error('undo should remove the created pool');
await page.click('#fp-redo');
pools = await page.evaluate(() => window.__fp.project.pools);
if (pools.length !== 1) throw new Error('redo should restore the created pool');
await page.click('#fp-patio-toggle');
const poolRingPoint = await grid(pools[0].x - 0.5, pools[0].y + 0.5);
await page.mouse.move(poolRingPoint.x, poolRingPoint.y);
await page.mouse.down();
await page.mouse.move(poolRingPoint.x, poolRingPoint.y);
const patioOverPoolPreview = await page.evaluate(() => window.__fp.preview);
if (patioOverPoolPreview?.ok ||
    !patioOverPoolPreview?.message?.includes('cannot overlap a pool core or its outer ring')) {
  throw new Error(`Patio preview should reject pool outer-ring overlap: ${JSON.stringify(patioOverPoolPreview)}`);
}
await page.mouse.up();
patios = await page.evaluate(() => window.__fp.project.patios);
if (patios.length !== 1) throw new Error('Patio overlapping a pool ring should not be created');
await page.click('[data-tool="select"]');
if (await page.locator('#fp-pool-toggle').isVisible()) {
  throw new Error('Pool tool button should be hidden in Select mode');
}
await dragCell(
  [poolPosition.x + 1, poolPosition.y + 1],
  [poolPosition.x + 2, poolPosition.y + 1],
);
pools = await page.evaluate(() => window.__fp.project.pools);
if (pools[0].x !== poolPosition.x + 1) throw new Error('Select mode should allow moving a pool');
poolPosition = { ...poolPosition, x: poolPosition.x + 1 };
const poolEastEdge = await grid(poolPosition.x + 3, poolPosition.y + 1.5);
const poolEastExpanded = await grid(poolPosition.x + 4, poolPosition.y + 1.5);
await page.mouse.move(poolEastEdge.x, poolEastEdge.y);
await page.mouse.down();
await page.mouse.move(poolEastExpanded.x, poolEastExpanded.y, { steps: 6 });
await page.mouse.up();
pools = await page.evaluate(() => window.__fp.project.pools);
if (pools[0].w !== 4 || pools[0].h !== 3) {
  throw new Error(`Select mode should resize the pool core while preserving its ring: ${JSON.stringify(pools[0])}`);
}
await page.click('[data-tool="edit"]');
await page.click('#fp-create-toggle');
const oneFloorRoomCount = await page.evaluate(() => window.__fp.project.floors['1'].length);
await dragCell([poolPosition.x, poolPosition.y], [poolPosition.x + 1, poolPosition.y + 1]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState['1'].length !== oneFloorRoomCount) throw new Error('1F allowed a room to overlap a pool footprint');
await page.click('#fp-pool-toggle');

// ---- doors are placed along exterior or shared room walls ----
if (!(await page.locator('#fp-door-toggle').isVisible())) {
  throw new Error('Door tool should be available on every floor in Edit mode');
}
await page.click('#fp-door-toggle');
const doorPlacement = await page.evaluate(() => {
  const ed = window.__fp;
  const sideHasWallCell = (room, orientation, x, y, offset) => {
    if (orientation === 'horizontal') {
      const before = ed.roomAt(x + offset + 0.5, y - 0.5);
      const after = ed.roomAt(x + offset + 0.5, y + 0.5);
      return !(before?.id === room.id && after?.id === room.id) && (before || after);
    }
    const before = ed.roomAt(x - 0.5, y + offset + 0.5);
    const after = ed.roomAt(x + 0.5, y + offset + 0.5);
    return !(before?.id === room.id && after?.id === room.id) && (before || after);
  };
  for (const room of ed.rooms) {
    for (const y of [room.y, room.y + room.h]) {
      for (let x = room.x; x <= room.x + room.w - 4; x += 1) {
        if ([0, 1, 2, 3].every((offset) => sideHasWallCell(room, 'horizontal', x, y, offset))) {
          return { orientation: 'horizontal', x, y, length: 4 };
        }
      }
    }
    for (const x of [room.x, room.x + room.w]) {
      for (let y = room.y; y <= room.y + room.h - 4; y += 1) {
        if ([0, 1, 2, 3].every((offset) => sideHasWallCell(room, 'vertical', x, y, offset))) {
          return { orientation: 'vertical', x, y, length: 4 };
        }
      }
    }
  }
  return null;
});
if (!doorPlacement) throw new Error('Smoke test could not find a four-cell room wall for a door');
const doorStart = doorPlacement.orientation === 'horizontal'
  ? await grid(doorPlacement.x + 0.5, doorPlacement.y)
  : await grid(doorPlacement.x, doorPlacement.y + 0.5);
const doorEnd = doorPlacement.orientation === 'horizontal'
  ? await grid(doorPlacement.x + 3.5, doorPlacement.y)
  : await grid(doorPlacement.x, doorPlacement.y + 3.5);
await page.mouse.move(doorStart.x, doorStart.y);
await page.mouse.down();
await page.mouse.move(doorEnd.x, doorEnd.y, { steps: 8 });
const doorPreview = await page.evaluate(() => window.__fp.preview);
if (!doorPreview?.ok || doorPreview?.candidate?.length !== 4) {
  throw new Error(`Four-cell door preview should be valid: ${JSON.stringify(doorPreview)}`);
}
await page.mouse.up();
let doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors.length !== 1 || doors[0].length !== 4 || doors[0].orientation !== doorPlacement.orientation) {
  throw new Error(`Door drag should place a four-cell door: ${JSON.stringify(doors)}`);
}
await page.click('[data-tool="select"]');
await page.locator('#f-door-length').fill('3');
await page.locator('#f-door-length').press('Tab');
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors[0].length !== 3) throw new Error('Select mode properties should resize a door');
await page.click('#fp-undo');
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors[0].length !== 4) throw new Error('Undo should restore the door width changed in properties');
await page.click('#fp-redo');
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors[0].length !== 3) throw new Error('Redo should restore the door width changed in properties');
const doorResizeStart = doors[0].orientation === 'horizontal'
  ? await grid(doors[0].x + doors[0].length - 0.5, doors[0].y)
  : await grid(doors[0].x, doors[0].y + doors[0].length - 0.5);
const doorResizeEnd = doors[0].orientation === 'horizontal'
  ? await grid(doors[0].x + 1.5, doors[0].y)
  : await grid(doors[0].x, doors[0].y + 1.5);
await page.mouse.move(doorResizeStart.x, doorResizeStart.y);
await page.mouse.down();
await page.mouse.move(doorResizeEnd.x, doorResizeEnd.y, { steps: 6 });
await page.mouse.up();
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors[0].length !== 2) throw new Error(`Select mode should resize a door: ${JSON.stringify(doors[0])}`);
await page.click('#fp-undo');
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors[0].length !== 3) throw new Error('Undo should restore the three-cell door');
await page.click('[data-tool="delete"]');
const doorCenter = doors[0].orientation === 'horizontal'
  ? await grid(doors[0].x + 0.5, doors[0].y)
  : await grid(doors[0].x, doors[0].y + 0.5);
await page.mouse.click(doorCenter.x, doorCenter.y);
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors.length) throw new Error('Delete mode should remove a door');
await page.click('#fp-undo');
doors = await page.evaluate(() => window.__fp.project.doors['1']);
if (doors.length !== 1 || doors[0].length !== 3) throw new Error('Undo should restore a deleted door');

await page.click('[data-floor="basement"]');
const basementRoomCountBeforePoolAttempt = await page.evaluate(() => window.__fp.project.floors.basement.length);
if (await page.locator('#fp-pool-toggle').isVisible()) {
  throw new Error('pool mode should end automatically when switching to Basement');
}
if ((await page.locator('#fp-create-toggle').getAttribute('aria-label')) !== 'Create room') {
  throw new Error('switching floors should return to Create Room mode');
}
await dragCell([poolPosition.x, poolPosition.y], [poolPosition.x + 1, poolPosition.y + 1]);
floorState = await page.evaluate(() => window.__fp.project.floors);
if (floorState.basement.length !== basementRoomCountBeforePoolAttempt) {
  throw new Error('Basement allowed a room on pool-covered cells');
}
const poolBlockedPixel = await page.evaluate(({ x, y }) => {
  const ed = window.__fp;
  const rect = ed.el.canvas.getBoundingClientRect();
  const dpr = ed.el.canvas.width / rect.width;
  const px = Math.round((ed.view.tx + x * ed.view.scale) * dpr);
  const py = Math.round((ed.view.ty + y * ed.view.scale) * dpr);
  return Array.from(ed.ctx.getImageData(px, py, 1, 1).data).slice(0, 3);
}, { x: poolPosition.x - 0.5, y: poolPosition.y - 0.5 });
if (poolBlockedPixel[0] < 205 || poolBlockedPixel[0] > 230 ||
    Math.abs(poolBlockedPixel[0] - poolBlockedPixel[1]) > 4) {
  throw new Error(`pool outer ring should be gray in the Basement: ${poolBlockedPixel}`);
}

// ---- zoom + fit ----
await page.click('#fp-zoom-in');
await page.click('#fp-zoom-in');
const z = await page.textContent('#fp-zoom-val');
await page.click('#fp-fit');
log('zoomed to', z, '-> fit', await page.textContent('#fp-zoom-val'));

// ---- undo / redo ----
const before = await page.evaluate(() => window.__fp.project.rooms.length);
await page.click('#fp-undo');
await page.waitForTimeout(120);
const afterUndo = await page.evaluate(() => window.__fp.project.rooms.length);
await page.click('#fp-redo');
await page.waitForTimeout(120);
const afterRedo = await page.evaluate(() => window.__fp.project.rooms.length);
log('undo/redo:', before, afterUndo, afterRedo);

// ---- persistence: reload the page ----
const ids = await page.evaluate(() => window.__fp.project.rooms.map((r) => r.id).join(','));
await page.waitForTimeout(900); // let autosave flush
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#fp-canvas');
const idsAfter = await page.evaluate(() => window.__fp.project.rooms.map((r) => r.id).join(','));
log('persisted after reload?', ids === idsAfter);
const persistedFloors = await page.evaluate(() => ['basement', '2', '3', '4', '5'].map((floor) => window.__fp.project.floors[floor].length));
if (persistedFloors.join(',') !== '2,2,1,1,1') throw new Error(`floor data did not persist: ${persistedFloors}`);
const persistedBalconies = await page.evaluate(() => [window.__fp.project.balconies['2'].length, window.__fp.project.balconies['3'].length]);
if (persistedBalconies.join(',') !== '1,0') throw new Error(`balcony data did not persist after reload: ${persistedBalconies}`);
const persistedStairs = await page.evaluate(() => window.__fp.project.stairs.length);
if (persistedStairs !== 1) throw new Error(`stairs did not persist after reload: ${persistedStairs}`);
const persistedPools = await page.evaluate(() => window.__fp.project.pools.length);
if (persistedPools !== 1) throw new Error(`pool data did not persist after reload: ${persistedPools}`);
const persistedPatios = await page.evaluate(() => window.__fp.project.patios.length);
if (persistedPatios !== 1) throw new Error(`patio data did not persist after reload: ${persistedPatios}`);
const persistedDoors = await page.evaluate(() => window.__fp.project.doors['1'].length);
if (persistedDoors !== 1) throw new Error(`door data did not persist after reload: ${persistedDoors}`);
const persistedMezzanines = await page.evaluate(() => window.__fp.project.mezzanines['2'].length);
if (persistedMezzanines !== 1) throw new Error(`mezzanine data did not persist after reload: ${persistedMezzanines}`);
const persistedBasementMezzanines = await page.evaluate(() => window.__fp.project.mezzanines['1'].length);
if (persistedBasementMezzanines !== 1) {
  throw new Error(`Basement-supported 1F mezzanine did not persist after reload: ${persistedBasementMezzanines}`);
}
await page.evaluate(() => window.__fp.deleteFloor('basement'));
if (await page.evaluate(() => window.__fp.project.mezzanines['1']?.length || 0) !== 0) {
  throw new Error('Deleting Basement should remove the mezzanine that depended on it');
}
await page.click('#fp-undo');
if (await page.evaluate(() => window.__fp.project.mezzanines['1'].length) !== 1) {
  throw new Error('Undo should restore the Basement and its supported 1F mezzanine');
}

// ---- export PNG ----
const [pngDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#fp-export-png'),
]);
const pngPath = await pngDownload.path();
const png = await (await import('node:fs/promises')).readFile(pngPath);
const pngSignature = '89504e470d0a1a0a';
if (png.subarray(0, 8).toString('hex') !== pngSignature) throw new Error('PNG export is not a valid PNG image');
if (!pngDownload.suggestedFilename().endsWith('.png')) throw new Error('PNG export filename is missing the .png extension');
log('PNG export:', pngDownload.suggestedFilename(), '| bytes:', png.length);

// ---- home listing and project deletion ----
await page.click('#fp-back');
await page.waitForSelector('.proj-card, .empty-state');
await page.screenshot({ path: `${OUT}07-home-list.png` });
const cards = await page.locator('.proj-card').count();
log('projects on home:', cards);
if (await page.locator('#btn-import').count()) throw new Error('home should not expose JSON import');
if (await page.locator('[data-export]').count()) throw new Error('home cards should not expose JSON export');
const projectCard = page.locator('.proj-card').first();
const projectTitle = (await projectCard.locator('h3').textContent()).trim();
const projectId = await projectCard.getAttribute('data-id');
const nativeDialogs = [];
page.on('dialog', async (dialog) => {
  nativeDialogs.push(dialog.message());
  await dialog.dismiss();
});
await projectCard.locator('[data-del]').click();
const projectDeletePrompt = projectCard.locator('.project-delete-popover');
if (!(await projectDeletePrompt.isVisible()) ||
    !(await projectDeletePrompt.textContent()).includes(`Delete “${projectTitle}”?`)) {
  throw new Error('project delete should show an inline confirmation for the selected project');
}
await projectDeletePrompt.locator('[data-cancel-delete]').click();
if (await projectCard.count() !== 1) throw new Error('canceling project deletion should keep the project');
await projectCard.locator('[data-del]').click();
await projectCard.locator('[data-confirm-delete]').click();
if (await page.locator(`.proj-card[data-id="${projectId}"]`).count()) {
  throw new Error('confirming project deletion should remove the selected project');
}
if (nativeDialogs.length) throw new Error(`project deletion should not use native dialogs: ${nativeDialogs}`);

await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${OUT}08-home.png`, fullPage: true });

// ---- Penthouse: no Basement, maximum 3F, and acknowledge 3F notice once ----
await page.click('#btn-new');
await page.click('[data-lot="penthouse"]');
await page.fill('#c-name', 'Penthouse Rules Test');
await page.click('#c-create');
await page.waitForSelector('#fp-canvas');
if (await page.locator('#fp-add-basement').count()) {
  throw new Error('Penthouse should not offer Add Basement');
}
await page.click('#fp-add-floor');
if (!(await page.locator('[data-floor="2"]').count())) {
  throw new Error('Penthouse should allow adding 2F');
}
await page.click('#fp-add-floor');
const penthousePrompt = page.locator('.penthouse-floor-prompt');
if (!(await penthousePrompt.isVisible()) ||
    (await penthousePrompt.locator('strong').textContent()).trim() !== 'Create 3F?' ||
    !(await penthousePrompt.textContent()).includes('This includes Development Site content.') ||
    !(await penthousePrompt.textContent()).includes("I understand. Don't show this again.")) {
  throw new Error('Penthouse 3F confirmation should show the requested English title, content, and acknowledgement');
}
await page.check('#fp-third-floor-acknowledge');
await page.click('#fp-confirm-create-floor');
let penthouseState = await page.evaluate(() => window.__fp.project);
if (!penthouseState.floors['3'] || !penthouseState.penthouseThirdFloorAcknowledged) {
  throw new Error('confirming the Penthouse 3F prompt should create 3F and save acknowledgement');
}
await page.waitForTimeout(800);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#fp-canvas');
await page.click('[data-delete-floor="3"]');
await page.click('#fp-confirm-delete-floor');
await page.click('#fp-add-floor');
if (await page.locator('.penthouse-floor-prompt').count()) {
  throw new Error('acknowledged Penthouse 3F notice should not appear again after reload');
}
penthouseState = await page.evaluate(() => window.__fp.project);
if (!penthouseState.floors['3'] || await page.locator('#fp-add-floor').count()) {
  throw new Error('Penthouse should stop offering floors above 3F');
}

console.log('\nconsole errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) {
  console.error('FAILED: console errors present');
  process.exit(1);
}
console.log('\nSMOKE TEST PASSED');

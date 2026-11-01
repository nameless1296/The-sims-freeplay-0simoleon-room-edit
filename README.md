# Floor Planner — V1.0

A web-based 2D floor planner with **The Sims FreePlay** room-building rules:
fixed lots, grid snapping, and **only rectangles or L-shaped rooms** — ever.

No build step, no dependencies. Just run:

```bash
node server.mjs        # → http://localhost:5173
```

```bash
npm test               # geometry / rule unit tests
npm run test:e2e       # full browser end-to-end run (needs playwright + chromium)
```

## What's inside

| Screen | What it does |
|---|---|
| **Home** | Project cards with mini floor-plan thumbnails, lot type, size, room count, and last edited date. Open or delete saved projects. |
| **Create** | Pick a fixed lot (Standard 18×18, Ocean View 18×36, Penthouse 12×26), name it, preview the grid. |
| **Editor** | Left tool rail (Select / Edit / Delete), on-demand floor switcher (new projects start at 1F; add up to 5F and optionally Basement), centre canvas, right properties panel, and Edit-only bottom-right room-mode buttons. Door, Stairs and Mezzanine are stacked above Create Room; Patio and Pool (1F) and Balcony (2F–5F) remain arranged beside it. In Select mode, every object can be selected and dragged to move; resize handles and room properties are available without switching to Edit. |

## Building rules (and how they're enforced)

| Rule | Implementation |
|---|---|
| Only rectangles and L shapes | The room schema *is* "footprint minus one corner notch" — no other shape is expressible |
| Never 1 × 1 (but 1 × 2, 2 × 1, 1 × 9 are all fine) | `minSizeOk()` — checked on drag-create, panel edit, handle resize **and** JSON import |
| No overlap, shared walls allowed | AABB test on the room's decomposed rectangles |
| Cannot leave the lot | Bounds check on every mutation |
| Add and remove floors on demand | New projects start with 1F only. Use **Add Floor** to add the next upper floor sequentially, up to 5F, and **Add Basement** to create a Basement independently. Basement can be deleted independently; upper floors must be deleted from the top down, so only the highest floor shows a delete control. Deletion requires confirmation and can be undone. Existing projects retain floors already present in their saved data |
| Penthouse floor limits | Penthouse lots cannot have a Basement and are limited to 3F. Creating 3F requires confirming **Create 3F?** and acknowledging that it includes Development Site content; the checkbox saves the acknowledgement so the notice is not shown again |
| Upper floors need support | New and edited rooms on floors 2F–5F must be supported by 1F rooms; unsupported cells appear gray. Existing upper rooms are retained if a lower-floor room is deleted |
| Balcony support and editing | On floors 2F–5F, drag directly on the grid to create a balcony; it does not need to attach to a room. A 1×1 balcony is not allowed. Its cells may be white (supported by 1F) and/or gray cells within 3 grid cells of white support in both axes. Cells farther away are rejected. In Balcony mode, drag a balcony to move it or drag any outer handle to resize it. Balcony footprints appear gray and cannot contain rooms on higher floors; balconies cannot overlap rooms or other balconies |
| Pool and Basement interaction | In Edit > Pool mode on 1F, drag a rectangular pool core at least 3×3. A one-cell outer ring surrounds the entire core. The core and ring cannot overlap rooms; pool cores cannot overlap each other, while outer rings may overlap one another or another pool's core. Select mode also lets you drag an existing pool to move it or use its edge handles to resize it. Pools can also be deleted in Delete mode. In Basement, every cell covered by any pool core or outer ring is gray and cannot contain a new or edited room |
| Patio and Pool interaction | On 1F, use Edit > Patio to create, move, resize, or delete rectangular patios. Select mode also lets you drag an existing patio to move it or use its outer handles to resize it. Patios cannot overlap rooms, pool cores, or pool outer rings, but may overlap other patios; pool creation and editing also respect existing patios |
| Door placement | In Edit > Door mode, click or drag along an exterior or shared room wall to place a door 1–4 cells wide; on Basement, doors must be on shared walls between two rooms. Doors are stored per floor, cannot float off a wall or overlap another door on that wall, and can be moved/resized in Select mode (including width in the properties panel) or deleted in Delete mode |
| Stairs and upper-floor openings | Edit > Stairs is available when the next floor exists. The next floor's rooms appear as a translucent overlay while placing stairs. Choose a 1×5 or 2×3 stair, rotate if needed, then click to place it. The full footprint must fit inside one room on both floors; the upper room must also extend one cell in the direction the stair faces to provide an exit. The upper footprint is drawn as an opening inside that room. Stairs can be moved, rotated, changed to the other type, or deleted, and removing either connected floor removes its stairs |
| Mezzanines | On 2F–5F, or on 1F when a Basement exists, use Edit > Mezzanine and drag a rectangular platform at least 1×2 cells. Rooms on the immediately lower floor appear as a translucent overlay while placing it. Its entire footprint must fit inside one room on both the current floor and the floor below, so it cannot cross room boundaries on either floor. Select or Edit mode allows moving and resizing; Delete removes it. Deleting the Basement also removes 1F mezzanines that depended on it |
| Basement is otherwise unrestricted | Basement rooms do not depend on any other floor, except for cells blocked by a pool core or outer ring |
| **L rooms via the real FreePlay mechanic** | In Edit > L-Shape mode, select a rectangle and drag one of 8 yellow anchors (4 corners × 2 walls) outwards → a 1-cell-thick strip grows into one L room |
| Extension adjustable / collapsible | In Edit mode, adjust the selected L room; drag the yellow inner-corner handle in L-Shape mode, or hit **Restore Rectangle** |

The reference research behind the L-shape mechanic (with real game screenshots) is in
[`docs/REFERENCE.md`](docs/REFERENCE.md); the full build & acceptance report is in
[`docs/DEV_REPORT.md`](docs/DEV_REPORT.md).

## Project files

Projects are saved in the browser's local storage. The editor can export the floor plan as a PNG image.
There is no JSON project import or export; project data stays in local storage.

## Keyboard

`V` select · `E` edit · `C` cycle Create Room / L-Shape modes while editing · `D` delete · `F` fit · `+`/`−` zoom ·
`Delete` / `Backspace` remove the selected item while in Delete mode · `Esc` cancel · `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `Ctrl+S` save

## Not in V1.0

Furniture, windows, wall & floor materials, 3D, cloud sync,
accounts, game-data import, arbitrary polygons.

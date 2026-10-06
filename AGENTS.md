# Match Studio Viewer — Agent Guide

> **Scope:** This repository is a **standalone browser UI**. Everything you need to develop, test, and ship the viewer lives here. Work only against the documented HTTP API and the included dev fixtures.

## What this project is

**Match Studio** is a **tactical match replay viewer** for modern extraction-style FPS titles — like an **esports broadcast overlay**, **coaching-room map replay**, or **demo analyzer**.

It renders JSON snapshots delivered over HTTP:

- **2D tactical map** (Leaflet tiles + entity markers)
- Optional **3D scene** (Three.js + terrain GLB when assets are present)
- **Roster sidebar** (operators grouped by team / threat)
- **Loot & container layers**
- **Replay transport** (play / pause / seek / speed) when replay mode is active

The UI **polls REST endpoints on the same origin**; it never opens sockets to game servers.

## Repository layout

```
.
├── index.html              # Shell: layout, styles (~900 lines), app logic (~2000 lines)
├── map_catalog.json        # Map metadata (bounds, zoom, POI, tile URLs)
├── ui/
│   ├── dock.js             # Settings panel tab layout
│   ├── shubao.css          # Theme overrides
│   └── icons/
├── m3d/
│   ├── r3d.js              # 3D engine: camera modes, quality tiers, FPV smoothing
│   ├── korr-adapter.js     # Snapshot → 3D bridge + replay interpolation
│   ├── korr-renderer.js    # Terrain GLB, occlusion styling, character meshes
│   ├── gateway-pose.js     # Pose / aim visualization helpers (legacy filename)
│   └── character-models.js
├── avatars/                # Operator portrait PNGs (filename = operator codename)
├── vendor/                 # Vendored Leaflet + Three.js (avoid editing except upgrades)
├── dev/
│   ├── server.mjs          # Local static file + fixture API server
│   └── fixtures/           # Sample `/api/state` and `/api/status` payloads
└── resources/              # Optional item icons (may be served at runtime)
```

## Data flow

1. Poll `GET /api/state` (~20 Hz live; replay clock when paused/seeking).
2. Poll `GET /api/status` for session / replay metadata.
3. On boot, `GET /api/map` returns map catalog (bounds, rotation, default map key).
4. 3D terrain loads from `/m3d/<map>.glb` when available; optional `/api/map/<name>/meta` for cache tags.
5. User prefs persist in `localStorage` under prefix `nr2_<key>` (legacy naming — migrate carefully).

## API contract (do not break)

Treat `/api/*` as an **opaque contract**. The UI only depends on JSON shape and paths below — not on who implements the server.

### `GET /api/state`

| Field | Type | Meaning |
|-------|------|---------|
| `self` | `[x,y,z]` cm | Observer / POV player world position |
| `self_yaw`, `self_aim_yaw` | number | Facing / aim (degrees, UE convention) |
| `self_name`, `self_hp` | string / object | POV identity |
| `live_active` | bool | `true` = live stream, `false` = replay or idle |
| `entities` | array | All drawable units (see below) |
| `flow`, `meta`, `cursor`, `status` | misc | Session / replay bookkeeping |

**Entity object** (partial — preserve all existing fields when refactoring):

```
key, kind, name, hero, is_bot,
world [x,y,z], rel [dx,dy,dz], yaw,
team, slot, dead, status, status_key,
hp, helmet, vest, helmet_dur, vest_dur,
bp, cr, weapon, curr_weapon, trail,
item_id, grade, price
```

`kind` enum: `self | mate | player | ai | box | loot | container | unknown`

### Replay controls

`GET /api/ctrl?pause=1|0&seek=<ms>&speed=<float>` — effective in replay mode only.

### Other endpoints

- `/api/flows`, `/api/select?run=&flow=` — multi-session picker (diagnostics UI)
- Static: `/ui/`, `/vendor/`, `/avatars/`, `/m3d/`, `/resources/`

## UI layout principles

The **map is the primary surface**; all chrome floats above it and can collapse.

| Region | Role |
|--------|------|
| Top **situation island** | At-a-glance remaining opponents, downed, eliminated; expand for detail |
| Right **roster deck** | Operators by team/threat + loot list below |
| Left **settings dock** | Vertical tabs: Display / 3D / Loot / Alerts |
| Bottom **replay bar** | Replay mode: transport + seek + speed |
| **View switcher** | 2D map ↔ 3D scene; cameras: free, top-down, FPV follow, third-person follow |

Mobile (`max-width: 900px`): side panels become bottom drawers; larger touch targets.

## Known frontend debt (priority order)

Refactoring is explicitly welcome.

### P0 — Structure

1. **`index.html` monolith** (~2900 lines): split into `ui/styles/`, `ui/app/` modules, slim shell.
2. **Dual CSS**: inline `<style>` plus `shubao.css` → single token source + one component sheet.
3. **No build step** today: vanilla ES modules + import map. Avoid webpack unless necessary.

### P1 — Maintainability

4. Inline game lookup tables (`BAG_LV`, `RIG_LV`, `BAG_CAP`, …) → `/resources/catalog.json`.
5. Align 2D (inline) and 3D (`m3d/`) module boundaries.
6. Legacy comment wording — prefer *viewer / tactical map / replay UI*; do not blindly rename DOM ids or API fields.

### P2 — Polish

7. Extend ARIA beyond dock tabs (roster, view switcher, replay bar).
8. Centralize light/dark theme tokens.

## Coordinates & rendering

- World coords are **UE centimeters**. Map projection uses per-map metadata (`center`, `rotate`, `width`/`height`, `bj` scale).
- 3D: `x = ue_x/100`, height = `ue_z/100`, depth = `ue_y/100`.
- Yaw: UE style — +X = 0°, increases toward +Y; 3D rotates around **−Y**.
- 2D markers interpolate between snapshots (`SM_TAU`); 3D FPV uses buffered interpolation — read `r3d.js` before changing camera code.
- Keep DOM pools (`_rc`, `opRows`, `lootRows`) unless you verify no jank regression.

## Local development

Requires **Node 18+** only:

```bash
npm run dev   # http://127.0.0.1:5173
```

`dev/server.mjs` serves static files and fixture-backed `/api/*` responses. Hard-refresh after JS/CSS edits (`Ctrl+Shift+R`). Bump `?v=` on module URLs when needed.

The host that serves this UI is expected to inject `__MS_NO3D__` in `index.html` (`0` or `1`) before delivery when terrain assets may be absent. The dev server performs the same substitution locally.

## Editing rules

### Do

- Preserve `/api/state` field names and semantics.
- Prefer **small, reviewable diffs** unless explicitly asked for structural split.
- Keep visual language: dark glass panels, `--accent` blue, semantic colors (`--ally`, `--danger`, `--warn`, `--loot`).
- Test **2D-only** and **3D** paths; test mobile breakpoint.
- Bump cache-bust query strings on static asset changes.

### Do not

- Add server-side or native code to this repo — stay browser-only.
- Rename `localStorage` keys without a migration.
- Edit `vendor/three/**` except version upgrades.
- Remove replay controls or diagnostics panel without replacement.
- Add React/Vue unless explicitly requested.

## Suggested refactor sequence

1. Extract CSS → `ui/styles/viewer.css`
2. Pure helpers → `ui/app/constants.js` + `ui/app/format.js`
3. Poll loop → `ui/app/engine.js`
4. Leaflet layer → `ui/app/map2d.js`
5. Roster / loot DOM → `ui/app/roster.js`
6. Wire via `<script type="module">` entry
7. TypeScript / bundler only after the above

## Quality bar

- [ ] Chrome desktop + ~390px mobile viewport
- [ ] Smooth 2D markers; no FPV camera regression in 3D
- [ ] Prefs read/write correctly (`PREF` / `setPref`)
- [ ] No new console errors while idle-polling
- [ ] Structural changes reduce `index.html` line count

---

*Last updated: 2026-10-07*

# Match Studio Viewer

Browser-based **tactical match replay viewer** for extraction-style FPS titles. Visualize recorded session telemetry on a 2D map with optional Three.js 3D scene, operator roster, loot layers, and replay transport controls.

Built for coaching rooms, broadcast overlays, and post-match review — the UI consumes JSON snapshots from an HTTP gateway and does not connect to game servers directly.

## Features

- **2D tactical map** — Leaflet tiles, smoothed entity markers, team colors, distance rings
- **3D scene** (when terrain GLB assets are available) — free / top-down / follow cameras
- **Operator roster** — grouped by team and threat proximity
- **Loot & containers** — filterable map layers with rarity coloring
- **Replay mode** — play, pause, seek, variable speed
- **Mobile layout** — collapsible drawers, touch-friendly controls

## Quick start

```bash
git clone https://github.com/thexin7/match-studio-viewer.git
cd match-studio-viewer
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The included dev server serves static assets and mock `/api/*` responses from `dev/fixtures/`.

## Architecture

```
Browser UI  ──poll──▶  GET /api/state
              │        GET /api/status
              │        GET /api/map
              └──static──▶  index.html, ui/, m3d/, vendor/, avatars/
```

The gateway (not in this repository) is responsible for producing `/api/state` snapshots from live telemetry or JSONL replay files.

## API overview

| Endpoint | Purpose |
|----------|---------|
| `GET /api/state` | Current match snapshot (entities, self POV, replay cursor) |
| `GET /api/status` | Session / replay metadata |
| `GET /api/map` | Map catalog (bounds, rotation, tile URLs) |
| `GET /api/ctrl?pause=&seek=&speed=` | Replay transport (replay mode only) |

See [AGENTS.md](./AGENTS.md) for the full contract and refactoring guidance.

## Project status

The viewer is functional but carries structural debt: ~2900-line `index.html`, dual CSS layers, and inline game lookup tables. Contributions toward modular ES modules and a single design-token stylesheet are welcome.

## Tech stack

- Vanilla JavaScript (ES modules + import map)
- [Leaflet](https://leafletjs.com/) for 2D map
- [Three.js](https://threejs.org/) for 3D scene
- No bundler required for development

## License

MIT

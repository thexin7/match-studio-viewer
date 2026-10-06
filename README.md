# Match Studio Viewer

Browser-based **tactical match replay viewer** for extraction-style FPS titles. Visualize session telemetry on a 2D map with optional Three.js 3D scene, operator roster, loot layers, and replay transport controls.

Built for coaching rooms, broadcast overlays, and post-match review.

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

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The dev server ships fixture data for all `/api/*` endpoints so you can work on UI without any external services.

## Architecture

```
Browser UI  ──poll──▶  GET /api/state
              │        GET /api/status
              │        GET /api/map
              └──static──▶  index.html, ui/, m3d/, vendor/, avatars/
```

This repository contains **only the browser client**. Any process that implements the `/api/*` contract on the same origin can drive the viewer.

## API overview

| Endpoint | Purpose |
|----------|---------|
| `GET /api/state` | Current match snapshot (entities, self POV, replay cursor) |
| `GET /api/status` | Session / replay metadata |
| `GET /api/map` | Map catalog (bounds, rotation, tile URLs) |
| `GET /api/ctrl?pause=&seek=&speed=` | Replay transport (replay mode only) |

See [AGENTS.md](./AGENTS.md) for the full contract and refactoring guidance.

## Tech stack

- Vanilla JavaScript (ES modules + import map)
- [Leaflet](https://leafletjs.com/) for 2D map
- [Three.js](https://threejs.org/) for 3D scene
- No bundler required for development

## License

MIT

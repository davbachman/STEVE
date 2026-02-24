# AGENTS.md

## Project Overview

This repository contains a **desktop-first, browser-only, WebGPU-only 3D equation graphing app** inspired by Apple Grapher's interaction model, but focused exclusively on **3D plots**.

The app supports:

- Parametric curves `(x(t), y(t), z(t))`
- Parametric surfaces `(x(u,v), y(u,v), z(u,v))`
- Implicit surfaces `F(x,y,z)=0`
- Explicit single-axis surfaces (`z=f(x,y)`, `x=g(y,z)`, `y=h(x,z)`) recognized and compiled as surface plots

The intended product target is a high-control interactive renderer with realistic shading/shadows plus a future higher-quality still-render mode.

## Current Repo Status (Important)

This repo is **not** a blank scaffold anymore. It is a working prototype with major functionality implemented.

Highlights already working:

- WebGPU Babylon.js viewport (desktop Chrome/macOS tested)
- 3D equation parsing/classification + LaTeX preview while typing
- Plot rendering for curve/surface/implicit/explicit forms
- Object list + inspector panels + scene/material/light controls
- Selection and drag interactions (camera/object/light)
- Directional and point lights, with shadows (capability gated)
- Local save/load/autosave and PNG export
- Worker-based parse/meshing pipeline (preview/refine workflow + cancellation)
- Playwright harness + shadow regression scenes (with WebGPU screenshot caveats)

Known prototype limitations remain (see "Phase Status" and "Known Issues").

## Product Specification (Target v1)

### Scope (In)

- 3D plotting only (no 2D plots, vector fields, contour lines)
- Equation editing with live formatted preview while typing
- Scene composition with multiple plots + point lights
- Material controls per plot (color, opacity/transmission, IOR, reflectiveness, roughness)
- Scene controls (ground plane, XY grid, axes, background)
- Lighting controls (ambient, directional, point lights)
- Local persistence and PNG export
- Progressive high-quality still render mode (future phase; currently placeholder)

### Scope (Out of v1)

- Animation/timeline
- CAS-level symbolic algebra
- Cloud sync/collaboration
- Mobile-first UX
- Guaranteed photoreal caustics

### Supported Equation Types

- `parametric_curve`: tuple of 3 expressions using `t`
- `parametric_surface`: tuple of 3 expressions using `u, v`
- `explicit_surface`: `x=...`, `y=...`, or `z=...` (compiled to surface sampling)
- `implicit_surface`: general equality in `x,y,z`, normalized to implicit scalar form

### Input / Interaction Controls (Current Mapping)

- `RMB drag` or `two-finger drag`: orbit camera
- `Shift + RMB drag` or `Shift + two-finger drag`: pan camera
- `wheel` / pinch: zoom
- `LMB click`: select plot or point light
- `LMB drag`: move selected object/light parallel to XY plane
- `Shift + LMB drag`: move selected object/light along Z
- `Delete` / `Backspace`: delete selected
- `Ctrl/Cmd+C`, `Ctrl/Cmd+V`: copy/paste selected object/light
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` / `Ctrl+Y`: undo/redo
- `Esc`: clear selection

### Rendering Goals

Interactive mode target:

- PBR materials
- Directional + point lights
- Shadows (object-on-object + object-on-receiver)
- Transmission/refraction approximations
- Ground reflections / realism features (partially implemented, capability-gated)

Quality mode target:

- Progressive still renderer with accumulation (future phase)

## Current Architecture and Tech Stack

- **Frontend**: React 19 + Vite + TypeScript
- **State**: Zustand + Immer
- **Editor/Math UI**: CodeMirror 6 + KaTeX
- **Renderer**: Babylon.js (`@babylonjs/core`) on **WebGPU only**
- **Workers**:
  - `mathWorker` for parse/classify
  - `meshWorker` for curve/surface/implicit meshing
- **Persistence**: IndexedDB (Dexie) + JSON import/export
- **Tests**:
  - Vitest (parser/meshing unit tests)
  - Playwright (shadow smoke/regression workflows)

## Repository Description (Current Layout)

### Root Files

- `package.json`: scripts, dependencies, Playwright/Vitest entry points
- `playwright.config.ts`: WebGPU-oriented Chromium launch configuration
- `README.md`: still the default Vite template (stale; not project-specific)
- `AGENTS.md`: this file

### `src/` Overview

- `src/App.tsx`
  - App shell composition
  - Global keyboard shortcuts
  - Built-in test scene loading via URL query params
  - Hooks: autosave + worker pipeline

- `src/main.tsx`
  - App mount
  - Global runtime/unhandled rejection fatal overlays

- `src/types/contracts.ts`
  - Canonical app data contracts
  - scene/render/object types
  - worker RPC contracts
  - runtime diagnostics + plot job status

- `src/state/defaults.ts`
  - Default scene/render/object presets
  - Material presets
  - Current new-scene defaults include:
    - `groundPlaneVisible = false`
    - `gridVisible = true`
    - `pointShadowMode = "auto"`

- `src/state/store.ts`
  - Central Zustand store
  - Object/scene/material/light mutations
  - History snapshots (undo/redo)
  - Clipboard flows
  - Render diagnostics
  - Plot async job status state (`plotJobs`)

- `src/math/`
  - `tokenizer.ts`, `parser.ts`, `ast.ts`: math parsing
  - `classifier.ts`: equation type inference + formatting metadata
  - `latex.ts`: AST to LaTeX formatting
  - `evaluator.ts`: compiled numeric expression execution
  - `compile.ts`: converts plot objects into executable plot evaluators
  - `mesh/parametric.ts`: curve and parametric surface sampling/meshing
  - `mesh/implicitMarchingTetra.ts`: implicit surface meshing (marching tetrahedra polygonization with a uniform leaf-resolution final meshing path, cleanup, and numeric normals; still in-progress)

- `src/workers/`
  - `mathWorker.ts`: parse/classify worker
  - `meshWorker.ts`: meshing worker with preview/refine jobs
  - `runtimeMeshCache.ts`: in-memory mesh handoff cache for renderer
  - `contracts.ts`: re-export alias to canonical contracts

- `src/hooks/`
  - `useAutosave.ts`: IndexedDB autosave
  - `useWorkerPipeline.ts`: Phase 2 async scheduling (debounce, cancel, latest-wins, preview/refine)

- `src/renderer/`
  - `Viewport3D.tsx`: canvas host + overlays
  - `SceneController.ts`: Babylon scene orchestration, meshes, materials, lights, shadows, interactions

- `src/ui/components/`
  - `TopBar.tsx`: project actions + render mode controls
  - `ObjectListPanel.tsx`: object/light list + inline controls + job badges
  - `EquationEditor.tsx`: CodeMirror + KaTeX + parse diagnostics + job status
  - `InspectorPanel.tsx`: object/material/lighting/scene/render inspector tabs
  - `LatexPreview.tsx`: rendered equation preview

- `src/persistence/`
  - `db.ts`: IndexedDB wrapper
  - `projectFile.ts`: import/export project serialization helpers

- `src/testing/testScenes.ts`
  - Built-in deterministic test scenes:
    - `shadow-regression`
    - `point-shadow-regression`

### `tests/e2e/`

Playwright scenarios for shadow smoke and visual regression workflows. Note: visual GPU canvas captures can be unreliable in headless Chromium on some setups (CSS background may be captured instead of WebGPU content).

## Run / Build / Test Commands

- Dev server: `npm run dev`
- Production build: `npm run build`
- Unit tests (Vitest): `npm run test:run`
- Playwright install: `npm run test:e2e:install`
- Playwright e2e: `npm run test:e2e`
- Playwright update snapshots: `npm run test:e2e:update`

### Test Caveat (Current)

`npm run test:run` may pick up Playwright tests under `tests/e2e/` depending on Vitest config/discovery behavior and fail with Playwright-specific `test.describe()` errors. Use targeted Vitest invocations for unit tests when needed, for example:

- `npx vitest run src/math/__tests__/parser.test.ts`
- `npx vitest run src/math/__tests__/implicitMesher.test.ts`

## Current Feature Status (What Works vs What Is Partial)

### Implemented / Working (Prototype Level)

- 3D object creation and editing
- Equation classification and live LaTeX formatting (partial parse tolerance)
- Parametric curves and surfaces meshing/rendering
- Explicit-form surface recognition + compilation
- Implicit surface meshing (prototype, currently imperfect)
- Scene lighting and shadows (directional + point)
- Shadow diagnostics overlay (counts, capability state, receiver mode)
- Material controls and presets
- Object and point-light selection/dragging
- Copy/paste/delete/undo/redo (snapshot-based history)
- Autosave/load/export PNG
- Workerized parse + mesh scheduling with preview/refine and cancellation
- Per-object async job status badges/messages

### Partial / Placeholder / Unfinished

- Quality render mode (`Render > Mode = Quality`) is still a placeholder/progressive counter and may visually jitter
- Implicit surface topology is much improved (major hole/crack regressions now covered by tests), but implicit-surface lighting/normals orientation is still incorrect in some scenes
- Advanced interactive realism effects (SSR, robust transmission/refraction stacking, path-traced still mode) are not complete
- Playwright visual baselines are not fully trustworthy for WebGPU pixels in headless mode

## Phase Status (Plan Progress)

This project follows an 8-phase roadmap. Status below reflects the code currently in this repo.

### Phase 1 — Rendering Correctness and Lighting Completion

**Status:** Mostly implemented (prototype-complete; ongoing polish possible)

Implemented:

- Directional shadows visible and tunable
- Point-light shadows re-enabled and capability gated
- Shadow diagnostics overlay with shadow counts/capability/receiver info
- Ground-plane shadow receiver path (XY grid is visual-only; not a shadow receiver)
- Ambient/directional/point controls affecting scene
- Shadow regression test scenes and Playwright harness

Known remaining polish:

- More reliable automated visual verification of WebGPU canvas output
- Additional diagnostics (per-light shadow render-list details) if needed

### Phase 2 — Workerization and Preview/Refine Pipeline

**Status:** Implemented (current prototype target met)

Implemented:

- `mathWorker` and `meshWorker`
- Debounced parse + meshing scheduling
- Cancelable jobs per object (latest-wins behavior)
- Preview + final/refine mesh jobs
- Per-object async job status (`plotJobs`) and UI badges/messages
- Renderer mesh updates driven by worker-produced mesh versioning

Remaining hardening (future polish):

- More robust progress telemetry
- More exhaustive race-condition regression tests

### Phase 3 — Implicit Meshing Upgrade (Adaptive Octree / Better Quality)

**Status:** In progress (not complete)

Implemented in current repo:

- Uniform leaf-resolution final meshing path (temporary robust path that avoids mixed-resolution seam cracks)
- Numeric-gradient normals + triangle winding orientation pass
- Closed-mesh orientation canonicalization (signed-volume based) to reduce scalar-sign-dependent inverted lighting on watertight surfaces
- Mesh cleanup (degenerate filtering, point dedupe, duplicate triangle filtering)
- Bounds validation / large-volume warning UI in implicit inspector
- Expanded unit tests for sphere/shifted sphere/torus/ellipsoid/clipped cylinder/`xyz=1` topology regressions, quality monotonicity, and invalid bounds

Not complete / still failing in practice:

- Implicit surfaces can still appear lit from the wrong side in some scenes (reported with point lights), despite mesher topology looking correct
- Root-cause isolation is still needed between implicit normal orientation (especially open/clipped surfaces) and renderer/material/light handling
- Full marching-cubes implementation (current polygonization is still marching-tetra-based)
- Production-grade topology consistency / isotropy (marching-tetra artifacts still visible on some shapes)

### Phase 4 — Real Quality Render Mode (Progressive Still Renderer)

**Status:** Not implemented (placeholder only)

Current behavior:

- UI scaffold exists
- Sample counter/progress placeholder runs
- Can cause visible jitter without true quality improvement

Still needed:

- Actual accumulation renderer
- restart-on-change logic tied to render buffers
- quality buffer PNG export
- reflection/transmission support in quality mode

### Phase 5 — Interaction and Editing UX Hardening

**Status:** Partially implemented

Implemented:

- Core selection/dragging/copy/paste/delete/undo/redo
- Light gizmo usability improvements
- Z-drag follow improvements

Still needed:

- Command-based undo/redo (currently snapshot-style)
- Drag transaction coalescing
- Multi-select (optional)
- Selection prioritization and snapping modes
- Keyboard shortcut scoping hardening around editor focus

### Phase 6 — Rendering Realism Expansion (Interactive Mode)

**Status:** Partial

Implemented/partial:

- PBR materials
- Shadows
- Some transmission/refraction approximation behavior
- Ground receiver flow (XY grid is visual-only overlay, no shadow receiving)

Still needed:

- Stable planar reflections reintroduced broadly (capability gated)
- SSR path (if viable on Babylon/WebGPU stack)
- Better transmission/refraction realism and ordering
- Quality presets that alter pipeline features/performance meaningfully

### Phase 7 — Persistence, Project Schema, and Export Hardening

**Status:** Partial

Implemented:

- Project JSON import/export
- Local autosave
- PNG export

Still needed:

- Schema migration scaffolding/version upgrades
- Autosave management UI (restore prompt/history/clear)
- Import validation UX hardening
- Expanded export options/resolution presets/transparency handling

### Phase 8 — QA, Performance, and Release Preparation

**Status:** Partial foundation only

Implemented:

- Parser/classifier unit tests
- Expanded implicit mesher topology/branch/orientation regression tests
- Playwright smoke + regression scene workflows

Still needed:

- Broader interaction Playwright coverage
- Visual regression strategy that reliably captures WebGPU output
- Performance benchmark harness and budgets
- Bundle-size optimization and diagnostics polish

## Known Issues / Current Bugs (As of This File)

1. **Implicit surface lighting/normals issue (Phase 3 / Phase 1 crossover blocker)**
- Some implicitly defined surfaces still appear illuminated from the wrong side (reported with point lights) even when the mesh topology looks correct.
- Mesher-side orientation handling is improved for watertight surfaces, but app-level rendering behavior still needs root-cause diagnosis.
- Major hole/crack regressions now have unit-test coverage and currently pass locally, so the primary remaining implicit issue is shading/normal correctness.

2. **Quality render mode is placeholder**
- `Quality (progressive)` mode does not perform real path tracing or produce true accumulated results yet.

3. **WebGPU Playwright visual capture reliability**
- Headless Chromium screenshots may not capture WebGPU canvas pixels consistently.

4. **Vitest/Playwright test discovery overlap**
- `npm run test:run` can include Playwright test files unless narrowed or Vitest config is tightened.

## Recommended Next Steps (Engineering Priority)

1. **Finish implicit-surface correctness (Phase 3 / Phase 1 crossover)**
- Resolve wrong-side lighting on implicit surfaces (especially point-light cases) by isolating mesher normals/orientation vs renderer/material/light behavior
- Add a targeted regression for implicit lighting correctness (not just topology)
- Eventually replace marching tetrahedra polygonization with marching cubes and improve isotropy

2. **Implement Phase 4 true quality renderer**
- Replace placeholder quality mode with real progressive still renderer

3. **Phase 5 command/history hardening**
- Move from snapshot-only history to command-based undo/redo for drags and inspector edits

4. **Phase 8 testing hardening**
- Improve automated validation for WebGPU rendering (likely image export-based verification)

## Notes for Future Agents

- This project is **WebGPU-only** by design. Do not add a silent WebGL fallback unless explicitly requested.
- The root `README.md` is stale (Vite template) and should not be treated as source of truth.
- Canonical app/worker contracts live in `src/types/contracts.ts`; `src/workers/contracts.ts` is just a re-export.
- The XY grid is intentionally **not** a shadow receiver anymore. Do not reintroduce a grid shadow-catcher path unless explicitly requested.
- If debugging rendering issues, use `Render diagnostics overlay` and the built-in test scenes:
  - `/?testScene=shadow-regression`
  - `/?testScene=point-shadow-regression`
- Hard refresh after worker/mesher changes because worker bundles are cached separately by the dev server/browser.

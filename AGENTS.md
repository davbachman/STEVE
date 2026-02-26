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
- Quality mode baseline with progressive temporal accumulation (TAA), restart-on-change, and quality-aware PNG export wait behavior
- Phase 5 quality-renderer routing/diagnostics/export plumbing is in place, with `hybrid_gpu_preview` (Phase 5A fast GPU-backed accumulation) and an experimental `path` backend (Phase 5B CPU hybrid/path tracer prototype with CPU BVH/triangle acceleration and worker offload; still not production-ready)
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
- Progressive high-quality still render mode (current TAA accumulation baseline; advanced quality still renderer is a future phase)

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

- Advanced progressive still renderer beyond the current TAA accumulation baseline (future phase)

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

- Quality render mode now provides progressive temporal accumulation (TAA-based) with restart-on-change and quality-aware PNG export (waits for accumulation with timeout behavior), plus backend selection/fallback/diagnostics plumbing for Phase 5
- `Quality + Hybrid GPU Preview` (Phase 5A) now provides a fast GPU-backed backend-owned accumulation/export path using render-target captures + progressive accumulation (usable preview/export speed; realism limited vs true path tracing)
- Experimental `Quality + Path` backend (Phase 5B prototype) exists with dedicated quality accumulation/export buffer and a CPU hybrid/path tracer prototype (direct lighting, shadows, bounded bounces, transmission/IOR approximation, CPU BVH/triangle acceleration, worker offload fallback path), but it is still very slow and not yet reliable enough for normal use
- Implicit surface shading hemisphere issue is resolved in current renderer, but implicit meshing quality/topology remains in progress (marching-tetra artifacts/isotropy limits; marching cubes not yet implemented)
- Advanced realism is still incomplete (true path-traced quality renderer and robust interactive reflections/transmission stacking are future work)
- Playwright visual baselines are not fully trustworthy for WebGPU pixels in headless mode

## Phase Status (Plan Progress)

This roadmap was revised after the Phase 4 baseline landed. Phases 1–4 are complete enough for current prototype goals; post-Phase-4 development now follows a priority-aligned roadmap (Phases 5–9) described below.

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

Not complete / still in progress:

- Full marching-cubes implementation (current polygonization is still marching-tetra-based)
- Production-grade topology consistency / isotropy (marching-tetra artifacts still visible on some shapes)
- More coverage for difficult/open/clipped implicit surfaces and meshing edge cases

### Phase 4 — Real Quality Render Mode (Progressive Still Renderer)

**Status:** Implemented (progressive TAA accumulation baseline)

Implemented:

- Real progressive temporal accumulation in Quality mode (TAA-based)
- Accumulation restart-on-change behavior (camera/scene/render changes and resize)
- Quality-aware PNG export wait behavior (with timeout path/status messaging)
- Tone mapping / exposure controls wired into renderer image processing
- Quality sample progress/status reporting in UI overlays

Still needed (moved into next roadmap phase):

- Advanced quality still-render realism beyond TAA baseline (path/hybrid renderer work)
- Higher-fidelity reflections / transmission / IOR in quality mode
- Dedicated quality render buffer/export pipeline improvements

### Phase 5 — Advanced Quality Realism (True Quality Still Renderer)

**Status:** In progress (prototype implementation underway; not exit-criteria complete)

Subphase status:

- **Phase 5A — Hybrid GPU Preview backend:** Implemented (fast GPU-backed accumulation/export path complete for current prototype target)
- **Phase 5B — True path/hybrid realism core:** In progress (experimental CPU path tracer prototype; performance and reliability not yet acceptable)
- **Phase 5C — Realism polish/convergence/perf hardening:** Not complete

Priority rationale:

- User priority is realism first, with emphasis on eventual quality realism (reflections/transmission/IOR)
- Current TAA quality mode is a baseline, not the final realism path

Primary focus:

- True quality still-render pipeline (path/hybrid progressive accumulation)
- Quality-mode reflections, transmission, and IOR realism
- Quality-buffer export and convergence diagnostics

Implemented so far (current repo state):

- Quality backend router/fallback architecture (`taa_preview` + `hybrid_gpu_preview` + `path`) with diagnostics/status plumbing
- Quality render/export integration that can export backend-owned quality buffers
- `hybrid_gpu_preview` (Phase 5A): GPU-backed render-target capture accumulation path with backend-owned accumulation/export buffer and quality-mode progressive sampling at practical preview speeds
- Experimental `path` backend with dedicated float accumulation buffer, per-pixel sample counts, and convergence/export readiness tracking
- CPU hybrid/path tracer prototype (scene ray picks, direct lighting/shadows, bounded continuation bounces, roughness/transmission/IOR approximations, firefly clamp hooks)
- Recent path backend fixes: `ArcRotateCamera` capture-camera `upVector` setter sync for Z-up alignment (substantially improved placement/orientation matching) and improved transmission enter/exit IOR handling in the continuation path
- Recent Phase 5B path-core upgrades: closest-hit tracing (fixing first-hit `fastCheck` behavior), top-level trace-mesh BVH, per-mesh world-space triangle cache + per-mesh triangle BVH, and preview-biased direct-light throughput reductions (one-light finite-light sampling / reduced secondary finite-light work)
- Phase 5B worker offload is implemented: CPU path tracing batches can run in a dedicated worker with automatic fallback to main-thread CPU tracing when worker offload is unavailable or the scene snapshot is unsupported

Current blockers (important):

- Phase 5B (`path`) throughput is still far below usable targets (scene-dependent; minutes/sample at `1.0x` quality resolution is still possible on some scenes)
- Path output alignment improved after recent camera-sync fixes, but still needs wider validation across resize/quality scales/hardware-scaling setups
- CPU acceleration and worker offload are now implemented (trace-mesh BVH, per-mesh triangle BVH, worker batch tracing), but GPU traversal/path tracing is not implemented and overall throughput remains poor

### Phase 6 — Broad Command-Based Undo/Redo

**Status:** Partially implemented foundation (snapshot history exists; command history not yet implemented)

Scope:

- Broad command-history undo/redo (not transform-only)
- Drag transaction coalescing and transaction boundaries
- Inspector edits, object/light CRUD, scene/render setting edits

### Phase 7 — Save/Import Current State Hardening (Local UX + Schema)

**Status:** Partial (core local persistence exists; hardening not complete)

Implemented foundation:

- Project JSON import/export
- Local autosave
- PNG export

Still needed:

- Schema migration/versioning scaffolding
- Import validation and error UX hardening
- Autosave restore/clear UX and metadata
- Current-state workflow polish

### Phase 8 — QA / Performance / Release Hardening

**Status:** Partial foundation only

Focus:

- Validate and harden Phases 5–7 (quality realism, undo/redo, persistence)
- Broader Playwright coverage, export-based visual checks, and performance budgets

### Phase 9 — Modest Interactive Realism Upgrade (Optional, Time-Boxed)

**Status:** Deferred / optional (nice-to-have)

Constraints:

- Capability-gated, low-risk improvements only
- Time-boxed pass with explicit abort criteria if ROI/performance is poor

## Priority-Aligned Post-Phase-4 Roadmap (Supersedes Prior Ordering)

### Summary

Current starting point:

- Phase 4 baseline is complete: Quality mode now uses real progressive temporal accumulation (TAA), restart-on-change behavior, and quality-aware PNG export waiting.
- Phase 5 is split: Phase 5A (`hybrid_gpu_preview`) is implemented as the fast GPU-backed accumulation/export backend, while Phase 5B (`path`) remains an experimental CPU hybrid/path tracer and is not yet performant enough for normal use.
- Undo/redo exists but is snapshot-based.
- Local save/open/autosave/import/export exist, but reliability/UX/schema hardening is still needed.

User priorities (current):

1. Better realism, with emphasis on eventual quality realism (reflections + transmission/IOR)
2. Undo/redo
3. Save/import current state

Roadmap ordering (revised):

1. Phase 5 — Advanced Quality Realism (True Quality Still Renderer)
2. Phase 6 — Broad Command-Based Undo/Redo
3. Phase 7 — Save/Import Current State Hardening (Local UX + Schema)
4. Phase 8 — QA / Performance / Release Hardening
5. Phase 9 — Modest Interactive Realism Upgrade (Optional, Time-Boxed)

Interactive realism confidence (used for prioritization):

- Modest interactive realism upgrade (capability-gated, time-boxed): high confidence (`~80-90%`) of useful improvement
- Strong interactive realism pass: medium confidence (`~50-70%`) with higher artifact/perf risk
- High-end interactive realism (SSR + robust multi-layer transmission across many scenes/hardware): low confidence (`~20-40%`)
- Conclusion: interactive realism is intentionally deferred and kept modest; quality realism is the primary realism investment

### Phase 5 — Advanced Quality Realism (True Quality Still Renderer)

Goal:

- Make Quality mode the primary realism path with materially better reflections and transmission/IOR than interactive mode.

Why this phase comes first:

- This matches the current product priority (eventual quality realism matters more than interactive realism).
- It avoids spending disproportionate effort on fragile interactive realism paths before the still-render path is compelling.

In scope:

- Dedicated quality still-render pipeline (path-traced or hybrid ray/path progressive accumulation)
- Quality-mode reflections, transmission, and IOR as first-class features
- Dedicated quality render buffer accumulation and convergence tracking
- Quality export path that exports the quality buffer (not only transient viewport frames)
- Capability detection/fallback messaging if the advanced quality renderer cannot initialize

Current implementation snapshot (as of this file):

- The quality backend interface/router and diagnostics plumbing are implemented.
- `Quality + Hybrid GPU Preview` (Phase 5A) uses a dedicated backend-owned accumulation/export buffer driven by GPU render-target captures and progressive accumulation for usable preview/export speed.
- `Quality + Path` (Phase 5B prototype) uses a dedicated accumulation/export buffer and an experimental CPU hybrid/path tracer.
- The Phase 5B `Quality + Path` prototype currently supports direct lighting + shadows and bounded continuation bounces with basic transmission/IOR handling, plus CPU acceleration (trace-mesh BVH, per-mesh triangle BVH) and worker batch offload, but it is not yet production quality.
- Path alignment was substantially improved by fixing capture-camera `ArcRotateCamera.upVector` synchronization (Z-up internal matrix bug), but broader validation across resolution scaling/hardware scaling is still required.
- Major unresolved limitation: performance is far below usable targets (often minutes/sample at `1.0x`).

Out of scope:

- Animation/timeline rendering
- Caustics guarantees
- Cloud/distributed rendering
- Mobile support

Implementation approach:

- Split Phase 5 into:
  - Phase 5A: fast `hybrid_gpu_preview` backend (GPU-backed accumulation/export path) for practical preview speed
  - Phase 5B: true path/hybrid realism core (`path`) focusing on transport correctness/performance
  - Phase 5C: realism polish, convergence diagnostics, and quality hardening
- Keep the current TAA path as a stable quality-preview baseline/fallback while advancing the Phase 5A/5B quality backends.
- Use a dedicated offscreen accumulation buffer + sample counter separate from the raster viewport frame.
- Implement deterministic accumulation restart triggers for camera, scene/object/light/material changes, render settings changes, and resize/quality-resolution changes.
- Prioritize quality shading features in v1:
  - specular reflections
  - transmission/refraction with IOR
  - bounded multi-bounce support
  - point + directional + ambient/environment lighting contribution
- Integrate quality-buffer PNG export with target-sample waiting (default) and clear status messaging.

Exit criteria:

- Quality mode output is visibly better than interactive mode for reflective/transmissive scenes.
- IOR changes are clearly visible and stable in quality output.
- Restarts on relevant changes are reliable and deterministic.
- Quality export writes the accumulated quality buffer (not a transient raster frame).

### Phase 6 — Broad Command-Based Undo/Redo

Goal:

- Replace snapshot-style history with command-based undo/redo across core editing workflows.

In scope:

- Object/light add/remove
- Transform drags and numeric transform edits
- Inspector edits (materials, lighting, scene, render settings)
- Copy/paste/delete/duplicate object workflows
- Drag coalescing and transaction boundaries
- Preserve existing keyboard shortcut behavior from the user perspective

Out of scope:

- CodeMirror keystroke-level undo integration with app history (deferred)
- Cross-session undo history persistence

Implementation approach:

- Introduce command-history core (`dispatchCommand`, `undo`, `redo`) plus transaction helpers.
- Migrate store mutations incrementally:
  - transforms and object/light CRUD first
  - inspector property edits next
  - scene/render edits after that
- Add drag transaction lifecycle:
  - pointer down = begin transaction
  - pointer move = coalesce updates
  - pointer up = commit
  - cancel/escape = abort active transaction (where applicable)
- Ensure workerized plot updates and mesh refreshes remain correct across undo/redo.

Exit criteria:

- Mixed edit sequences undo/redo correctly without exploding history length.
- Dragging produces coalesced history entries.
- Redo invalidates correctly after new edits.
- Worker-driven plot refreshes remain stable after undo/redo.

### Phase 7 — Save/Import Current State Hardening (Local UX + Schema)

Goal:

- Make local save/open/autosave/import workflows reliable, user-friendly, and forward-compatible.

In scope:

- Schema versioning and migration scaffolding
- Import validation and structured error reporting
- Autosave restore/clear UX and metadata
- Local save/open/import status and UX polish
- Current-state export workflow improvements (within local-first scope)

Out of scope:

- Cloud sync/collaboration
- Remote backups
- Non-JSON project formats (unless trivial additions are clearly justified)

Implementation approach:

- Add centralized parse/validate/migrate entrypoint before state replacement.
- Introduce `ProjectFileV2` plus migration from existing project files.
- Harden import UX for malformed JSON, unsupported versions, invalid object/material/equation shapes, and enum validation failures.
- Add autosave restore prompt and clear flow with metadata (timestamp/version/object counts).
- Keep current local JSON flow; improve status/error messaging consistency.

Exit criteria:

- Invalid imports fail safely without mutating current project state.
- Existing saved projects continue to load via migration path.
- Autosave restore/clear is visible and reliable.
- Save/open/import status messaging is consistent and actionable.

### Phase 8 — QA / Performance / Release Hardening (for Phases 5–7)

Goal:

- Stabilize and verify the quality-renderer, undo/redo, and persistence upgrades before deeper optional rendering work.

In scope:

- Automated coverage for quality-mode convergence/export behavior
- Undo/redo regression matrix (including drag coalescing)
- Persistence validation/migration/autosave restore tests
- Performance instrumentation and budgets for quality rendering and key workflows

Implementation approach:

- Unit tests for command history correctness, coalescing, import validation, and migrations.
- Playwright workflows for quality mode/export, undo/redo, and save/open/autosave/import failures.
- Prefer app PNG export artifacts for visual verification where direct WebGPU screenshots are unreliable.
- Add diagnostics for quality sample throughput and relevant fallback reasons.

Exit criteria:

- Core prioritized workflows are regression-tested and stable.
- Quality export path is reliable enough for iterative use.
- Performance regressions are measurable and visible in diagnostics.

### Phase 9 — Modest Interactive Realism Upgrade (Optional, Time-Boxed)

Goal:

- Deliver bounded improvements to interactive realism without delaying the higher-priority roadmap phases.

Why deferred:

- Interactive realism has lower ROI for current goals and a lower confidence ceiling if scoped aggressively.
- This phase is a nice-to-have after quality realism, undo/redo, persistence, and QA hardening.

In scope (strictly modest):

- Capability-gated reflection improvements where low-risk
- Glass/transmission preset tuning and basic ordering improvements
- Diagnostics/fallback clarity
- No attempt to match quality-renderer realism

Out of scope:

- Broad SSR/transparency pipeline overhaul
- “Quality-like” interactive realism guarantees
- Deep renderer surgery that destabilizes the quality path

Implementation approach:

- Prioritize low-risk wins first (environment/planar tuning, material preset calibration, targeted sorting fixes).
- Add explicit diagnostics/fallback reasons rather than silent degradation.
- Time-box implementation; stop if gains are small relative to complexity or perf cost.

Success criteria:

- Noticeable improvement in common glass/metal demo scenes.
- No major performance regressions on target desktop setup.
- No destabilization of quality mode or core editing workflows.

Abort criteria:

- Improvements require deep renderer surgery with uncertain outcomes.
- Cross-hardware instability becomes the primary task.
- Performance cost exceeds budget with minimal visual gain.

### Planned API / Interface / Type Changes (Roadmap)

#### Phase 5 status (Quality Realism API / diagnostics)

- `RenderSettings` additions (implemented):
  - `qualityRenderer` (e.g. `'taa_preview' | 'hybrid_gpu_preview' | 'path'`)
  - `qualityMaxBounces`
  - `qualityClampFireflies`
  - `qualityEarlyExportBehavior` (default `'wait'`)
- `RenderDiagnostics` additions (implemented):
  - active quality renderer path
  - quality resolution
  - samples/sec
  - last reset reason
- `ViewportApi.exportPng(options?)` quality-aware behavior is implemented through the existing API (wait/immediate export behavior, backend export buffer selection)

#### Phase 6 planned (Undo/Redo)

- Command-history interfaces/types (proposed):
  - `HistoryCommand`
  - `HistoryTransaction`
- Store actions (proposed):
  - `dispatchCommand`
  - `beginHistoryTransaction`
  - `commitHistoryTransaction`
  - `cancelHistoryTransaction`

#### Phase 7 planned (Save/Import)

- Persistence schema/types (proposed):
  - `ProjectFileV2`
  - validation/migration entrypoint (e.g. `parseValidateMigrateProjectFile(...)`)
  - structured `ProjectImportError` / `ProjectImportResult`
  - autosave metadata types (timestamp/version/object counts)

#### Phase 9 planned (Modest Interactive Realism)

- Minimal capability-gated settings/diagnostics only if needed:
  - `interactiveReflections`
  - interactive reflection path/fallback diagnostics

### Test Cases and Scenarios (Roadmap)

#### Phase 5 — Quality Realism

- Quality mode convergence reaches target samples and idles.
- Accumulation restarts on camera/scene/material/light/render/resize changes.
- Reflective/transmissive scenes show visible quality-mode improvement over interactive mode.
- IOR changes produce stable, visible differences in quality output.
- Quality export waits for target samples by default and exports the quality buffer.
- Unsupported quality path fails gracefully with clear status/fallback behavior.

#### Phase 6 — Undo/Redo

- Coalesced drag transaction produces one undo step.
- Mixed sequence (`add -> move -> material edit -> delete`) round-trips through undo/redo.
- Redo stack clears after new edits.
- Plot worker mesh updates remain correct after undo/redo of plot changes.
- Keyboard shortcuts still behave correctly around editor focus.

#### Phase 7 — Save/Import

- Valid older project files migrate and load successfully.
- Malformed JSON fails with clear messaging and no state mutation.
- Structurally invalid project data fails safely.
- Autosave restore prompt appears for newer autosave and restore works.
- Autosave clear removes stale restore state.
- Save/open/import status messages are consistent and accurate.

#### Phase 8 — QA / Performance

- Playwright end-to-end quality export workflow.
- Playwright undo/redo editing workflow.
- Playwright save/open/autosave restore/import error workflow.
- Export-based visual regression checks for selected quality scenes.
- Performance smoke checks for quality sample throughput and memory sanity.

#### Phase 9 — Modest Interactive Realism

- Capability-gated reflection path selection and fallback messaging.
- Common glass/metal scenes show visible improvement.
- No critical performance regressions in target scenes.

### Assumptions and Defaults (Roadmap)

- Quality realism is the primary realism investment; interactive realism is deferred and optional.
- Interactive realism should remain modest and time-boxed unless the user explicitly changes priorities.
- Undo/redo priority means broad command-history coverage, not transform-only history.
- Save/import priority means local UX + schema migration/validation hardening, not cloud sync.
- WebGPU-only policy remains unchanged.
- CodeMirror editor undo remains separate from app undo/redo in the first command-history phase.
- Quality mode currently ships as a TAA accumulation baseline; true quality still-render realism begins in Phase 5.

## Known Issues / Current Bugs (As of This File)

1. **Phase 5 path renderer is experimental and currently unreliable**
- `Quality (progressive)` now has three relevant paths: stable `TAA` baseline, fast `Hybrid GPU Preview` (Phase 5A), and experimental `Quality + Path` (Phase 5B CPU hybrid/path tracer prototype).
- Current known blockers for `Quality + Path`: very slow convergence (minutes/sample at `1.0x` on some scenes), remaining alignment/validation work across resolutions/hardware scaling, worker-offload/runtime hardening and tuning, and no GPU traversal/path tracing yet (CPU BVH/triangle acceleration + worker offload are implemented).

2. **Interactive realism is intentionally limited (for now)**
- Advanced reflections/transmission realism in interactive mode is deferred to a later modest, time-boxed phase.
- The primary realism investment is the quality renderer path.

3. **WebGPU Playwright visual capture reliability**
- Headless Chromium screenshots may not capture WebGPU canvas pixels consistently.

4. **Vitest/Playwright test discovery overlap**
- `npm run test:run` can include Playwright test files unless narrowed or Vitest config is tightened.

## Recommended Next Steps (Engineering Priority)

Interactive realism was evaluated as lower-confidence / lower-priority for current goals. Quality realism is the primary realism investment, so the next phases should follow the revised ordering below.

1. **Phase 5B/5C — Advance the true quality renderer path after Phase 5A**
- Phase 5A (`Hybrid GPU Preview`) is complete for the current prototype goal and should be used for practical quality previews/exports.
- Next priority: validate remaining `Quality + Path` alignment edge cases across resize/quality-resolution/hardware-scaling scenarios, then harden/tune the existing Phase 5B CPU path stack (worker fallback diagnostics, snapshot compatibility, batching/buffer pooling, worker startup/bundle size, BVH traversal optimizations) before further realism tuning and eventual GPU path/hybrid path work.

2. **Phase 6 — Command-based undo/redo**
- Replace snapshot-style history with broad command-history coverage, drag coalescing, and transaction boundaries.

3. **Phase 7 — Save/import current state hardening**
- Add schema migration/validation, autosave restore/clear UX, and stronger local save/open/import reliability.

4. **Phase 8 — QA / performance hardening**
- Add regression coverage and performance diagnostics for the quality renderer, undo/redo, and persistence flows.

5. **Phase 9 — Modest interactive realism upgrade (optional, time-boxed)**
- Apply low-risk, capability-gated interactive realism improvements only after the higher-priority phases are stable.

## Notes for Future Agents

- This project is **WebGPU-only** by design. Do not add a silent WebGL fallback unless explicitly requested.
- The root `README.md` is stale (Vite template) and should not be treated as source of truth.
- Canonical app/worker contracts live in `src/types/contracts.ts`; `src/workers/contracts.ts` is just a re-export.
- The XY grid is intentionally **not** a shadow receiver anymore. Do not reintroduce a grid shadow-catcher path unless explicitly requested.
- If debugging rendering issues, use `Render diagnostics overlay` and the built-in test scenes:
  - `/?testScene=shadow-regression`
  - `/?testScene=point-shadow-regression`
- Hard refresh after worker/mesher changes because worker bundles are cached separately by the dev server/browser.
- Quality realism (advanced still renderer) is prioritized over interactive realism in the current roadmap.
- Experimental Phase 5 quality work currently lives in `src/renderer/qualityBackends.ts` (router + `TaaPreviewQualityBackend` + `PathQualityBackendV1` modes for `hybrid_gpu_preview` and `path`).
- Phase 5A (`Quality + Hybrid GPU Preview`) is the fast GPU-backed accumulation/export backend and is currently the practical way to preview quality output while Phase 5B path tracing matures.
- `Quality + Path` remains a CPU hybrid/path tracer prototype with severe throughput limitations; alignment is improved after the capture-camera `upVector` setter fix, but still validate side-by-side at `Samples >= 1` across resize/quality scale/hardware scaling combinations.
- Phase 5B CPU path tracing now includes top-level trace-mesh BVH, per-mesh triangle caches, per-mesh triangle BVHs, and worker batch offload (with fallback to main-thread CPU tracing when offload is unavailable/unsupported).
- Worker offload implementation lives in `src/workers/pathTraceQualityWorker.ts` with protocol types in `src/workers/pathTraceQualityWorkerContracts.ts`.
- `vite.config.ts` includes `worker.format = 'es'` for the Phase 5B path worker bundle; keep this in mind if changing worker build config.
- Interactive realism is intentionally deferred and should be scoped as a modest, time-boxed pass unless priorities change.
- Do not re-promote a broad interactive realism overhaul ahead of undo/redo or save/import hardening unless the user explicitly changes priorities.
- The implicit lighting hemisphere issue is considered resolved unless new evidence/regressions appear.

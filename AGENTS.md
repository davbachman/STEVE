# AGENTS.md

## App Overview
This repository contains a desktop-first, browser-only 3D equation graphing app built on Babylon.js WebGPU.

The app supports:
- Parametric curves `(x(t), y(t), z(t))`
- Parametric surfaces `(x(u,v), y(u,v), z(u,v))`
- Implicit surfaces `F(x,y,z)=0`
- Explicit single-axis surfaces (`z=f(x,y)`, `x=g(y,z)`, `y=h(x,z)`)

Current product direction is interactive rendering. The legacy quality renderer code remains for compatibility/reference.

## Core Capabilities
- Multi-object 3D scenes with plot objects and point lights
- Equation editing with live parse/classification and LaTeX preview
- Interactive PBR materials, lighting, shadows, and reflections
- Object selection/dragging and inspector editing
- Local save/load/autosave and PNG export
- Worker-based parse/meshing pipeline for responsiveness

## Tech Stack
- React + TypeScript + Vite
- Zustand + Immer
- CodeMirror 6 + KaTeX
- Babylon.js (`@babylonjs/core`) on WebGPU
- Web Workers for parsing and meshing
- Dexie/IndexedDB for local persistence
- Vitest + Playwright for testing

## Repository Structure
- `package.json`: scripts and dependencies
- `playwright.config.ts`: Playwright setup
- `AGENTS.md`: repository guide

- `src/`
  - `App.tsx`: app shell/layout and global shortcuts
  - `main.tsx`: app bootstrap and fatal error overlay
  - `types/contracts.ts`: shared app/worker contracts and runtime types

  - `state/`
    - `defaults.ts`: default scene/render/material settings
    - `store.ts`: Zustand state/actions/history/import normalization
    - `renderCompat.ts`: render compatibility coercion helpers

  - `math/`
    - Parsing/classification/LaTeX/evaluation/compile pipeline
    - `mesh/`: parametric and implicit meshing code

  - `workers/`
    - `mathWorker.ts`: parse/classify worker
    - `meshWorker.ts`: meshing worker
    - `runtimeMeshCache.ts`: runtime mesh handoff cache
    - `pathTraceQualityWorker*.ts`: legacy quality worker code

  - `hooks/`
    - `useAutosave.ts`: autosave integration
    - `useWorkerPipeline.ts`: parse/mesh job orchestration

  - `renderer/`
    - `Viewport3D.tsx`: canvas host and renderer overlays
    - `SceneController.ts`: Babylon scene/material/light/input orchestration
    - `qualityBackends.ts`: legacy quality backend implementations

  - `ui/components/`
    - `TopBar.tsx`: file actions, autosave controls, export, quality selector
    - `ObjectListPanel.tsx`: object/light creation and list
    - `EquationEditor.tsx`: equation editor and diagnostics
    - `InspectorPanel.tsx`: object/material/scene/render controls
    - `LatexPreview.tsx`: rendered math preview

  - `persistence/`
    - `db.ts`: IndexedDB wrapper
    - `projectFile.ts`: project import/export helpers

  - `testing/testScenes.ts`: built-in deterministic test scenes

- `tests/e2e/`: Playwright end-to-end scenarios

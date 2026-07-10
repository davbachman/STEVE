# AGENTS.md

## App Overview
This repository contains a desktop-first, browser-only 3D equation graphing app built on an in-repo WebGL2 renderer.

The app supports:
- Parametric curves `(x(t), y(t), z(t))`
- Parametric surfaces `(x(u,v), y(u,v), z(u,v))`
- Implicit surfaces `F(x,y,z)=0`
- Explicit single-axis surfaces (`z=f(x,y)`, `x=g(y,z)`, `y=h(x,z)`)

Current product direction is interactive rendering only. The Babylon and legacy quality-renderer paths have been removed from the active app.

## Core Capabilities
- Multi-object 3D scenes with plot objects and point lights
- Equation editing with live parse/classification and LaTeX preview
- Animated equation constants (per-parameter play/pause and speed, ping-pong between bounds)
- Perspective and orthographic camera projections
- Interactive PBR materials, lighting, shadows, reflections (per-plot probes plus a planar ground mirror), and screen-space refraction
- Object selection/dragging and inspector editing
- Local save/load and PNG/STL export
- Worker-based parse/meshing pipeline for responsiveness

## Tech Stack
- React + TypeScript + Vite
- Zustand + Immer
- CodeMirror 6 + KaTeX
- Raw WebGL2 + `gl-matrix`
- Web Workers for parsing and meshing
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

  - `math/`
    - Parsing/classification/LaTeX/evaluation/compile pipeline
    - `mesh/`: parametric and implicit meshing code

  - `workers/`
    - `mathWorker.ts`: parse/classify worker
    - `meshWorker.ts`: meshing worker
    - `runtimeMeshCache.ts`: runtime mesh handoff cache

  - `hooks/`
    - `useWorkerPipeline.ts`: parse/mesh job orchestration
    - `useParameterAnimation.ts`: rAF driver for animated equation constants

  - `renderer/`
    - `Viewport3D.tsx`: canvas host and renderer overlays
    - `SceneController.ts`: WebGL2 scene/render/input orchestration
    - `plotGeometry.ts`: renderer-ready geometry conversion and CPU picking helpers

  - `ui/components/`
    - `TopBar.tsx`: file actions, export, quality selector
    - `ObjectListPanel.tsx`: object/light creation and list
    - `EquationEditor.tsx`: equation editor and diagnostics
    - `InspectorPanel.tsx`: object/material/scene/render controls
    - `LatexPreview.tsx`: rendered math preview

  - `persistence/`
    - `projectFile.ts`: project import/export helpers
    - `meshExport.ts`: STL export helpers

  - `testing/testScenes.ts`: built-in deterministic test scenes

- `tests/e2e/`: Playwright end-to-end scenarios

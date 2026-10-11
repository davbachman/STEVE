# Getting Started

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

## Quick Start

1. [Open the live app](https://davbachman.github.io/STEVE/). Your last local session is restored when available. A new project begins with ambient lighting and `Directional Light 1`; its **On/Off** button controls illumination, and **Handle** shows its draggable viewport gizmo.
2. Under **Curve**, choose `+ Parametric` or `+ Intersection`. Under **Surface**, choose `+ Graph`, `+ Parametric`, or `+ Implicit`. Under **Lights**, choose `+ Point` or `+ Directional`.
3. Select a plot in the object list, then replace its example equation in the editor across the top. Use **Collapse** at the editor’s top right to reclaim drawing space, and **Expand** to edit again. Long definitions scroll within the expanded panel. Select a light to edit its controls in the right inspector.
4. For plots and lights, use the **Object** tab for name, position, domain, sampling, bounds, quality, equation constants, or curve pinning. An intersection's Object tab selects its source surfaces and adjusts its width. Use **Appearance** for material or light properties.
5. Click empty viewport space or press `Esc` to clear the selection and show **Scene Settings** in the right panel.
6. Move around the viewport with right-drag to orbit, `Shift` + right-drag to pan, and the scroll wheel to zoom. Left-drag a selected plot or unpinned light to move it in the XY plane; hold `Shift` while left-dragging to change its Z position.
7. Use **File** to start a new project, save/open a project, export a PNG, or export the selected plot/intersection as STL. Use **STEVE → Settings** for rendering and export-quality controls.

The **STEVE** menu also contains the About dialog, an **Instructions** link to the [documentation home](../README.md), and a Feedback form. Sending feedback opens a draft in your default email app.

## Features

- Plot parametric curves `(x(t), y(t), z(t))`, parametric surfaces `(x(u,v), y(u,v), z(u,v))`, implicit surfaces `F(x,y,z)=0`, and explicit surfaces solved for `x`, `y`, or `z`.
- Use the streamlined Graph workflow for `z=f(x,y)` by entering only `f(x,y)`.
- Derive an intersection curve from any two surface objects; the curve updates when either source surface is edited, moved, or animated.
- Combine plots, intersection curves, point lights, and directional lights in one scene.
- Pin point or directional lights to parametric curves, scrub their curve parameter, and animate them with endpoint-aware bounce or loop playback.
- Edit equations with function autocomplete, an on-demand syntax reference, automatic equation classification, a live LaTeX preview, and inline error messages.
- Reuse expressions with [multiline local definitions](equations.md#multiline-definitions), a multiline math preview, and an editor that collapses to leave room for the canvas.
- Turn adjustable equation constants into continuous sliders, ping-pong animations, or discrete families of sampled copies.
- Record full-detail animated-constant loops, curve-pinned light paths, and camera turntable loops as GIF files.
- Rename and reposition plots and lights, edit curve/surface domains and sampling density, and choose implicit-meshing bounds and quality.
- Style objects with material presets, color, opacity, reflectiveness, roughness, refraction, index of refraction, and emissive color/strength.
- Add a UV-style grid to parametric and explicit surfaces, or add independently colored and spaced X/Y/Z contour lines to surfaces.
- Configure ambient, point, and directional lighting; soft directional and point-light shadows; solid or gradient backgrounds; an optional reflective ground plane; the XY grid; axes; and numbered axis labels.
- Choose perspective or orthographic projection, use axis-aligned view presets, frame a selection, or run a continuous turntable animation.
- Tune ACES, Filmic, or un-tonemapped output, exposure, light halos, and interactive rendering quality.
- Work with visible undo/redo and duplicate/delete controls, object copy/paste, visibility controls, collapsible sidebars, and live mesh-progress/error indicators.
- Save and reopen scene objects, camera pose, and scene/render settings, recover the last local session, export PNG images at 1×/2×/4×, and export plots or intersection curves as STL meshes.
- Keep equation parsing and meshing responsive through browser workers; no application install or server-side renderer is required.

---

[Table of contents](../README.md#table-of-contents) · [Next: Equations and Local Definitions](equations.md)

# ST.E.V.E.

**STudio for Equation Visualization and Experimentation**

Created by David Bachman with GPT 5.4, GPT 5.5, GPT 5.6 Sol, and Fable 5

To learn more about David Bachman and his work visit https://pzacad.pitzer.edu/~dbachman/ and subscribe to his AI substack *Entropy Bonus* at https://profbachman.substack.com

ST.E.V.E. is a browser-only interactive 3D graphing app for exploring mathematical objects as editable scene elements. It supports parametric curves, parametric surfaces, implicit surfaces, explicit single-axis surfaces, and movable point lights inside the same scene.

## What It Does

- Graphs parametric curves in 3D.
- Graphs parametric surfaces defined by `(x(u,v), y(u,v), z(u,v))`.
- Graphs implicit surfaces defined by `F(x,y,z)=0`.
- Graphs explicit surfaces along a single axis such as `z=f(x,y)`, `x=g(y,z)`, or `y=h(x,z)`.
- Lets you combine multiple plots and lights in one scene.
- Animates equation constants: press play on any constant's slider to sweep it between its bounds while the surface re-meshes live.
- Supports perspective and orthographic camera projections, with Top/Front/Side view presets, camera reset, and double-click to frame an object.
- Draws numbered tick labels along the axes (toggle in Scene settings).
- Exports viewport images at 1×, 2×, or 4× resolution for publication-quality figures.
- Supports interactive materials, shadows, reflections (including a mirror-like ground plane), screen-space refraction for glass-like surfaces, and adjustable render quality.
- Saves scenes as project files, exports viewport images as PNG, and exports selected plots as STL.

## Usage

1. ST.E.V.E. starts with an empty scene. Create objects from the left panel with `+ Curve`, `+ Surface`, `+ Implicit`, and `+ Light`.
2. Select an object from the object list to edit it. Plot objects open in the equation editor, and lights open in the inspector.
3. Enter or revise the equation for the selected plot. ST.E.V.E. classifies the expression and updates the preview and mesh when the expression is valid.
4. When ST.E.V.E. detects user-defined constants in a parametric or implicit equation, it adds them to the `Object` inspector under `Constants`.
5. Constants default to `Continuous`, which evaluates the plot at one parameter value; press the play button to animate a constant between its bounds, and park the slider at either end and type in its box to move that end of the range.
6. Switching a constant to `Discrete` keeps the same range slider interaction and adds `num copies`. The value slider snaps between those equally spaced levels and shows one copy at a time; press play to show every copy at once. Park the slider at either end and type to set the shared minimum or maximum.
7. Use the right inspector tabs to change object name, position, domain bounds, sampling density, material settings, lighting, scene options, and render settings.
8. Navigate the viewport with right-drag to orbit and `Shift` + right-drag to pan. Drag selected objects with left-drag, and use `Shift` + left-drag to constrain object dragging along Z. Use the Top/Front/Side buttons for axis-aligned views, `⌂` to reset the camera, and double-click (or `⛶`) to frame objects.
9. Toggle visibility for plots and light gizmos from the object list to isolate parts of a scene while editing.
10. Use the `File` menu to create a new project, save the current scene as a `.json` file, or open a previously saved project.
11. Choose `File` → `Export PNG` to save the current viewport as an image.
12. Select a plot object and choose `File` → `Export STL` to export its current triangle mesh for use in 3D modeling or fabrication workflows.
13. Choose `STEVE` → `Settings` to set PNG export quality and interactive rendering quality.

## Notes

- User-defined constants are discovered from the equation text automatically; built-in constants such as `pi` and `e` are not exposed as editable controls.
- Playing a discrete constant produces a rendered family inside a single plot object rather than duplicating entries in the object list.
- `Export STL` applies to plot objects only, not point lights.
- The STL export reflects the plot's current generated mesh and current position in the scene.
- Curves export as their rendered mesh representation rather than as abstract mathematical paths.

# ST.E.V.E.

**STudio for Equation Visualization and Experimentation**

Created by David Bachman with GPT-5.4

To learn more about David Bachman and his work visit https://pzacad.pitzer.edu/~dbachman/ and subscribe to his AI substack *Entropy Bonus* at https://profbachman.substack.com

ST.E.V.E. is a browser-only interactive 3D graphing app for exploring mathematical objects as editable scene elements. It supports parametric curves, parametric surfaces, implicit surfaces, explicit single-axis surfaces, and movable point lights inside the same scene.

## What It Does

- Graphs parametric curves in 3D.
- Graphs parametric surfaces defined by `(x(u,v), y(u,v), z(u,v))`.
- Graphs implicit surfaces defined by `F(x,y,z)=0`.
- Graphs explicit surfaces along a single axis such as `z=f(x,y)`, `x=g(y,z)`, or `y=h(x,z)`.
- Lets you combine multiple plots and lights in one scene.
- Animates equation constants: press play on any constant's slider to sweep it between its bounds while the surface re-meshes live.
- Supports perspective and orthographic camera projections.
- Supports interactive materials, shadows, reflections (including a mirror-like ground plane), screen-space refraction for glass-like surfaces, and adjustable render quality.
- Saves scenes as project files, exports viewport images as PNG, and exports selected plots as STL.

## Usage

1. Create objects from the left panel with `+ Curve`, `+ Surface`, `+ Implicit`, and `+ Light`.
2. Select an object from the object list to edit it. Plot objects open in the equation editor, and lights open in the inspector.
3. Enter or revise the equation for the selected plot. ST.E.V.E. classifies the expression and updates the preview and mesh when the expression is valid.
4. Use the right inspector tabs to change object name, position, domain bounds, sampling density, material settings, lighting, scene options, and render settings.
5. Navigate the viewport with right-drag to orbit and `Shift` + right-drag to pan. Drag selected objects with left-drag, and use `Shift` + left-drag to constrain object dragging along Z.
6. Toggle visibility for plots and light gizmos from the object list to isolate parts of a scene while editing.
7. Use `Save` to write the current scene as a `.json` project file and `Open` to load a previously saved project.
8. Use `Export PNG` to save the current viewport as an image.
9. Select a plot object and use `Export STL` to export that plot's current triangle mesh for use in 3D modeling or fabrication workflows.

## Notes

- `Export STL` applies to plot objects only, not point lights.
- The STL export reflects the plot's current generated mesh and current position in the scene.
- Curves export as their rendered mesh representation rather than as abstract mathematical paths.

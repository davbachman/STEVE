# Files, Recovery, and Exports

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

- **File → Save** writes scene objects, camera pose, and scene/render settings to `scene.3dplot.json` by default. **Open** accepts `.json` and `.3dplot.json` project files and validates them before replacing the scene. Current selection and open UI state are not stored.
- **File → Export PNG** saves the current viewport. Choose Standard (1×), High (2×), or Ultra (4×) under **STEVE → Settings**.
- **Record loop** exports GIF animation from the Scene turntable controls, a playing continuous constant, or an animated curve-pinned light. The current object selection is temporarily cleared while frames are captured and restored when recording finishes or is canceled, keeping selection outlines and light gizmos out of the GIF. GIF maximum size and target frame rate are configured under **STEVE → Settings**.
- **File → Export STL** is available when a plot or intersection is selected. It captures the current equations and settings, then builds a fresh mesh at the requested full sampling/quality in a browser worker. Intersections use the captured source surfaces and their positions. The export preserves world position and discontinuity gaps; visual material and lighting settings are not part of STL. Invalid equations must be fixed before exporting.
- Parametric curves and intersection curves export their rendered tube/ribbon geometry, not abstract mathematical paths.
- STL export does not guarantee a closed or watertight solid; inspect open surfaces before using them for 3D printing.

All files stay under your control through the browser's save dialog or download folder.

ST.E.V.E. automatically keeps a recovery copy in this browser and restores it on the next visit. The top bar shows whether there are unsaved changes. **New** and **Open** offer **Save and continue**, **Discard changes**, or **Cancel** before replacing unsaved work; leaving the page also requests a browser warning. Use **File → Save** for a permanent copy, since clearing browser storage removes local recovery. File-operation and recovery errors appear onscreen.

---

[Previous: Viewport Controls and Keyboard Shortcuts](controls.md) · [Table of contents](../README.md#table-of-contents) · [Next: Practical Limits](practical-limits.md)

# Appearance, Lighting, and Scene Controls

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

The **Appearance** tab provides Matte Plastic, Glossy Plastic, Ceramic, Brushed Metal, Chrome, Neon Yellow, Clear Glass, Frosted Glass, Tinted Glass, Rubber, and Mirror presets. New parametric curves use Ceramic by default, while intersection curves use the emissive Neon Yellow preset. Presets can be customized with the material controls. Refraction takes effect when opacity is below 1. **Surface Decorations** contains grid controls for parametric/explicit surfaces and X/Y/Z contour controls for non-curve plot surfaces.

Point lights provide position, color, intensity, range, and shadow controls. Directional lights provide position, color, intensity, and shadows. Their viewport gizmo is an arrow with a draggable handle at its tail; both the arrow and the light rays always point from that position toward the world origin. Both light types can be pinned to a parametric curve from the Object tab. Use a light's **On/Off** button to switch illumination without losing its intensity setting; its separate **Handle** checkbox only shows or hides the editor gizmo.

With nothing selected, **Scene Settings** controls the turntable, ambient light, shadow-map resolution and softness, projection, background, ground plane and reflection, XY grid, axes, and axis labels. **STEVE → Settings** controls tone mapping, exposure, Halos, PNG export scale, GIF maximum size and frame rate, and interactive quality.

Interactive quality adjusts viewport pixel density, shadow resolution, and reflection detail. This selector does not change equation sampling. Stationary scenes stop redrawing once their reflections settle, and unchanged shadows are reused.

---

[Previous: Surface Intersections](intersections.md) · [Table of contents](../README.md#table-of-contents) · [Next: Viewport Controls and Keyboard Shortcuts](controls.md)

# ST.E.V.E.

**STudio for Equation Visualization and Experimentation**

**[Open ST.E.V.E. in your browser](https://davbachman.github.io/STEVE/)**

ST.E.V.E. is a desktop-first, browser-only 3D graphing studio. Build multi-object scenes from equations, edit them interactively, light and style them, animate mathematical constants, and export still images, GIF loops, project files, or triangle meshes.

ST.E.V.E. requires a modern desktop browser with WebGL2. Floating-point color-buffer support is recommended for the full rendering path; the app provides a compatibility fallback when it is unavailable.

Created by David Bachman with GPT 5.4, GPT 5.5, GPT 5.6 Sol, and Fable 5. Learn more at [David Bachman Design](https://davidbachmandesign.com) and subscribe to the AI newsletter [Entropy Bonus](https://profbachman.substack.com).

## Features

- Plot parametric curves `(x(t), y(t), z(t))`, parametric surfaces `(x(u,v), y(u,v), z(u,v))`, implicit surfaces `F(x,y,z)=0`, and explicit surfaces solved for `x`, `y`, or `z`.
- Use the streamlined Graph workflow for `z=f(x,y)` by entering only `f(x,y)`.
- Derive an intersection curve from any two surface objects; the curve updates when either source surface is edited, moved, or animated.
- Combine plots, intersection curves, point lights, and directional lights in one scene.
- Edit equations with function autocomplete, an on-demand syntax reference, automatic equation classification, and a live LaTeX preview.
- Turn user-defined equation constants into continuous sliders, ping-pong animations, or discrete families of sampled copies.
- Record full-detail animated-constant loops and camera turntable loops as GIF files.
- Rename and reposition plots and lights, edit curve/surface domains and sampling density, and choose implicit-meshing bounds and quality.
- Style objects with material presets, color, opacity, reflectiveness, roughness, refraction, index of refraction, and emissive color/strength.
- Add a UV-style grid to parametric and explicit surfaces, or add independently colored and spaced X/Y/Z contour lines to surfaces.
- Configure ambient, point, and directional lighting; soft directional and point-light shadows; solid or gradient backgrounds; an optional reflective ground plane; the XY grid; axes; and numbered axis labels.
- Choose perspective or orthographic projection, use axis-aligned view presets, frame a selection, or run a continuous turntable animation.
- Tune ACES, Filmic, or un-tonemapped output, exposure, light halos, and interactive rendering quality.
- Work with undo/redo, object copy/paste, keyboard deletion, visibility controls, collapsible sidebars, and live mesh-progress/error indicators.
- Save and reopen scene objects plus scene/render settings, export PNG images at 1×/2×/4×, and export plots or intersection curves as STL meshes.
- Keep equation parsing and meshing responsive through browser workers; no application install or server-side renderer is required.

## Quick Start

1. [Open the live app](https://davbachman.github.io/STEVE/). A new project begins with `Directional Light 1`; add mathematical objects and more lights from the left panel.
2. Under **Curve**, choose `+ Parametric` or `+ Intersection`. Under **Surface**, choose `+ Graph`, `+ Parametric`, or `+ Implicit`. Under **Lights**, choose `+ Point` or `+ Directional`.
3. Select a plot in the object list, then replace its example equation in the editor across the top. Select a light to edit its controls in the right inspector.
4. For plots and lights, use the **Object** tab for name, position, domain, sampling, bounds, quality, light direction, or equation constants. An intersection's Object tab selects its source surfaces and adjusts its width. Use **Appearance** for material or light properties.
5. Click empty viewport space or press `Esc` to clear the selection and show **Scene Settings** in the right panel.
6. Move around the viewport with right-drag to orbit, `Shift` + right-drag to pan, and the scroll wheel to zoom. Left-drag a selected plot or light to move it in the XY plane; hold `Shift` while left-dragging to change its Z position.
7. Use **File** to start a new project, save/open a project, export a PNG, or export the selected plot/intersection as STL. Use **STEVE → Settings** for rendering and export-quality controls.

The **STEVE** menu also contains the About dialog, this Instructions page, and a Feedback form. Sending feedback opens a draft in your default email app.

## Equation Input

| Object or form | What to enter | Example |
| --- | --- | --- |
| Curve → Parametric | A 3-tuple using `t` | `(cos(t), sin(t), 0.2*t)` |
| Surface → Graph | A function of `x` and `y`; `z=` is supplied | `x^2 - y^2` |
| Surface → Parametric | A 3-tuple using `u` and `v` | `((2+0.7*cos(v))*cos(u), (2+0.7*cos(v))*sin(u), 0.7*sin(v))` |
| Surface → Implicit | An equality involving `x`, `y`, and/or `z` | `x^2 + y^2 + z^2 = 4` |
| Explicit surface | An equality solved for one axis | `x = y^2 + z^2`, `y = sin(x) + z`, or `z = x*y` |

Graph objects intentionally accept only the `f(x,y)` shorthand. To enter a full `x=`, `y=`, or `z=` equation, start with a non-Graph plot—for example **Surface → Parametric**—and replace its equation. ST.E.V.E. reclassifies the object automatically.

The equation language supports:

- Operators: `+`, `-`, `*`, `/`, and `^`.
- Constants: `pi` and `e`.
- Functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`, `cosh`, `tanh`, `exp`, `log`, `ln`, `sqrt`, and `abs`. `log` is base 10; `ln` is natural log.
- Adjustable constants: other letters such as `a`, `b`, or `c` become controls under **Object → Constants**.

Click the `ƒx` button beside the editor for the in-app syntax reference. Numeric inspector fields also accept expressions such as `pi/2` and `sqrt(2)`; press `Enter` or leave the field to apply a typed value.

## Constants, Families, and GIFs

Every user-defined constant starts in **Continuous** mode:

1. Drag **Value** to evaluate the object at a particular value.
2. Put the slider at its minimum or maximum and type a new endpoint into the number field to change that end of the range.
3. Press play to sweep continuously between the endpoints. While it is playing, adjust the constant's speed or choose **Record loop** to export one full ping-pong cycle as a GIF.

Switch the mode button to **Discrete** to sample equally spaced levels instead. Set **num copies**, use the value slider to show one level, or press play to show all levels at once. Multiple discrete constants that are showing all copies produce every combination of their sampled values, so high copy counts can make a scene expensive to mesh and draw.

To record a camera orbit, clear the object selection, enable **Turntable animation** in Scene Settings, set **Orbit speed**, and choose **Record loop**. GIF exports preserve the viewport aspect ratio and are limited to 720 pixels on their longest side.

## Surface Intersections

1. Choose **Curve → + Intersection** and select the new intersection object.
2. Click **Surface 1**, then click the first source surface in the viewport.
3. Click **Surface 2**, then click a different source surface. Press `Esc` to cancel surface picking.
4. Adjust **Width** on the Object tab and the curve material on the Appearance tab.

Intersections are derived in world space, so they follow source-surface edits, movement, and animation and do not have an independent position control. Their accuracy follows the source meshes; increase the source surfaces' sample counts or implicit quality when a more detailed intersection is needed.

## Appearance, Lighting, and Scene Controls

The **Appearance** tab provides Matte Plastic, Glossy Plastic, Ceramic, Brushed Metal, Chrome, Clear Glass, Frosted Glass, Tinted Glass, Rubber, and Mirror presets. Presets can be customized with the material controls. Refraction takes effect when opacity is below 1. **Surface Decorations** contains grid controls for parametric/explicit surfaces and X/Y/Z contour controls for non-curve plot surfaces.

Point lights provide position, color, intensity, range, and shadow controls. Directional lights provide sun azimuth/elevation, an exact direction vector, color, intensity, and shadows. A light's visibility checkbox hides its editor gizmo only; set its intensity to `0` when you want to turn off its illumination.

With nothing selected, **Scene Settings** controls the turntable, ambient light, shadow-map resolution and softness, projection, background, ground plane and reflection, XY grid, axes, and axis labels. **STEVE → Settings** controls tone mapping, exposure, Halos, PNG export scale, and interactive quality.

## Viewport Controls

| Input | Action |
| --- | --- |
| Click an object | Select it |
| Left-drag a selected plot or light | Move in XY |
| `Shift` + left-drag | Move along Z |
| Right-drag | Orbit |
| `Shift` + right-drag | Pan |
| Scroll | Zoom |
| Double-click | Frame the selection, or the scene when nothing is selected |
| `Top`, `Front`, `Side` | Use an axis-aligned view |
| `⛶` | Frame the selection/scene |
| `⌂` | Reset the camera |
| `?` | Show or hide the viewport control reminder |

The two panel icons in the top-right corner hide or restore the left and right sidebars.

## Keyboard Shortcuts

Except for `Esc`, shortcuts apply when focus is not inside a text or number field.

| Shortcut | Action |
| --- | --- |
| `Esc` | Clear the selection or cancel intersection-source picking |
| `Delete` or `Backspace` | Delete the selected object |
| `Command/Ctrl` + `C` | Copy the selected object and all of its settings |
| `Command/Ctrl` + `V` | Paste an object; pasting a full tuple or equality creates a new classified plot |
| `Command/Ctrl` + `Z` | Undo |
| `Command/Ctrl` + `Shift` + `Z` | Redo |
| `Command/Ctrl` + `Y` | Redo |

## Files and Exports

- **File → Save** writes scene objects plus scene/render settings to `scene.3dplot.json` by default. **Open** accepts `.json` and `.3dplot.json` project files. Camera pose, current selection, and open UI state are not stored.
- **File → Export PNG** saves the current viewport. Choose Standard (1×), High (2×), or Ultra (4×) under **STEVE → Settings**.
- **Record loop** exports GIF animation from either the Scene turntable controls or a playing continuous constant.
- **File → Export STL** is available when a plot or intersection is selected. It exports the current generated triangle mesh in its world position; visual material and lighting settings are not part of STL.
- Parametric curves and intersection curves export their rendered tube/ribbon geometry, not abstract mathematical paths.
- STL export does not guarantee a closed or watertight solid; inspect open surfaces before using them for 3D printing.

All files stay under your control through the browser's save dialog or download folder.

ST.E.V.E. does not autosave. Save before reloading the page or choosing **File → New**, which resets the project without a confirmation prompt.

## Practical Limits

- The renderer uses up to four point lights and four directional lights. Up to three point lights can cast shadows, subject to available graphics hardware; the first eligible directional light supplies the directional shadow map.
- Up to four objects use live per-object reflection probes at once. PNG output is capped at 8,192 pixels on its longest side, so the requested scale can be reduced for an already-large viewport.
- Large implicit bounds and higher implicit quality take longer to mesh. The inspector warns about invalid or unusually large bounds.
- Large discrete families, dense surface sampling, reflections, refraction, shadows, and Halos can all increase rendering cost. Use **Performance** or **Balanced** interactive quality while editing a heavy scene.

## Run Locally

Use Node.js `^20.19.0` or `>=22.12.0`.

```bash
npm ci
npm run dev
```

Vite prints the local URL to open in your browser. Additional repository checks are:

```bash
npm run build
npm run lint
npm run test:run
npm run test:e2e:install
npm run test:e2e
```

The app is built with React, TypeScript, Vite, raw WebGL2, Zustand, CodeMirror, KaTeX, browser workers, Vitest, and Playwright.

## License

[MIT](LICENSE)

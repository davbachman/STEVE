# Constants, Animation, and GIFs

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

## Constants, Families, and GIFs

Every adjustable constant starts in **Continuous** mode. Only free names get these controls; [local definitions](equations.md#chained-definitions-and-sliders) are calculated from their expressions.

For a continuous constant:

1. Drag **Value** to evaluate the object at a particular value.
2. Put the slider at its minimum or maximum and type a new endpoint into the number field to change that end of the range.
3. Press play to sweep continuously between the endpoints. While it is playing, adjust the constant's speed or choose **Record loop** to export one full ping-pong cycle as a GIF.

Switch the mode button to **Discrete** to sample equally spaced levels instead. Set **num copies**, use the value slider to show one level, or press play to show all levels at once. Multiple discrete constants that are showing all copies produce every combination of their sampled values, so high copy counts can make a scene expensive to mesh and draw.

To record a camera orbit, clear the object selection, enable **Turntable animation** in Scene Settings, set **Orbit speed**, and choose **Record loop**. GIF exports preserve the viewport aspect ratio. Under **STEVE → Settings**, choose a maximum longest edge of 480, 720, or 1,080 pixels and a target frame rate of 10, 15, or 20 fps.

## Pinning Lights to Parametric Curves

1. Select a point or directional light and enable **Pin to curve** on its **Object** tab.
2. Click **Click here, and then click parameterized curve to pin light to**, then click a parametric curve in the viewport. Press `Esc` to cancel picking. The selected curve's card replaces the prompt.
3. Use the `t` slider to place the light anywhere between the curve's current parameter bounds. The light follows edits to the curve, its transform, its bounds, and its equation constants.
4. Press the triangle beside the slider to animate. Curves with different endpoint positions bounce from one end to the other; curves whose endpoints meet advance continuously and wrap around as a loop.
5. While playback is active, adjust **t speed** or choose **Record loop** to export one complete light-path GIF. Recording restores the light's prior parameter value when it finishes.

A pinned light's independent position control is hidden and its viewport handle cannot be dragged. Disable **Pin to curve** to detach it at its current curve position. A directional light remains aimed from its moving tail toward the world origin throughout playback.

---

[Previous: Equations and Local Definitions](equations.md) · [Table of contents](../README.md#table-of-contents) · [Next: Surface Intersections](intersections.md)

# Surface Intersections

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

1. Choose **Curve → + Intersection** and select the new intersection object.
2. Click **Surface 1**, then click the first source surface in the viewport.
3. Click **Surface 2**, then click a different source surface. Press `Esc` to cancel surface picking.
4. Adjust **Width** on the Object tab and the curve material on the Appearance tab.

Intersections are derived in world space, so they follow source-surface edits, movement, and animation and do not have an independent position control. Their accuracy follows the source meshes; increase the source surfaces' sample counts or implicit quality when a more detailed intersection is needed.

---

[Previous: Constants, Animation, and GIFs](animation.md) · [Table of contents](../README.md#table-of-contents) · [Next: Appearance, Lighting, and Scene Controls](appearance.md)

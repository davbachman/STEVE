# Practical Limits

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

- The renderer uses up to four point lights and four directional lights. Up to three point lights can cast shadows, subject to available graphics hardware; the first eligible directional light supplies the directional shadow map.
- Up to four objects use live per-object reflection probes at once. PNG output is capped at 8,192 pixels on its longest side, and an estimated 768 MiB capture working-memory budget, so the requested scale can be reduced for a large viewport or a scene with many effects. This estimate covers capture resources; retained mesh geometry and browser overhead are additional.
- GIF recording is capped at 360 turntable frames or 180 parameter/light frames. Long, slow loops preserve their duration and may therefore run below the selected target frame rate. Higher GIF dimensions and frame rates take longer to encode and create larger files.
- Large implicit bounds and higher implicit quality take longer to mesh. The inspector warns about invalid or unusually large bounds.
- All surface and curve tube/ribbon construction runs in workers. The previous completed shape stays visible while an updated mesh is being built. Compiled equation operations are reused as constants change, and translated intersections reuse their source geometry and spatial search structures.
- Meshing workers start on demand and release their memory after 30 seconds of inactivity. If a worker stops during an equation calculation, the app retries that calculation once in a fresh worker.
- Large discrete families, dense surface sampling, reflections, refraction, shadows, and Halos can all increase rendering cost. Use **Performance** or **Balanced** interactive quality while editing a heavy scene.

---

[Previous: Files, Recovery, and Exports](files-and-exports.md) · [Table of contents](../README.md#table-of-contents) · [Next: Running and Developing Locally](development.md)

# 3D Plot Render

Browser-only interactive 3D graphing app for parametric curves, parametric surfaces, implicit surfaces, and explicit single-axis surfaces.

## Development
1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Build for production with `npm run build`.
4. Run unit tests with `npm run test:run`.
5. Run Playwright checks with `npm run test:e2e`.

## Usage
1. Add plots from the left panel with `+ Curve`, `+ Surface`, `+ Implicit`, or `+ Light`.
2. Edit the selected plot in the equation dock.
3. Use the inspector to adjust object transforms, materials, lighting, scene settings, and render diagnostics.
4. Orbit with right drag, pan with `Shift` + right drag, and drag selected objects with left drag (`Shift` + left drag for Z).
5. Save projects as JSON or export the viewport as a PNG.

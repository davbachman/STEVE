# Running and Developing Locally

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

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

---

[Previous: Practical Limits](practical-limits.md) · [Table of contents](../README.md#table-of-contents)

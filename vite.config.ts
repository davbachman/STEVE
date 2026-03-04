import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/STEVE/' : '/',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
})

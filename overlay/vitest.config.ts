import { defineConfig } from 'vitest/config'

// Source tests only: `npm run build` emits compiled *.test.js into dist/, and
// vitest's default include would run those stale copies alongside src.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * D8 / C§8.2: only `@bsv/mandala/profile` (`src/profile*.ts`) may import the
 * color module. The core stays loadable without the optional peer (RN, app
 * console), and the core facade never re-exports the profile entry.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url))
/** A static import, re-export, side-effect import, dynamic import or require of the module (any subpath). */
const IMPORTS_MODULE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]@bsv\/color-permission-module(?:\/[^'"`]*)?['"`]/

function sources (dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue
      out.push(...sources(p))
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('core isolation (D8)', () => {
  it('no non-profile source under src/ imports @bsv/color-permission-module', () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(20)
    const offenders = files
      .filter(f => !basename(f).startsWith('profile'))
      .filter(f => IMPORTS_MODULE.test(readFileSync(f, 'utf8')))
      .map(f => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('the import pattern catches every import form (and not a prose mention)', () => {
    for (const s of [
      "import { ColorPlan } from '@bsv/color-permission-module'",
      'export { x } from "@bsv/color-permission-module"',
      "import type { X } from '@bsv/color-permission-module/dist/index.mjs'",
      "import '@bsv/color-permission-module'",
      "await import('@bsv/color-permission-module')",
      "require('@bsv/color-permission-module')"
    ]) expect(IMPORTS_MODULE.test(s)).toBe(true)
    expect(IMPORTS_MODULE.test(' * the wallet lacks @bsv/color-permission-module 0.2.0')).toBe(false)
  })

  it('the core facade never re-exports the profile entry', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(index).not.toMatch(/from\s+['"]\.\/profile/)
    expect(index).not.toMatch(/import\(\s*['"]\.\/profile/)
  })

  it('profileProvider.ts is the profile-entry provider (exists, imports the module)', () => {
    const src = readFileSync(join(SRC, 'profileProvider.ts'), 'utf8')
    expect(IMPORTS_MODULE.test(src)).toBe(true)
  })
})

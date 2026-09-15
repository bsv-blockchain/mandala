/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import pkgRaw from '../package.json?raw'

type Target = string | { [condition: string]: Target }
const pkg = JSON.parse(pkgRaw) as { type: string, exports: Record<string, Target> }

/**
 * The Node/Metro exports walk in miniature: the first condition that matches
 * in declaration order wins, `default` matches unconditionally, and a `*`
 * pattern substitutes the subpath remainder.
 */
function resolveExports (subpath: string, conditions: string[]): string | undefined {
  const pick = (t: Target): string | undefined => {
    if (typeof t === 'string') return t
    for (const [cond, next] of Object.entries(t)) {
      if (cond === 'default' || conditions.includes(cond)) return pick(next)
    }
    return undefined
  }
  const exact = pkg.exports[subpath]
  if (exact != null) return pick(exact)
  for (const [key, target] of Object.entries(pkg.exports)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const pre = key.slice(0, star)
    const post = key.slice(star + 1)
    if (!subpath.startsWith(pre) || !subpath.endsWith(post)) continue
    return pick(target)?.replace('*', subpath.slice(pre.length, subpath.length - post.length))
  }
  return undefined
}

describe('D3b — package exports resolve for Metro (default), Node (import) and TS (types)', () => {
  it('stays an ESM package', () => {
    expect(pkg.type).toBe('module')
  })

  // Metro's condition set has no `import`; only `default` can satisfy it.
  it.each([
    ['.', 'react-native', './dist/index.js'],
    ['.', 'import', './dist/index.js'],
    ['.', 'types', './dist/index.d.ts'],
    ['./constants', 'react-native', './dist/constants.js'],
    ['./constants', 'import', './dist/constants.js'],
    ['./constants', 'types', './dist/constants.d.ts']
  ])('%s under [%s] resolves to %s', (subpath, condition, expected) => {
    expect(resolveExports(subpath, [condition])).toBe(expected)
  })

  it('orders types first and default last in both entries, default mirroring import', () => {
    for (const key of ['.', './*']) {
      const entry = pkg.exports[key] as Record<string, Target>
      const keys = Object.keys(entry)
      expect(keys[0]).toBe('types')
      expect(keys[keys.length - 1]).toBe('default')
      expect(entry.default).toBe(entry.import)
    }
  })
})

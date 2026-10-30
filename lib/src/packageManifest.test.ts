/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import pkgRaw from '../package.json?raw'

type Deps = Record<string, string>
const pkg = JSON.parse(pkgRaw) as {
  version: string
  dependencies?: Deps
  peerDependencies?: Deps
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies: Deps
  overrides?: Deps
}

/** 0.5.0 manifest invariants (C§8, C§9, D9, D10). */
describe('package manifest', () => {
  it('is version 0.5.0', () => {
    expect(pkg.version).toBe('0.5.0')
  })

  it('has no @bsv/* runtime dependencies (D9)', () => {
    expect(Object.keys(pkg.dependencies ?? {}).filter(n => n.startsWith('@bsv/'))).toEqual([])
  })

  it('declares the 1Color peers with the color module optional', () => {
    expect(pkg.peerDependencies).toEqual({
      '@bsv/sdk': '^4.0.0',
      '@bsv/templates': '^2.2.0',
      '@bsv/message-box-client': '^2.5.4',
      '@bsv/color-permission-module': '^0.2.0'
    })
    expect(pkg.peerDependenciesMeta).toEqual({ '@bsv/color-permission-module': { optional: true } })
  })

  it('installs the whole 1Color stack from npm', () => {
    expect(pkg.devDependencies['@bsv/sdk']).toBe('^4.0.0')
    expect(pkg.devDependencies['@bsv/wallet-toolbox-client']).toBe('^2.15.0')
    expect(pkg.devDependencies['@bsv/message-box-client']).toBe('^2.5.4')
    expect(pkg.devDependencies['@bsv/templates']).toBe('^2.2.0')
    expect(pkg.devDependencies['@bsv/color-permission-module']).toBe('^0.2.0')
    expect(Object.values(pkg.devDependencies).filter(spec => spec.startsWith('file:'))).toEqual([])
  })

  it('pins @bsv/sdk to the direct spec (message-box-client still declares an sdk ^2.8.6 peer)', () => {
    expect(pkg.overrides?.['@bsv/sdk']).toBe('$@bsv/sdk')
    expect(pkg.overrides?.['@bsv/wallet-toolbox-client']).toBeUndefined()
  })

  it('overrides the shared 1Color names to their direct specs, so one copy of each installs', () => {
    for (const n of ['@bsv/sdk', '@bsv/templates', '@bsv/color-permission-module']) expect(pkg.overrides?.[n]).toBe(`$${n}`)
  })
})

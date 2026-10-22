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

  it('installs sdk and templates from vendored tarballs', () => {
    for (const n of ['@bsv/sdk', '@bsv/templates']) {
      expect(pkg.devDependencies[n]).toMatch(/^file:\.\.\/vendor-ts-stack\/bsv-[a-z-]+-\d+\.\d+\.\d+-[0-9a-f]{7,9}\.tgz$/)
    }
    expect(pkg.devDependencies['@bsv/message-box-client']).toBe('^2.5.4')
  })

  it('installs the color module and toolbox client (profile entry, tests) from vendored tarballs with overrides', () => {
    for (const n of ['@bsv/color-permission-module', '@bsv/wallet-toolbox-client']) {
      expect(pkg.devDependencies[n]).toMatch(/^file:\.\.\/vendor-ts-stack\/bsv-[a-z-]+-\d+\.\d+\.\d+-[0-9a-f]{7,9}\.tgz$/)
      expect(pkg.overrides?.[n]).toBe(`$${n}`)
    }
    expect(pkg.devDependencies['@bsv/color-permission-module']).toContain('bsv-color-permission-module-0.2.0-')
    expect(pkg.devDependencies['@bsv/wallet-toolbox-client']).toContain('bsv-wallet-toolbox-client-2.15.0-')
  })

  it('overrides every vendored name to its direct spec', () => {
    const vendored = Object.keys(pkg.devDependencies).filter(n => pkg.devDependencies[n].startsWith('file:'))
    expect(vendored.length).toBeGreaterThan(0)
    for (const n of vendored) expect(pkg.overrides?.[n]).toBe(`$${n}`)
  })
})

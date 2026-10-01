import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'

// The TS half of the Go/TS script-rules parity check. The vectors are shared
// with overlay-go (internal/wiring/script_rules_test.go and
// internal/httpapi/submit_script_rules_test.go read the same file): every BEEF
// records what @bsv/sdk does with it, and the Go overlay must give the same
// verdict (wiring.CheckChronicleSighashRule, then go-sdk spv.Verify), except
// where the file names a knownGap. A TS refusal is a thrown script error in
// Engine.submit, which the /submit wrapper answers 503 ERR_UNAVAILABLE (no
// manager reject was captured and the request itself is well-formed).
interface Vector { name: string, tsVerifies: boolean, description: string, knownGap?: string, beefHex: string }

const vectors = (JSON.parse(readFileSync(
  new URL('../../overlay-go/testdata/chronicle_sighash_vectors.json', import.meta.url), 'utf8'
)) as { vectors: Vector[] }).vectors

const bytesOf = (hex: string): number[] => Array.from(Buffer.from(hex, 'hex'))

describe('SIGHASH_CHRONICLE shared vectors: @bsv/sdk Transaction.verify and the real engine', () => {
  let h: Harness | undefined
  afterEach(async () => { await h?.close(); h = undefined })

  it('has the vectors the Go side expects', () => {
    expect(vectors.map(v => v.name)).toEqual([
      'v1_plain', 'v1_chronicle', 'v2_plain', 'v2_chronicle',
      'v2_child_of_unproven_v1_chronicle', 'v2_child_of_proven_v1_chronicle',
      'v2_child_of_proven_v1_chronicle_ancestor_present', 'v1_chronicle_after_chronicle_opcode'
    ])
  })

  for (const v of vectors) {
    it(`${v.name}: ${v.tsVerifies ? 'accepted' : 'refused'}`, async () => {
      const verify = Transaction.fromBEEF(bytesOf(v.beefHex)).verify('scripts only')
      if (v.tsVerifies) await expect(verify).resolves.toBe(true)
      else await expect(verify).rejects.toThrow()

      // The same bytes through the real Engine: a refusal is the engine
      // throwing, before any topic manager runs.
      h = await createHarness()
      const outcome = await h.engine.submit({ beef: bytesOf(v.beefHex), topics: [HARNESS_TOPIC] }, undefined, 'current-tx')
        .then((steak: unknown) => ({ steak, error: undefined as unknown }), (error: unknown) => ({ steak: undefined, error }))
      if (v.tsVerifies) {
        expect(outcome.error).toBeUndefined()
        expect(outcome.steak).toBeDefined()
      } else {
        expect(outcome.error).toBeDefined()
        expect(h.refusals).toHaveLength(0)
      }
    })
  }
})

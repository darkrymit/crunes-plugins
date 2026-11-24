import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTlcOutput } from '../src/tla.js'

test('parseTlcOutput reports pass and state stats on clean TLC run', () => {
  const out = `
Model checking completed. No error has been found.
42 states generated, 15 distinct states found, 0 states left on queue.
Finished in 00s at (2026-11-24 22:00:00)
`
  const res = parseTlcOutput(out)
  assert.equal(res.status, 'pass')
  assert.equal(res.violation, null)
  assert.deepEqual(res.stats, { generated: 42, distinct: 15, left: 0 })
  assert.equal(res.mermaid, null)
})

test('parseTlcOutput extracts invariant violation trace and builds Mermaid stateDiagram', () => {
  const out = `
Error: Invariant NeverDoubleCharge is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\\ charges = 0
/\\ inflight = FALSE

State 2: <SendPay line 12, col 1 to line 14, col 20 of module Checkout>
/\\ charges = 0
/\\ inflight = TRUE

State 3: <RetryTimeout line 16, col 1 to line 18, col 25 of module Checkout>
/\\ charges = 2
/\\ inflight = FALSE

19 states generated, 11 distinct states found, 0 states left on queue.
`
  const res = parseTlcOutput(out)
  assert.equal(res.status, 'violated')
  assert.equal(res.violation, 'Invariant NeverDoubleCharge violated')
  assert.equal(res.trace.length, 3)
  assert.equal(res.trace[1].action, 'SendPay')
  assert.match(res.mermaid, /^stateDiagram-v2/)
  assert.match(res.mermaid, /S1 --> S2: SendPay/)
  assert.match(res.mermaid, /S2 --> S3: RetryTimeout/)
  assert.match(res.mermaid, /S3 --> \[\*\]: Invariant NeverDoubleCharge violated/)
})

test('parseTlcOutput detects deadlock', () => {
  const out = `
Error: Deadlock reached.
State 1: <Initial predicate>
/\\ phase = "stuck"
`
  const res = parseTlcOutput(out)
  assert.equal(res.status, 'violated')
  assert.equal(res.violation, 'Deadlock reached')
  assert.equal(res.trace.length, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadViewCode, parseDot, parseTlcOutput, renderStatechart } from '../src/tla.js'

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

test('parseDot + renderStatechart collapses states via --view and marks breaks', () => {
  const dotText = `
digraph DiskGraph {
  1 [label="/\\ phase = \\"idle\\"\\n/\\ charges = 0", style=filled];
  2 [label="/\\ phase = \\"paying\\"\\n/\\ charges = 0"];
  3 [label="/\\ phase = \\"done\\"\\n/\\ charges = 2"];
  1 -> 2 [label="ClickPay"];
  2 -> 3 [label="DoubleSettle"];
}
`
  const dot = parseDot(dotText)
  assert.equal(dot.nodes.size, 3)
  assert.equal(dot.edges.length, 2)

  const view = loadViewCode(`
    export const title = "Checkout flow"
    export const colors = { ok: "fill:#dcfce7,stroke:#16a34a" }
    export const state = (v) => v.phase === "done" ? "Done" : v.phase === "paying" ? "Paying" : "Idle"
    export const step = (action) => action === "ClickPay" ? "customer clicks pay" : "payment settles twice"
    export const group = (v) => v.phase === "idle" ? "ok" : null
  `)

  const tlcResult = {
    status: 'violated',
    violation: 'Invariant NeverDoubleCharge violated',
    trace: [{ step: 3, action: 'DoubleSettle', state: 'phase = "done"; charges = 2' }],
  }

  const chart = renderStatechart({ dot, tlcResult, view })
  assert.match(chart, /title: Checkout flow/)
  assert.match(chart, /S1: Idle/)
  assert.match(chart, /S1 --> S2: customer clicks pay/)
  assert.match(chart, /S2 --> S3: payment settles twice/)
  assert.match(chart, /class S1 ok/)
  assert.match(chart, /class S3 breaks/)
})

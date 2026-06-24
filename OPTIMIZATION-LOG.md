# Optimization Log — wfc-ts

Per-hypothesis measured record of the ratchet optimization loop. Each entry:
the hypothesis, the change, the measured before/after (median-of-5, this
machine), the keep/revert decision, and the cost. Rejected hypotheses are
recorded too — a measured negative result is a result, not something to hide.

Machine: macOS arm64, Bun 1.3.10. Times are wall-clock medians-of-5; treat as
the right order of magnitude, not three significant figures (one noisy machine).

## Reference baseline (measured)

| input | ref median |
|-------|-----------|
| knots-standard-48 | 10.43 ms |
| circuit-turnless-34 | 7.23 ms |
| rooms-30 | 3.14 ms |

(Sub-ms inputs — knots-standard-24, knots-fabric-24, knots-dense-24 — carry too
little signal to measure speedup against and are excluded from headline numbers;
they still pass every gate.)

## Profile (where the cycles go) — scripts/profile.ts

| input | T | dominant | share |
|-------|---|----------|------|
| knots-standard-48 | 9 | entropy scan (nextUnobservedNode) | 83.6% — O(cells²) full scan per step |
| circuit-turnless-34 | 36 | propagation (compatible-decrement loop) | 66.5% |
| rooms-30 | 28 | propagation | 78.2% |

Two regimes: small-T-large-grid is scan-bound; larger-T is propagation-bound. The
propagation cost is `compatible[i2][t2][d]` — three JS array-object chases per
access (cache-hostile). The scan re-iterates every cell each observe step.

---

## Hypothesis 1 — flatten wave + compatible to typed arrays (SoA)  [KEPT]

**Hypothesis:** The propagation hot loop (66-78% on circuit/rooms) chases three
array objects per `compatible[i2][t2][d]--`. Flattening `wave` to a `Uint8Array`
and `compatible` to a flat `Int32Array` (indexed `i*T4 + t*4 + d`) removes the
indirection and improves locality. Same counts/decrements/bans/selection, so the
output is unchanged — valid AND byte-identical. (DOD: SoA over AoS, indices over
references, data layout as first-class.)

**Change:** `src-optimized/model.ts` — `wave: boolean[][]` → `Uint8Array`
(`wave[i*T + t]`); `compatible: number[][][]` → `Int32Array`
(`compatible[i*T4 + t*4 + d]`); all access sites (init/clear/ban/propagate/observe/
nextUnobservedNode/run-final-loop) updated to arithmetic indexing.

**Measurement (median-of-5, prove-harness):**

| input | ref ms | opt ms | speedup | valid | det | byte-identical |
|-------|--------|--------|---------|-------|-----|----------------|
| knots-standard-48 | 10.43 | 8.20 | 1.27x | VALID | DET | yes |
| circuit-turnless-34 | 7.23 | 6.18 | 1.17x | VALID | DET | yes |
| rooms-30 | 3.14 | 2.63 | 1.19x | VALID | DET | yes |

**Decision:** KEEP. Every gate passes (valid + deterministic) and it is
measurably faster on every input. Byte-identical to the reference confirms the
algorithm is unchanged — a clean layout-only win. Modest absolute speedup
because the propagator `propagator[d][t1]` indirection and per-decrement work
remain; this hypothesis is also an *enabling transform* (flat arrays unlock
further layout/vectorization ideas).

**Cost:** ~1 LLM turn + a few seconds shell (typecheck + prove-harness).

## Hypothesis 2 — flatten propagator to flat CSR typed arrays [KEPT]

**Hypothesis:** The remaining indirection in the propagation hot loop on
propagation-bound inputs (circuit/rooms) is `const p = propagator[d][t1]; for (l)
 t2 = p[l]`. Replace the `number[][][]` with a flat CSR layout
(`Int32Array propData` of concatenated lists + `propStart`/`propLen` indexed
`d*T + t1`) built at ctor end. Same list contents and iteration order over t2
=> outputs are byte-identical (Tier-1). Pure data-layout change; no algorithm
change.

**Change:** `src-optimized/model.ts` (update accesses in `propagate()` and `clear()`;
add CSR fields + H2 comment) and `src-optimized/simple-tiled-model.ts` (build
CSR at end of ctor instead of jagged arrays; same order preserved).

**Measurement (median-of-5, prove-harness; grounding run before change for pre-opt):**

| input | ref ms | opt ms | speedup | valid | det | byte-identical |
|-------|--------|--------|---------|-------|-----|----------------|
| knots-standard-48 | 10.96 | 8.41 | 1.30x | VALID | DET | yes |
| circuit-turnless-34 | 7.42 | 5.31 | 1.40x | VALID | DET | yes |
| rooms-30 | 3.83 | 2.41 | 1.59x | VALID | DET | yes |

Pre-H2 optMs (grounding run): knots 8.26 / circuit 6.34 / rooms 2.73. H2 improved
opt on circuit (6.34→5.31) and rooms (2.73→2.41); knots within noise.

**Decision:** KEEP. Gates pass (VALID+DET, and compare* PASS as expected for
layout-only). Measurably faster on the two propagation-bound targets
(circuit/rooms); no regression on scan-bound. Pure simplification of access
pattern (removes 2 array indirections per inner iter). Enables further
propagator work if any.

**Cost:** ~1 LLM turn + ~30s wall (ground run + edit + typecheck + 2x harness runs + commit + log).

## Hypothesis 4 — heap-based entropy selection [KEPT]

**Hypothesis:** The entropy scan in `nextUnobservedNode` is 83.6% of runtime on
scan-bound input knots-standard-48 (O(cells) per observe step, cells=2304).
Replace the linear scan + random noise with an O(log n) binary min-heap
(typed arrays + keyToPos map) over cells with sumsOfOnes>1. Priority=
entropies[i] (Entropy) or sumsOfOnes[i] (MRV); deterministic min with tie-break
by lower cell index (no noise). PRNG consumed only inside observe's
weightedPick. next uses extract-min + lazy discard of collapsed/stale. ban
wires decrease-key (via update) and remove-on-collapse. Tier-2 algorithmic:
collapse sequence differs from ref (valid tilings are not unique).

**Change:** Added `src-optimized/entropy-heap.ts` (exact port of
references/three-wfc/lib/WFCMinHeap.ts with Float64 + deterministic
(entropy,key) lessThan). Wired in `src-optimized/model.ts`: added heap field
and allocation in init(); heap rebuild (eligible >1 cells) at end of clear();
replaced scan in nextUnobservedNode with popEntry + lazy checks; ban now
updates heap on prio change or removes on <=1. Scanline path untouched.
Rest of algorithm (flat arrays, CSR prop, ban logic) unchanged.

**Measurement (median-of-5 from prove-harness post-change):**

| input | ref ms | opt ms | speedup | valid | det | compare* |
|-------|--------|--------|---------|-------|-----|----------|
| knots-standard-48 | 11.44 | 1.72 | 6.65x | VALID | DET | FAIL (expected) |
| circuit-turnless-34 | 7.08 | 4.43 | 1.60x | VALID | DET | FAIL (expected) |
| rooms-30 | 3.02 | 1.86 | 1.62x | VALID | DET | FAIL (expected) |

Pre-H4 opt (H1+H2 state, from grounding run): knots ~8.21ms / circuit ~5.16ms / rooms ~2.36ms.
H4 delivered ~4.8x additional on knots-48 (8.21→1.72) with no regression on
prop-bound (in fact small further gains from reduced overhead). The scan cost
is gone; now propagation dominates even on knots.

**Decision:** KEEP (and committed). VALID + DET gates pass. compare* FAIL is
EXPECTED and correct for Tier-2 (sequence changed by dropping noise +
index-tiebreak); not a correctness regression. Massive win on target
(knots-48, the scan-bound case); also helps others a bit. No correctness
regression on any input.

**Cost:** ~1 LLM turn + ~2min wall (study three-wfc heap + ground run +
implement heap+wire + typecheck + 3x harness runs + commit + log + readme).
Note: no revert needed; first attempt passed gates + speedup.
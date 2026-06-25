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

---

## Round 2 baseline profile (H5+ round, post-H4; instrumentation on optimized only)

Re-profiled the *optimized* solver (H1+H2+H4 state) because `scripts/profile.ts`
only covers the reference and its scan (now gone). Instrumented `src-optimized/model.ts`
temporarily with per-phase timers around:
- nextUnobservedNode (heap extract + lazy)
- observe (dist build + weightedPick)
- propagate (decrement loop; ban time subtracted so not double)
- ban (wave/compat/stack/sums + heap update/remove)

Ran via `harness/run.ts optimized <input>` (warmup + measured), 5 post-warm samples each;
medians computed, then scaled by (clean opt total from prove-harness / instr total)
to recover realistic absolute ms (instrumentation adds overhead, esp. in ban).
Clean opt totals (median-of-5 prove): knots-48 1.69ms, circuit 4.48ms, rooms 1.89ms.

**Per-phase median (est. real ms + % of run work):**

| input | total | next (heap) | observe (pick) | propagate | ban+heap | other |
|-------|-------|-------------|----------------|-----------|----------|-------|
| knots-standard-48 | 1.69ms | 0.122ms (7.2%) | 0.136ms (8.0%) | 0.757ms (44.8%) | 0.479ms (28.3%) | 0.191ms (11.3%) |
| circuit-turnless-34 | 4.48ms | 0.052ms (1.2%) | 0.173ms (3.9%) | 2.966ms (66.2%) | 1.141ms (25.5%) | 0.150ms (3.4%) |
| rooms-30 | 1.89ms | 0.037ms (2.0%) | 0.070ms (3.7%) | 1.118ms (59.1%) | 0.590ms (31.2%) | 0.081ms (4.3%) |

**Amdahl takeaway (for picking):** Propagation is the dominant cost on the prop-bound
inputs we care about for Round 2 (66% circuit, 59% rooms). Ban+heap is second at ~25-31%.
Observe and next are small (<9%). Therefore H5 (prop skip/dedup + trim dec overhead)
has highest payoff. (H6 would target ban; H7 observe.)

Instrumentation reverted (git checkout) before implementation; no debug left in tree.
Profile cost: ~3min wall (multiple runs per input).

## Hypothesis 5 — propagation skip/dedup on collapsed + trim per-decrement [REVERTED]

**Hypothesis:** Post-H4, propagation dominates (66%/59% on circuit/rooms per Round2 profile).
Add two cheap guards in the inner decrement loop of propagate(): (a) if (sumsOfOnes[i2] === 0)
continue before t2 loop (skip already-dead cells); (b) if (wave[i2*T + t2] === 0) continue before
-- (skip already-banned variants). Safe because eliminated variants/cells have no live options;
should trim work with negligible branch cost. Tier-1 (no change to ban/observe order).

**Change:** Single edit in `src-optimized/model.ts`: destructure wave+sumsOfOnes, add the two
`continue` guards (with H5 comments) in propagate().

**Before (median-of-5 measure-speedup, clean post-H4):** knots 2.050ms (5.26x), circuit 4.948ms (1.49x), rooms 2.375ms (1.44x)

**After (same protocol, with H5 guards):** knots 2.250ms (4.80x), circuit 6.671ms (1.10x), rooms 2.794ms (1.21x)

**Gate:** typecheck clean; prove-harness: VALID+DET on all (viol=0); compare* FAIL as expected from H4.

**Decision:** REVERT. VALID+DET hold, but knots-48 regressed (2.05→2.25) and prop-bound targets
regressed hard (circuit 4.95→6.67, rooms 2.38→2.79). The added per-iter checks (esp. wave[] load
+ branch in the *inner* l loop) cost more than saved on this engine; no net win. (Common case
most t2 are live, so branch rarely skips.)

**Cost:** ~1 LLM turn + ~5min wall (reprofile 3x5runs, 2x full measure5 on 3 inputs, gate runs,
log+readme, revert).

(The Round 2 baseline profile is recorded above; it drove picking H5 first.)

## Hypothesis 6 — batch heap updates (coalesce per-cell decrease-key/remove on ban)  [KEPT]

**Hypothesis:** Post-H4, ban+heap is second cost at 25-31% (prop is first). Sub-profile of ban phase
(before impl) showed heap decrease-key/remove inside ban accounted for ~31-46% of ban's own time
(~8-12% overall). Every ban(i,t) paid an immediate O(log) heap update/remove (or push). Large-T
inputs like circuit (T=36, ~40k bans/run) pay heavily. Batch: move sift work out of ban — ban()
only appends i to a dirty list (cheap, no sifting); a flush (with gen-based dedup per cell) is
called once before extract-min in nextUnobservedNode, so only *distinct* dirtied cells pay the
update/remove. Observe alone (T-1 bans to same cell) drops from O(T) sifts to 1. Flush timing
preserves exact heap state at selection points => same min chosen as immediate updates.
Tier-2 (algorithmic, like H4), gate=VALID+DET (compare* informational, already FAIL since H4).

**Change:** Single file `src-optimized/model.ts` (H6 batch fields + alloc in init; ban marks dirty
only; new flushHeapUpdates(); call flush in nextUnobservedNode; reset in clear; header comments).
No change to entropy-heap.ts. (Dupe-lazy push was considered but batching defers more work.)

**Sub-profile (pre-change, via temp instr + revert):** heap ops ~30-40% of ban time on the three inputs.

**Measurement (median-of-5, harness/measure-speedup.ts protocol; before on clean post-H4 checkout,
then patch reapplied for after; same machine):**

| input               | ref ms | opt-before | opt-after | speedup-before | speedup-after |
|---------------------|--------|------------|-----------|----------------|---------------|
| knots-standard-48   | ~10.7  | 2.028 ms   | 1.970 ms  | 5.24x          | 5.43x         |
| circuit-turnless-34 | ~7.2   | 4.963 ms   | 4.702 ms  | 1.44x          | 1.55x         |
| rooms-30            | ~3.5   | 2.544 ms   | 2.132 ms  | 1.37x          | 1.65x         |

**Gate:** `npx tsc --noEmit` clean; `bun run harness/prove-harness.ts` : VALID+DET on all inputs
(viol=0); compare* FAIL (expected Tier-2 since H4). DET re-runs matched.

**Decision:** KEEP (committed). Meets criteria: VALID+DET pass; knots-48 no regression (2.028→1.970,
within noise + slight gain); circuit and rooms both improve (circuit ~5%, rooms ~16% on opt ms).
Batching successfully moved decrease-key cost off the per-ban hot path.

**Cost:** ~1 LLM turn + ~4min wall (subprofile 3 runs + revert, before 3x measure5, implement+edit,
typecheck+prove, after 3x measure5, gate, log+readme, commit).

## Hypothesis 7 — observe weighted-pick O(T) via cumsum + binary search [REVERTED]

**Hypothesis:** Post-H6, observe is ~4% (per Round2 profile); for circuit T=36 the absolute O(T) scan in weighted pick (and dist build) is the next lever after ban/heap. Replace the two O(T) linear passes (build dist + sum+partial in weightedPick) with O(T) prefix-cumsum build into dist[] followed by O(log T) bisect to find the slot whose cum first meets threshold. Approach chosen to preserve *exact* selection for a given PRNG draw (incl. zero-weight slot fallback behavior for r=0 and fp edge cases) by replicating the identical cumulative arithmetic and >= tests — aiming for Tier-1 (byte-id vs pre-H7 opt state).

**Change:** Single edit in `src-optimized/model.ts`: in observe(), compute running sum + write prefix to dist[], draw threshold, bisect for the matching t (lower bound), use as r for the ban pass. weightedPick() left untouched (and unused from observe now). No other files.

**Before (median-of-5, harness/measure-speedup.ts on clean post-H6):** knots-standard-48: 1.979ms ; circuit-turnless-34: 4.727ms ; rooms-30: 2.162ms

**After (same, with H7 cumsum+bisect patch; multiple sets):** knots: 1.992/2.048/1.987/2.011 ms ; circuit: 4.707/4.762/4.705/4.901 ms ; rooms: 2.251/2.154/2.209/2.158 ms

**Gate:** `npx tsc --noEmit` clean; `bun run harness/prove-harness.ts` : VALID+DET on all (viol=0); compare* FAIL (as before, from H4). Same checksums on same seeds confirmed pre/post H7 patch (exact selection preserved for the tested sequences; byte-id vs pre-H7).

**Decision:** REVERT (git checkout -- src-optimized/). VALID+DET hold and selection identical (Tier-1 intent achieved, no change to which pattern chosen per PRNG draw), but no real end-to-end gain above noise: circuit ~4.727ms → ~4.72ms (diff <0.03ms, within run-to-run variance of ~0.05-0.09ms); knots flat or +0.01ms (within noise); rooms variance dominated. The O(T) cumsum build + bisect did not beat the original branchy linear scan's constant factor at T=9 or T=36. (Honest: for these tiny T, two passes over 36 floats is cheaper than build+search overhead.)

**Cost:** ~1 LLM turn + ~9min wall (ground prove, 1x before measure5 + 4x after measure5 across 3 inputs for noise, 4x run.ts for checksum identity, 3x typecheck+prove, edit+reverts, log+readme, commit).

## Hypothesis 8 — ban per-call overhead: defer entropy (Math.log) recompute from per-ban to flush [REVERTED]

**Sub-profile (post-H6, temp instr on ban, reverted before impl):** ban() per-call sections timed via performance.now on circuit-turnless-34 and rooms-30 (via harness/run.ts; warmup+run; instr overhead inflates abs but relatives valid). 

- circuit-turnless-34 (40460 bans/run): wave/stack~1.28ms, compat-zero=0.774ms, sums-updates=0.907ms, entropy/plogp-recompute=1.372ms, dirty-mark=0.822ms. entropy/plogp biggest.
- rooms-30 (24300 bans/run): wave/stack~0.78ms, compat=0.579ms, sums=0.691ms, entropy/plogp=0.834ms, dirty=0.643ms. entropy/plogp biggest.

**Hypothesis:** Post-H6, ban+heap is 25-31%. The per-ban entropy recompute (Math.log(sum) - plogpsum/sum) was the largest slice of ban time. By keeping sums incremental in ban (already O(1) no-log for the 3 sums), but moving only the final entropy write+log to flush (which already coalesces per-cell), #logs drops from O(bans) to O(dirtied-cells-per-phase). E.g. observe's T-1 same-cell bans become 1 log. Tier-2 (entropy fp values may differ slightly affecting heap selection order, thus different valid seq); gate only VALID+DET. (Compat zeroing and sums were smaller per subprof and compat zeroing correctness-sensitive.)

**Change:** Single edit `src-optimized/model.ts` (ban: remove the 2-line entropy recompute after sums decr + H8 comment; flushHeapUpdates: destructure sumsOfWeights+sumsOfWeightLogWeights, for Entropy case compute+store entropies[i] + use as prio with sum>0 guard; update top comments + H6 jsdoc). No other files.

**Before (median-of-5 harness/measure-speedup.ts on clean post-H6; multiple runs for var):** knots-standard-48: 1.95–2.09ms; circuit-turnless-34: 4.70–4.85ms; rooms-30: 2.11–2.20ms. (Prove runs in same period: ~1.65/4.21/1.74ms)

**After (same protocol + prove, with H8 patch):** knots-standard-48: 1.90–1.97ms; circuit-turnless-34: 4.65–5.00ms; rooms-30: 2.14–2.38ms. (Prove: ~1.60–1.66 / 4.15–4.36 / 1.76–1.78ms). Gate always: typecheck clean; prove-harness VALID+DET (viol=0) on all inputs; DET re-runs matched checksums.

**Decision:** REVERT (`git checkout -- src-optimized/model.ts`). VALID+DET held (incl. re-runs), knots within noise (flat/slight var). But circuit/rooms showed no REAL above-noise improvement: diffs ±0.03 to 0.15ms depending on run pair, fully within observed run-to-run variance (0.05–0.2ms across measure/prove); sometimes flat, sometimes slight regress on prop targets. The log savings were offset by extra work/branches in flush path (now always computes for entropy case). Math.log on this engine + tiny T not high enough payoff after H6 batching. (Subprof identified the lever correctly but end-to-end win did not materialize.)

**Cost:** ~1 LLM turn + ~25min wall (subprof 4 runs + 2x revert instr, 8+ measure5 runs across stashes/checkouts for paired before/after + noise, 6x prove-harness for gate+ms, many typechecks, edits, log+readme, commit).

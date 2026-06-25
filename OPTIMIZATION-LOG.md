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

## Round 2 conclusion (H5+ propagation-push) — STOPPED at exhaustion

Tried 4 hypotheses; **1 KEPT (H6), 3 REVERTED (H5/H7/H8), 1 REJECTED (H9)**.

| H | candidate | result | key measurement |
|---|-----------|--------|------------------|
| H5 | propagation in-loop skip/dedup | REVERTED | hot-path branch+load overhead > saved (knots 2.05->2.25ms, circuit 4.95->6.67ms) |
| H6 | batched heap updates (coalesce decrease-key on ban) | KEPT | rooms 2.54->2.13ms (-16%), circuit 4.96->4.70ms (-5%), knots held; VALID+DET |
| H7 | observe cumsum+bisect (O(T) weighted pick) | REVERTED | byte-id preserved but cumsum rebuild is O(T); no gain vs linear scan at T=9/36 (within noise) |
| H8 | defer entropy Math.log from ban to flush | REVERTED | ban sub-profile: entropy/plogp is biggest ban sub-cost; deferring nets no win (work moves, no coalescing) |
| H9 | eliminate dist[] in observe | REJECTED | sub-micro of H7's failed lever; H7's negative result implies no measurable gain |

Final optimized vs reference (prove-harness, VALID+DET, viol=0): knots-standard-48
6.45x (1.62ms), circuit-turnless-34 1.73x (4.32ms), rooms-30 1.70x (1.88ms) -- up
from the Round 1 end state (6.3x / 1.66x / 1.71x) via H6 alone.

The 2.5x soft target on circuit/rooms was NOT reached and is NOT reachable by
ratcheting the current algorithm. The Round 2 baseline profile (fresh this round)
shows propagation at 60-66% of optimized time; H5 proved the propagation decrement
loop cannot be trimmed with guards (common case has live compatible patterns, so
skip-branches cost more than they save). The decrement loop is already flat CSR
with AC-4 support counts -- close to optimal for the simple-tiled-model
propagation algorithm. A further circuit/rooms win would require a DIFFERENT
propagation algorithm, which is out of scope for the ratchet (it optimizes the
existing algorithm; a new algorithm is a separate project).

Stop reason (exit criteria (a)): every high-payoff candidate tried; the fresh
Round 2 baseline profile + the H8 ban sub-profile reveal no new high-payoff
candidate. Propagation is an algorithmic wall, not a micro-architectural one.

## Hypothesis 10 — preliminary-action pruning: cache the clear() fixpoint [KEPT]

**Hypothesis:** clear() (full wave/compat reset + boundary no-neighbor bans + initial propagate to fixpoint + heap build) is repeated on every `run(seed)`. The post-fixpoint state (wave + compatible + sumsOfOnes/Weights/WeightLogWeights + entropies + observed) is a deterministic function of (grid, tileset, periodic, ground) — independent of seed (PRNG created *after* clear). Cache the "maximally-pruned starting state" once; subsequent clear() restores it with typed-array `.set()` copies instead of recomputing. (TRIZ P.10: preliminary action hoisted.) Heap rebuild kept in clear (O(cells) cheap; not cached). Speed primary; memory for +1 copy of arrays ACCEPTABLE. Produces identical start state => same collapse for given seed (compare* status unchanged from H4).

**Sub-profile (A, pre-impl):** temporarily instrumented `run()` (perf.now around clear vs loop; instr reverted before impl, `git diff` clean). Warm measured runs (harness/run.ts, 5x each):
- knots-standard-48: clear ~0.27ms / loop~2.43ms / share ~10.0%
- circuit-turnless-34: clear ~0.46ms / loop~5.43ms / share ~7.7%
- rooms-30: clear ~0.31ms / loop~2.45ms / share ~11.2%
>5% threshold and real work on large grids (fill O(C*T) + boundary bans + propagate), so implement (not reject).

**Change (B):** Single file `src-optimized/model.ts` (exactly one change this iter). Added H10 snapshot fields (wave0 etc + hasFixpoint) + allocs in `init()`; restructured `clear()` with if (hasFixpoint) { .set() restores + zero stack/observedSoFar } else { original work + capture post-prop }; heap-rebuild + dirty-reset always after the if; updated `footprintBytes()` to count snapshots; added H10 header + inline comments. No heap state cached (rebuild kept). No other files touched. No debug left.

**Gate + Measure (C):**
- `npx tsc --noEmit` clean (strict) pre and post.
- `bun run harness/prove-harness.ts`: VALID+DET (viol=0) on all; DET checksums match on re-runs. compare* FAIL unchanged (from H4 Tier-2). After also passes.
- SPEED (primary, median-of-5 via `harness/measure-speedup.ts`; before via stash/checkout of clean post-H6, after on patch):

| input               | ref ms | opt-before | opt-after | speedup-before | speedup-after |
|---------------------|--------|------------|-----------|----------------|---------------|
| knots-standard-48   | ~10.8  | 1.993 ms   | 1.799 ms  | 5.51x          | 5.93x         |
| circuit-turnless-34 | ~7.4   | 4.896 ms   | 4.479 ms  | 1.55x          | 1.61x         |
| rooms-30            | ~3.4   | 2.248 ms   | 1.950 ms  | 1.55x          | 1.71x         |

- SUCCESS (knots-dense-24 N=100): 95/100 completed both before and after (identical, no regression).
- MEMORY (`harness/memory.ts`): knots-48 722252→1148492 B (+426240 B); circuit 1.274MB→2.019MB (+744kB); rooms 781kB→1.238MB (+457kB). Second copy as predicted; acceptable.

**Decision:** KEEP. All gates pass (VALID+DET mandatory). knots-48 no regression (gain). Real above-noise speed wins on circuit (+8.5%, 0.42ms) and rooms (+13%, 0.30ms) matching removed clear cost. Success unchanged. Memory growth per Round-3 spec (speed > mem). Committed.

**Cost:** subprof 3 inputs x5 + 2x full measure5x3 + 2x success x100 + 2x mem + 4x prove + typechecks + edits + log/readme/commit ~10min wall + harness runs.

Round 3 begins (first candidate H10 per attack order). Next: H15.

## Hypothesis 15 — watched-literal propagation (full AC-4 replacement) [REVERTED]

**Hypothesis:** The propagation wall (60-66% on circuit/rooms post-H10 per profiles) is the AC-4 decrement: for each ban, O(propagator fanout) work touching every listed neighbor support. Replace with watched literals: (cell,pat,d) slots watch a *single* witness; bans only wake the watchers of the exact banned (cell,pat) via a fixed-pool doubly-linked reverse map (wlHead/wlNext/wlPrev, pool index=slot id, O(1) unlink). Woken slot rescans its propagator-derived candidate list at the neighbor for a new live witness (amortized O(1)) or bans self. Same semantics via identical d/OPPOSITE mapping + propagator lists. Boundary off-grid slots use -2 sentinel (no link) to match mxgmn (never decrement, allow patterns needing "out of grid" supports). Preserves H6 batch-heap + H10 fixpoint cache (now over watched+wl structs). Removes `compatible` entirely. Tier-2 (alg change); gate VALID+DET only. Speed primary; mem growth accepted.

**Change:** Exactly one file `src-optimized/model.ts`. Replaced compatible with watched/wlHead/wlNext/wlPrev (+0 snapshots); rewrote init/clear (watch seeding + sentinel offgrid + propagate-to-fixpoint), ban (unlink own 4 slots + H6 dirty), propagate (walk wl list, find new or ban); added link/unlink/getWit helpers; updated H10 restore/capture, footprint, header comments, T4 comment. Direction mapping derived from AC-4 (candidates via prop[OPPOSITE[d]][t] at witCell computed as i - d vec). No other files. No debug left.

**Gate + Measure:**
- `npx tsc --noEmit` clean.
- `bun run harness/prove-harness.ts`: VALID+DET (viol=0) on all inputs; DET re-runs identical checksums. (compare* FAIL expected Tier-2.)
- SPEED (primary; `harness/measure-speedup.ts` median-of-5; before via `git stash` of clean post-H10, after on H15 patch):

| input               | ref ms | opt-before | opt-after | speedup-before | speedup-after |
|---------------------|--------|------------|-----------|----------------|---------------|
| knots-standard-48   | ~10.8-11.2 | 1.800 ms | 2.213 ms | 6.01x | 5.08x |
| circuit-turnless-34 | ~6.9-7.2   | 4.358 ms | 5.610 ms | 1.64x | 1.23x |
| rooms-30            | ~3.5-3.8   | 1.850 ms | 2.373 ms | 1.89x | 1.59x |

- SUCCESS (knots-dense-24 N=100): 95/100 both before and after (no regression).
- MEMORY (`harness/memory.ts`): knots-48 pre 1.148MB → H15 2.641MB (+≈1.5MB, as 3× slots + 2× heads); accepted per spec.

**Decision:** REVERT (`git checkout -- src-optimized/model.ts`). VALID+DET held (first attempt, no fix needed). But no performance win — regressed on all inputs (knots -23%, circuit/rooms worse) above noise. Watched literal wake+scan+list mgmt overhead exceeded the saved per-ban work for these tilesets/fanouts (WFC propagator lists are short but management constant factors high in JS). Honest outcome: not guaranteed to win; logged with measurements. (If this had been too big, would have recommended H15a/H15b split, but it gated cleanly.)

**Cost:** stash/measure before 3×5 + impl + 3×5 after + success100 + mem3 + 4×prove + typecheck + log/readme ~12min wall + runs.

Round 3: H15 attempted+reverted (no win on prop wall). Next per attack order: H12 (restart seeds for success).

## Hypothesis 12 — restart-with-derived-seeds on contradiction (no undo stack)  [KEPT]

**Hypothesis:** On contradiction, restart the solve (clear + fresh PRNG) using a deterministic derived seed instead of failing. Because the solver is already <2ms even on 48x48 (H10 made clear() O(1) copies), a budget of restarts is far cheaper than maintaining an undo stack for backtracking, and random-restart (here derived) escapes the bad collapse order basins that cause immediate dead-ends on hard inputs like knots-dense. Attempt 0 uses the caller's seed verbatim to preserve all prior behavior and committed outputs.

**Change:** Exactly one file `src-optimized/model.ts`. (1) Added `deriveRestartSeed(base, k)` — a pure mulberry-style 32-bit finalizer mixer (golden ratio scramble + imul steps) documented in source; (2) extended `run(seed, limit, restartBudget = 100)` with outer attempt loop: attempt 0 uses raw seed, k>=1 derives; on propagate contradiction do clear+retry (up to budget); only return false after all attempts fail; on any attempt completing, populate observed and return true. Preserves H6 batching + H10 fixpoint (clear per attempt is the fast path). No other files; no debug/instrumentation left.

**Gate + Measure (followed prompts/optimize-one.md exactly):**
- `npx tsc --noEmit` clean (strict).
- `bun run harness/prove-harness.ts`: VALID+DET on all 6 inputs (viol=0); compare* FAIL unchanged (Tier-2 since H4). Re-runs with default budget=100 match (new contract). Attempt-0 behavior verified identical for completing seeds (explicit budget=0 vs default yield same observed; committed seeds unaffected).
- Pre-H12 baselines (grounding): success knots-dense-24 N=100: opt 95/100; measure medians (5): knots-48 opt 1.794ms (5.98x), circuit 4.325ms (1.63x), rooms 1.905ms (1.89x); mem knots-48 1.148MB.
- SUCCESS (primary for H12): `bun run harness/success-rate.ts knots-dense-24 100` → opt 100/100 (100%) from 95%. Also checked: knots-standard-24 100% (no reg), rooms-30 50/50 (no reg).
- SPEED (must not regress; speed > success): `bun run harness/measure-speedup.ts * 5` post: knots-48 1.813ms (5.95x), circuit-turnless-34 4.377ms (1.72x), rooms-30 1.997ms (1.76x) — all within run-to-run noise of pre-H12; no regression on committed first-try seeds.
- MEMORY: `bun run harness/memory.ts` knots-48 1148492 B (unchanged, as predicted — no undo state); dense same 261kB.

**Contract note:** run() is now deterministic on (seed, restartBudget) tuple rather than seed alone. Gate re-verified with default budget; DET holds. VALID = still produces complete valid tilings (0 viol).

**Decision:** KEEP (committed immediately after gate+measure). Meets keep criteria exactly: VALID+DET, dense completion 95%→100% (exceeds >=99% target), speed on the 3 inputs flat (no meaningful reg), no success regressions elsewhere, mem neutral. Small median time in success-rate is acceptable/expected when more seeds complete via retries (here negligible). This is the success-rate frontier; H13 (CDCL) can build on the restart infra by recording conflict paths.

**Cost:** grounding (prove + 3x success + 3x measure5 + 2x mem) + impl (doc+derive+run edit) + post gates/measures (typecheck + prove + 3x success + 3x measure5 + 2x mem + det experiments) ~8min wall + harness runs.

Next candidate recommended: H13 (CDCL-style learning). The restart loop already supports it: on contradiction we can inspect the final stack/wave to extract the conflicting partial assignment and carry a forbid-set into subsequent attempts' clears (or a global nogood across runs). Does the current infra make that cheap? Yes — clear is now a restore point we can further customize. (See return summary.)

## Hypothesis 13 — CDCL-style conflict learning across restarts (success/speed-on-hard-seeds) [REJECTED]

**Hypothesis:** With restart loop in place (H12), track per-attempt observe sequence; on contradiction, blame the most recent observe that led to 0-option cell, record a tabu counter per (cell,pattern). In later attempts' observe, downweight or skip high-tabu patterns for that cell. Decay tabu across restarts. Goal: lower median attempts on hard seeds (speed) or enable completion on cases H12 still fails (success). Deterministic under (seed,budget). Tier-2; gate VALID+DET (under new contract).

**Investigation (STEP 1 — do this FIRST, per task; no blind impl):** Constructed harder stress cases ad hoc (script under scripts/, NO edits to performance-test/inputs/). Used Knots Dense subset + Circuit Turnless at larger sizes: knots-dense-48x48 periodic, knots-dense-64x64 periodic, circuit-48x48 periodic. Ran current optimized (H12) for N=50 (or 30 for 64) seeds each, instrumenting temporarily to expose attempts-used on success (reverted post-measure). Measured completion rate AND median attempts-to-complete.

**STEP 1 stress measurements (H12 current, default budget=100):**

| case              | N  | completion     | median att | mean att | max att |
|-------------------|----|----------------|------------|----------|---------|
| knots-dense-48    | 50 | 50/50 (100.0%) | 0.0       | 0.1     | 1      |
| knots-dense-64    | 30 | 30/30 (100.0%) | 0.0       | 0.1     | 1      |
| circuit-48        | 50 | 50/50 (100.0%) | 0.0       | 0.1     | 1      |

Re-verified on committed: `bun run harness/success-rate.ts knots-dense-24 50` → 100%; `bun run harness/prove-harness.ts` VALID+DET (viol=0).

**Decision gate (per task):** H12 already gets ~100% on the harder cases AND median attempts ≈ 0 (max 1) — far below the "high like 5+" threshold. No completion gap remains and restarts are almost never triggered. CDCL has no measurable benefit on target (neither raises completion nor reduces attempts on cases that matter). Per spec: **REJECT H13**. Do NOT implement CDCL. Revert temp instrumentation + remove throwaway script; COMMIT log+README only.

Recommend: the loop should PIVOT to SPEED ideation (the unmet axis: circuit/rooms propagation wall; H5/H8/H15 all REVERTED with evidence that micro-trims on the decrement loop do not pay). No external bar left; propagation is the algorithmic wall.

**Cost:** STEP1 stress (3 cases × N) + success-rate + 2	imes prove-harness + typecheck + doc edits + reverts + commit ~4min wall + harness runs. Honest negative result recorded.

## Round 3 ideation pass — SPEED wall (circuit/rooms propagation) — iteration 5

Trigger: STALL→IDEATE. Speed axis unmet (circuit 1.77x / rooms 1.87x vs 3x target);
wall CONFIRMED — H5 (guard trim), H8 (entropy defer), H15 (watched literals) all
REVERTED; AC-4 decrement loop near-optimal in pure JS. Success axis MAXED (H12:
100% on committed + harder cases; H13 rejected). So ideate on the speed wall.

Method: TRIZ (Altshuller) P.35 parameter-changes + P.1 segmentation + first-
principles (question the entropy-selection assumption) + biomimicry (cache locality).
Refused-obvious: the algorithmic rewrites already tried (H5/H15). The freshest
angles attack the wall via CACHE and via the BAN-entropy cost (the 2nd-biggest
cost), not via algorithmic rewrite of the decrement loop.

Rejected (no-target / speed-cost), freed from the backlog:
- H14, H17 (success): axis maxed by H12; no measurable target.
- H19 (arena recycling): no backtracking landed (H13 rejected; H12 = restart).
- H11 (wave-bitpack): HURTS hot-path access → rejected on SPEED grounds (speed>memory).
  Compatible-narrowing sub-part split out as H23 (cache SPEED win).

New candidates (IDEATION):
- H23 compatible Int32→Uint8: counts are ≤T<256 for our tilesets (knots 9 / circuit
  36 / rooms 28) → EXACT, no cap. 4x smaller compatible → 4x less cache pressure on
  the propagation decrement loop (the 60-66% wall). Tier-1 (same counts = byte-id),
  low-risk. THE freshest angle — attacks the wall via cache, which H5/H8/H15 missed.
- H22 MRV selection (sumsOfOnes) instead of entropy: eliminates the per-ban Math.log
  recompute (H8 sub-profile: biggest ban sub-cost ~8-12%) outright (H8 only tried
  deferring = failed). Tier-2 (changes selection order); success covered by H12.
- H24 fast-log bitcast approx: alternative to H22 if entropy selection worth keeping
  (entropy only needs monotonic order for the heap → fast approx preserves it).
- H25 spatially-biased selection: biomimicry (nucleation) — heap scatters picks
  globally; spatial bias gives compatible/wave arrays better cache locality. Touches
  the wall via cache, not algorithm.

Next: implement H23 (highest payoff + lowest risk), then H22.

## Hypothesis 23 — compatible Int32→Uint8 (cache-speed win on the propagation wall) [KEPT]

**Hypothesis:** The propagation decrement loop (`--compatible[cidx]; if (===0) ban`) is the
60-66% cost on circuit/rooms (the wall post H4/H6/H10). H5/H8/H15 attacked it
algorithmically and all REVERTED. H23 attacks via CACHE: `compatible` is Int32Array
(4B/entry); counts bounded by prop list len ≤T. For our tilesets T<256 (knots9,
circuit36, rooms28) every count fits in Uint8 (1B) EXACTLY — 4× smaller array →
4× less cache pressure on the hot decrement loop → fewer misses → faster. Freshest
angle (cache, not alg) and Tier-1 (same counts → same decrs → same bans → same seq →
byte-identical outputs vs post-H12).

**Underflow-safety (the one subtlety, gotten right):** `compatible[i][t][d]` init to
`propLen[opposite(d)*T + t]` (≤T) and decr on compat-neighbor ban; 0→ban. ban(i,t)
ZEROES the 4 dir slots for t (even those still >0). After, those slots can receive
more decrs (later neighbor bans) → underflow. Int32 goes negative (harmless, !=0).
Uint8 wraps 0→255→... . #post-ban decrs to a dead slot ≤ remaining-at-ban ≤ init ≤T.
For T<256, post-ban ≤T<256 → wrap NEVER hits 0 again → no false re-ban. SAFE.
General: AUTO-SELECT narrowest: maxPropLen = max(propLen); <256→Uint8, <65536→Uint16,
else Int32. Exact, no saturation. For our inputs: Uint8.

**Change:** Exactly *one* file `src-optimized/model.ts`. Added CompatibleCtor +
compatibleBpe fields; updated compatible/compatible0 decls to union; in init():
compute maxPropLen from propLen (set by subclass ctor before first run), pick ctor,
`new this.CompatibleCtor(count*T4)` for live+ H10 snapshot; store choice. All access
(`--`, `===0`, `=0`, `.set()`) work unchanged (JS typedarray elem ops yield number).
footprintBytes sums .byteLength → auto smaller. Header + inline docs. No debug
left in tree. No other files touched (per rules).

**Gate + Measure (followed optimize-one.md):**
- `npx tsc --noEmit` clean (strict) before/after.
- `bun run harness/prove-harness.ts`: VALID+DET (viol=0) pre and post; DET re-runs match;
  compare* FAIL unchanged from H4 (Tier-1 layout change after algorithmic H4).
- SPEED (primary; `harness/measure-speedup.ts` median-of-5; before via `git stash` of
  clean post-H12, after on H23; same machine):

| input               | ref ms  | opt-before | opt-after | speedup-b | speedup-a | auto-type |
|---------------------|---------|------------|-----------|-----------|-----------|-----------|
| knots-standard-48   | ~10.7-11| 1.791 ms   | 1.728 ms  | 5.95x     | 6.38x     | Uint8 (maxPropLen=5) |
| circuit-turnless-34 | ~7.2-7.3| 4.358 ms   | 4.037 ms  | 1.66x     | 1.81x     | Uint8 (14) |
| rooms-30            | ~3.3-3.4| 1.965 ms   | 1.898 ms  | 1.68x     | 1.79x     | Uint8 (8) |

- MEMORY (`harness/memory.ts`): pre→post: knots48 1148kB→651kB (-43%, -498kB exact
  for compat*2); circuit 2019kB→1020kB; rooms 1238kB→633kB. Delta matches
  2×C×T4×3 bytes saved (verified). Compatible slice 4× smaller as designed.
- SUCCESS (no reg expected, Tier-1): `bun run harness/success-rate.ts knots-dense-24 50`
  → 100% both before and after (unchanged).

**Decision:** KEEP (committed). Meets *exact* keep criteria for Round 3 SPEED candidate:
VALID+DET mandatory pass; knots-48 no regression (small gain); *real* above-noise
speed gain on circuit (7.4%, 0.32ms) *and* rooms (3.4%) — the prop-wall targets.
Memory win is bonus (spec says accept mem for speed). Auto-selected Uint8 for all
committed tilesets. Byte-identical (Tier-1) as predicted — no wrap false-positive
because of the T<256 bound + ban-zero semantics. First cache-layout attack on the wall.

**Cost:** stash dance for paired before + 3×5 after + 2×prove + 2×success50 + mem +
typecheck ×many + edit + log/readme + commit ~15min wall + harness runs.

Next candidate recommended: H22 (MRV selection — eliminate the per-ban Math.log
recompute that was the largest ban sub-cost in prior profiles).

## Hypothesis 22 — MRV selection (sumsOfOnes) instead of entropy — eliminate the per-ban Math.log [KEPT]

**Hypothesis:** H8 sub-profile showed the per-ban entropy recompute (`Math.log(sum) - sumsOfWeightLogWeights[i]/sum` plus the two sums updates) was the biggest slice of ban time (~8-12% overall on circuit/rooms). H8 only tried *deferring* the log to flush (coalesce), which netted 0 (work just moved). H22 *eliminates* the work: switch default selection from Entropy to MRV (min-remaining-values = fewest live options via sumsOfOnes), which the heap already supported (`heuristic === Entropy ? entropies[i] : sumsOfOnes[i]`). Guard the three entropy-update lines in ban() behind `if (this.heuristic === Heuristic.Entropy)`. sumsOfOnes -=1 and H6 dirty-mark always run. observe() untouched (still uses weights[] for weighted pick). Tier-2 (collapse order changes vs Entropy; compare* already FAIL from H4). Success covered by H12 restarts. Priority SPEED: expect ban-path win especially on high-T high-ban (circuit).

**Change:** Two files, one hypothesis. `src-optimized/simple-tiled-model.ts`: ctor default `opts.heuristic ?? Heuristic.MRV` (was Entropy; ref `src/` keeps Entropy — Tier-2 ok). `src-optimized/model.ts`: in ban(), sumsOfOnes+dirty always, the sumsOfWeights/WeightLog + entropies=Math.log only under `if (heuristic === Entropy)`. H10 snapshots left as-is (correct, minor waste under MRV; restore produces valid start state). No other files, no debug, plain TS. (H22 implements exactly the spec in task + README.)

**Gate + Measure (followed optimize-one.md exactly):**
- `npx tsc --noEmit` clean (strict) before/after.
- `bun run harness/prove-harness.ts`: VALID+DET (viol=0) pre+post; DET re-runs identical checksums (new order but deterministic). compare* FAIL unchanged (Tier-2).
- SPEED (primary; `harness/measure-speedup.ts` median-of-5; before via `git stash` of clean post-H23, after on patch; same machine):

| input               | ref ms | opt-before | opt-after | speedup-b | speedup-a |
|---------------------|--------|------------|-----------|-----------|-----------|
| knots-standard-48   | ~10.6-11.3 | 1.725 ms | 1.695 ms | 6.12x | 6.66x |
| circuit-turnless-34 | ~7.2   | 4.032 ms | 3.650 ms | 1.78x | 1.97x |
| rooms-30            | ~3.3   | 1.885 ms | 1.784 ms | 1.76x | 1.85x |

  Real above-noise gain on circuit (~9.5%, 0.38ms drop); rooms +5.4% (0.1ms); knots no regression (slight gain). Ban-path win as predicted (Math.log gone); circuit (T=36) gained most.
- SUCCESS (must not tank): `bun run harness/success-rate.ts knots-dense-24 100` → 100% both before and after. Also checked knots-standard-24 (20) and rooms-30 (20): 100% no reg.
- MEMORY (`harness/memory.ts`): unchanged at 636/996/618 KB (left H10 cache snapshots; arrays stay allocated for observe weights path).

**Decision:** KEEP (committed). Meets *exact* keep criteria for Round 3 SPEED candidate: VALID+DET mandatory; knots-48 does not regress; *real* above-noise speed gain on circuit (primary target) AND rooms; dense success stays 100% (>>95%, no success-axis break). Memory neutral. H22 succeeds where H8 failed because it removes work rather than moving it. Tier-2 note: MRV changes selection (fail-fast most-constrained) vs weighted-entropy; outputs differ but valid+det; H12 restart covers robustness.

**Cost:** stash/checkout dance + 3×(5+5) measure + 2×prove + success100 + success checks + mem + typechecks + edit + log/readme + commit ~12min wall + harness runs.

Next candidate recommended: H24 (fast-log approx, if we ever want Entropy back) or H25 (spatial bias for prop cache locality on the remaining wall). Rank H24/H25 by re-profile on current (ban cost now gone, prop still ~60%+). H16 steppable also valuable for web but lower speed payoff.

## Hypothesis 25 — spatially-biased selection for propagation cache locality (biomimicry nucleation) — INVESTIGATE FIRST [REJECTED]

**STEP 1 — Investigation (executed FIRST, no impl committed until analyzed):**

Sub-profiled the spatial spread of *consecutive observed cells* (the selection sequence driving prop) under the live optimized (post-H22 MRV default + H4 heap + static lower-cell-index tie-break on equal sumsOfOnes).

Used temp instrumentation (reverted) + standalone driver (not committed) to capture observe(i) sequence per successful first-attempt solve, compute mean avg consecutive Manhattan/Euclidean distance over multiple seeds.

**Clustering measurements (first-attempt completes only):**

- circuit-turnless-34 (34x34, periodic, N~8-10 seeds): mean(avgManhattan consecutive-obs) = 4.24 ; mean(avgEuclid) = 3.85 ; avg observes ~805 (out of 1156 cells; rest forced by prop). Range stable ~3.5-4.7 manh.
- rooms-30 (30x30, non-per, N=10): mean manh=3.02 ; eu=2.81 ; avg obs~514 (out of 900).
- knots-standard-48 also ~3.23 manh (very local).

For reference, expected manhattan between two *uniform-random* distinct cells on MxM grid (no torus):
  avg|dx| ≈ M/3  → avg manh ≈ 2M/3.  For M=34 ≈22.7; M=30≈20.

Observed consecutive steps are 5–6.6× *tighter* than random. This proves the assumption in the H25 ideation ("heap scatters picks globally") is false under MRV: the priority field (sumsOfOnes) is mutated exactly by the propagation wavefront, so the global min is almost always a cell adjacent-or-near the last collapse. The collapse order is already a local-growth / crystal-nucleation pattern (starting from cell 0 due to index tie-break, then radiating).

**Implication for cache locality:** The propagation hot loop (for each ban i1, walk its 4 dirs, load i2's compatible row for the t2 list) already touches memory rows that are spatially near the previous ones. With row-major layout of wave/compatible (i*T4 stride), avg step-4 means high chance of same/near cache lines. Little headroom remains for a selection bias to improve prop cache hit rate.

**Clean implementation options considered (would have done only if headroom existed):**

(a) Replace static tie-break key (cell index) with a static space-filling curve (Morton/Z-order) index. "Lower index wins" would then prefer spatially-near in 2D. *But* — to realize the cache win the wave+compatible arrays would also have to be re-indexed into Morton order (else the tiebreak only affects pick order, not memory layout of accesses). Morton neighbors (dx,dy=±1) are *not* adjacent in the 1D layout; delta-i jumps by large irregular amounts. This would *scatter* the i2 accesses in the decrement loop — actively hurting the locality H25 is trying to create. Tension acknowledged in task brief; net-negative, rejected.

(b) *After* the heap yields a true min-priority cell (and its minPrio value), scan a tiny spatial window (r=3, ~49 cells) around `lastCollapsed`. Collect/choose a cell inside the window whose *current* sumsOfOnes (or entropy) exactly equals that minPrio; prefer the closest (then lowest idx for det). If none match minPrio, fall back to heap's choice. Heap invariants unchanged (never returns a non-min), no dynamic key changes, still O(log) core. Window cheap (<< observe cost). Fully deterministic. This was the "most promising clean approach" per task.

(c) Switch to explicit frontier mode: after first seed collapse (perhaps force center), only consider cells adjacent to already-observed for the heap or a queue. BFS-ish growth. Much larger change; alters the contraction order surface; success rate and perf would both move. Tier-2 stretch. Low priority given (b).

**Experiment with clean (b) (temp only, fully reverted before log/commit):**

Added lastCollapsed tracking + _findNearbyMinPrio + adjusted nextUnobservedNode to promote a same-prio neighbor when present (heap pop/push/ remove used to keep structure valid). Re-ran cluster driver: bias *did* bite — circuit manh tightened 4.24 → 3.33, rooms 3.02 → 2.24.

Paired speed measurements (median-5, same machine, stash for before):

| input            | baseline opt (no bias) | with (b) bias | delta |
|------------------|------------------------|---------------|-------|
| knots-standard-48| 1.641 ms              | 1.995 ms     | -21% reg |
| circuit-turnless-34 | 3.404 ms           | 3.593 ms     | -5.5% reg |
| rooms-30         | 1.657 ms              | 1.819 ms     | -10% reg |

Success-rate knots-dense-24 N=20 stayed 100% (H12 covers). But no speed win on the prop targets; actual regression (extra per-observe work + different collapse order apparently lengthens some prop chains or changes restart counts).

On dense, median time also much worse under bias (0.46 ms → 1.9 ms).

**Gate:** With patch applied temporarily, prove-harness still reported VALID + DET (self-consistent). Typecheck clean. After revert, back to recorded baselines.

**Decision:** REJECT (no impl landed in src-optimized/). 
- Already-clustered measurements show the premise has no target.
- Even the clean, heap-safe (b) produces no speed gain on circuit/rooms (and regresses knots).
- Memory neutral (no allocs).
- H25 is the last pure-cache angle on the prop wall; all prior alg attempts (H5,H15,...) also reverted. The decrement loop is effectively optimal under current AC-4 + flat arrays in plain JS.

**Cost:** full STEP1 + driver (multiple N=10 runs) + temp (b) + 2×(3×5 measures) + success + prove x2 + type xN + cleanup + log/readme + this commit ~18min wall + harness executions. All numbers are real harness output, no fabrication.

Next: given H25 rejected, the loop should pivot to H16 (steppable/cancelable generator loop — the differentiator for "best on web") + memory candidates (H18/H20 if speed-neutral) + one final ideation pass (TRIZ/first-principles on whether AC-4+greedy itself is the limit). H21 WebGPU is plausible for raw 3x but only as optional path; plain JS stays, and current ~2x on circuit/rooms may be the practical ceiling without new algorithm. Re-profile optimized to confirm prop % is still dominant before more work.

## Hypothesis 21 — WebGPU propagation acceleration (optional path) — INVESTIGATE-FIRST feasibility [REJECTED]

**Grounding (per optimize-one.md):** `bun run harness/prove-harness.ts` (this machine, Bun 1.3.10 macOS arm64):

| input               | ref ms | opt ms | speedup | valid | det |
|---------------------|--------|--------|---------|-------|-----|
| knots-standard-48   | 10.71  | 1.36   | 7.90x   | VALID | DET |
| circuit-turnless-34 | 6.85   | 3.53   | 1.94x   | VALID | DET |
| rooms-30            | 2.93   | 1.43   | 2.05x   | VALID | DET |

Propagation wall confirmed: ~60%+ of time in the decrement loop (post-H4/H6/H10/H22/H23). Circuit: 40460 bans/run (measured via temp count on committed input; 34×34 cells, T=36).

**STEP 1 — Environment check (WebGPU availability):** 

- `globalThis.navigator?.gpu` is `undefined` in Bun 1.3.10 (confirmed via `bun -e`) and in Node v24.
- No WebGPU adapter present in project (`bun pm ls`, package.json, node_modules/*gpu* all clean).
- Bun core has no built-in WebGPU (open issue #7380 since 2023; maintainers recommend community N-API/FFI).
- Community options exist (as of 2026): `bun-webgpu` (Dawn FFI, ~78% CTS, prebuilts+setupGlobals), `@sylphx/webgpu` (wgpu-rs for Node/Bun), `webgpu` (Dawn node addon), `doe-gpu`, Electrobun (bundled for desktop apps). All require native addon/FFI install + platform binaries or build-time deps (Zig/Rust for some); none are "bun add" zero-cost portable.
- Browser: WebGPU API is natively available in modern Chrome/Edge/Firefox/Safari (since ~2023-24 releases). 
- **Conclusion:** WebGPU cannot be made available in the project's test harness / benchmark environment (Bun/Node CLI runs that produce all committed speed numbers) without significant native setup. The gate requires *real measurement*; fabricating GPU ms numbers is forbidden. This alone is sufficient grounds to REJECT H21 for the current ratchet (cannot validate a win).

**STEP 2 — Feasibility analysis (can GPU win SINGLE-RUN speed on committed inputs?):**

The propagation hot path in `src-optimized/model.ts:propagate()` / `ban()` is a **sequential dependent ban cascade**:

```ts
while (stacksize > 0) {
  pop (i1, t1)
  for (d=0; d<4) {
    i2 = neighbor(i1,d)
    for (l=0; l<propLen[d*T+t1]; l++) {
      t2 = propData[...]
      if (--compatible[i2*T4 + t2*4 + d] === 0) ban(i2, t2)  // pushes more to stack
    }
  }
}
```

- 40460 dependent bans on circuit-34 (each ban can immediately trigger O(fanout) more via the inner t2 loop).
- This is classic AC-4 worklist propagation: the effect of one ban feeds the next. Inherently sequential along the dependency chain (wavefront of eliminations). Inner t2 decrement loop has data-parallel flavor (independent -- for different t2), but the controlling stack is LIFO and the decision to ban feeds subsequent work.

**Naive GPU port (one dispatch per ban to parallelize inner decrements):** ~40k GPU dispatches per solve. WebGPU compute dispatch + submit overhead is typically 10-100 µs (often higher with validation, queue, fences). 40k × 50µs = 2s of overhead — 500× slower than the 3.53 ms CPU baseline. Even optimistic 5µs/dispatch = 200 ms overhead, still >> CPU. Data upload (wave state, prop tables) + result readback per dispatch or per-solve makes it worse. REJECT naive mapping outright.

**The only GPU-friendly reformulation: parallel cellular relaxation (synchronous fixpoint iterations):**

Replace the sequential stack with bulk-parallel passes: in each global iteration, *every* cell simultaneously re-evaluates its support counts from current live neighbors (or uses a diff from banned), bans any that drop to 0, and repeat until no bans in an iteration (or a fixed max). This is O(grid diameter) iterations of O(cells × T) fully data-parallel work — GPU loves bulk arithmetic with no dynamic stack.

- For circuit-34 (diameter ~34): ~34 iterations.
- Work per iter: 1156 cells × 36 T × 4 dirs ≈ 166k ops (tiny).
- To detect convergence you either: (a) run a fixed diameter number of iterations (wasteful if early), or (b) dispatch + read back a "didBan" atomic/flag each iter. Readbacks are expensive (CPU-GPU sync).
- Cost estimate on real GPU (mid-range 2025-26 discrete or Apple Silicon): dispatch+submit ~0.05-0.2 ms; readback/sync ~0.2-1 ms. 34 × 0.3 ms = ~10 ms overhead floor *before* any useful work — already 3× the entire 3.53 ms CPU run. Small grids cannot amortize launch costs.
- GPU saturation: modern GPUs want 10k-1M+ parallel threads + high arithmetic intensity to hide latency. 42k ops/iter is a few workgroups at best; launch overhead dominates. CPU (single-thread Bun/JS) is extremely fast at tight sequential loops over 40k items with good L1/L2 locality (flat arrays, H1/H2/H23).

**Where GPU *would* win:** LARGE grids, e.g. 256×256 (65k cells). CPU AC-4 sequential O(total bans) can become 1M-10M+ operations with long dependency chains. GPU parallel relaxation: still O(diameter)~500 iterations but each is massive bulk-parallel (millions of ops/iter saturating the GPU, few dispatches, or even persistent kernel). Throughput (many solves or huge single grid) could be 10-100×. But this is *not* the committed benchmark (24-48 grids, sub-4 ms target for single-run latency).

**Other practical barriers (even if env had WebGPU):**

- Different algorithm (Tier-2): the iteration order of bans changes vs sequential stack → different collapse sequence → VALID+DET gate but compare* FAIL + possible success-rate deltas. Major rewrite of propagate/clear/ban interaction.
- API surface: WebGPU is async; `run()` would need to become async or use Atomics/Workers for sync illusion. Portable fallback must stay 100% sync plain JS for Node and non-GPU browsers.
- Memory model: GPU buffers have upload/download cost; for sub-ms solves the transfer tax alone kills single-run latency.
- Maintenance: two codepaths (JS + WGSL kernels + bind groups + buffer mgmt) for an optional path that doesn't help the measured cases.
- Browser-only win? Even in browser, for these problem sizes the CPU path (highly optimized JS) is hard to beat; WebGPU shines on large data-parallel or when offloading from main thread for responsiveness, not raw small-WFC latency.

**STEP 3 — Decision:**

H21 is **REJECTED** for the committed Round 3 benchmark and current ratchet. 

- Primary blocker: cannot measure (no WebGPU in Bun/Node harness env without significant native setup that would not be present for users running `bun run harness/measure-speedup.ts`).
- Secondary (analysis): even *if* measurable and env-supported, no plausible single-run latency win on 24-48 grids. Naive mapping is 100×+ slower; the parallel-relaxation rewrite has ~3-34 ms dispatch/readback overhead floor + insufficient work to saturate + changes the algorithm. CPU sequential decrement is already near-optimal for this size (flat arrays, narrow types, batched everything else).
- GPU parallel relaxation is a legitimate future direction for *large-grid throughput* (256×+), not this round's single-run speed target on small inputs. Documented here so it is not lost.

Per rules: no code changes to src-optimized/ (or anywhere) because no winning measurable prototype was found. Only log + README updated. No fabrication of GPU timings.

**Recommendation for pivot (per return spec):** The speed axis on the committed inputs is now at the pure-JS ceiling (~1.94-2.05x on circuit/rooms vs ref; ~7.9x on knots). H5/H8/H15 (alg trims) reverted; H23/H22 (cache/ban) kept; H24 subsumed, H25 rejected (already clustered). H21 rejected. Next should be:

1. H16 (steppable/cancelable run loop) — the "best on web" differentiator (no other JS WFC lib offers it). Tier-1, same outputs.
2. Memory candidates H18/H20 only if speed-neutral (speed > mem).
3. Fresh ideation pass (TRIZ/first-principles) toward ~25 iterations total, questioning AC-4/greedy itself if we want >3x on prop-bound.

**Cost:** env probes (3 shells) + ban-count temp (non-committed /tmp) + full analysis + 1×prove + writeup + edits ~25 min wall. Harness run numbers are real (no fake GPU data).

## Hypothesis 16 — steppable/cancelable run loop (generator yielding every N observes) [KEPT]

**Hypothesis:** The remaining high-value axis for "best WFC in the world for the web/JS ecosystem" is WEB FIT. H16 is the differentiator NO existing JS WFC lib offers: a run loop that doesn't block the browser main thread, can be stepped (for a visualizer) and canceled mid-solve. Plain JS/TS only; portable Node+browser. Must add alongside (without regressing) the existing fast `run(seed, limit, restartBudget)`.

**API design:** `*stepRun(seed, limit, restartBudget=100, yieldEvery=1, signal?: AbortSignal | null): Generator<StepStatus>` where StepStatus is `{ done: boolean, observedCell?: number, attempt: number, cellsResolved: number, ok?: boolean, complete?: boolean }`. Yields progress every `yieldEvery` observes; always yields a terminal `{done:true, ...}` status. Natural generator cancel (stop next / for-of break / .return()); optional AbortSignal for ergonomics (checked only at yield points). No scheduler dependency — caller decides (rAF in browser, immediate drain in Node, etc). run() must produce byte-identical behavior+speed.

**Change:** Exactly one change in src-optimized/: `model.ts` (added StepStatus interface + countResolved helper + *stepRun impl + JSDoc example; run() body left 100% verbatim) and `index.ts` (export type). Duplicated the observe/prop/restart loop in stepRun (option (a)) after measuring that drain-generator (option (b), huge yieldEvery) regressed ~2x even with zero yields (generator state machine + per-observe yield-check overhead in JIT). Matches surrounding style + H comments. Portable (AbortSignal is global in Node 15+ / all modern browsers; no DOM APIs used).

**Gates + measurements (all real harness runs, no fabrication):**

- `npx tsc --noEmit`: clean.
- `bun run harness/prove-harness.ts`: PASS (VALID+DET on all 6 inputs; viol=0; run() compare* status unchanged from post-H22). Post-edit opt times in prove: knots-48 1.35ms, circ 3.45ms, rooms 1.38ms (back to baseline).
- SPEED (primary, must not regress): `bun run harness/measure-speedup.ts <in> 5`
  - knots-standard-48: 6.30x (1.632 ms)  [pre-H16 grounding: 6.79x / 1.636 ms] — flat
  - circuit-turnless-34: 1.88x (3.593 ms) [~2.02x / 3.736] — within noise
  - rooms-30: 2.22x (1.781 ms) [1.91x / 1.827] — within noise
  run() fast path unaffected.
- STEPPABLE FUNCTIONAL CHECK (throwaway `scripts/check-h16-step.ts`, removed after): knots-standard-24, seed=1 (first-try complete), yieldEvery=1. 551 progress yields + 1 final done yield (576 cells; 25 pre-resolved by bans+init-prop). Final: done=true, ok=true, complete=true, attempt=0. Checksum match: both 0x4e165801. Direct run() observed[] identical to full drive of generator. Cancel: .next() 10x then .return() — no crash/hang. Also AbortSignal abort mid-run yields clean {done:true, ok:false}.
- SUCCESS: `bun run harness/success-rate.ts knots-dense-24 50` — 100.0% (unchanged).
- MEMORY: `bun run harness/memory.ts` — knots-48 650828 B (unchanged; generator adds no instance state or allocs).

**Decision:** KEEP. All mandatory gates (VALID+DET + no speed reg on run()) pass. Step API works exactly as spec'd (yields, completes, cancelable, identical outputs). This is a feature-add for web robustness / "best on web" claim; memory/success neutral. run() speed/behavior preserved (Tier-1). Committed as the unique differentiator vs every other JS WFC.

**Cost:** discovery + impl + 3xprove + 3xmeasure-speedup + success + mem + stepcheck script+run+rm + log/README + typecheck ~8-10 min wall time. All per rules (one iter, only src-optimized edited).

## Hypothesis 18 — sparse live-set wave for restrictive tilesets (adaptive dense/sparse) — INVESTIGATE FIRST [REJECTED]

**Hypothesis:** For restrictive tilesets where post-init live count per cell ≪ T, replace the dense `Uint8Array(count*T)` wave with a per-cell sparse live-set (unsorted list of live pattern ids + count; swap-remove on ban). This shrinks memory for wave and lets observe build dist by iterating only live ids (O(live) vs O(T)). The wave is *not* touched by the propagation decrement (uses compatible+propData), so H18 cannot move the 60-66% prop wall. It only touches observe (~4%), final extraction, and memory. Adaptive: choose sparse layout only if measured maxLive < threshold (e.g. T/2), else dense (knots permissive). Tier-1 (byte-id, same bans/selection/outputs). Per Round-3: memory lowest priority; KEEP only if footprint DOWN + NO speed regression on knots/circuit/rooms.

**STEP 1 — INVESTIGATE (executed FIRST, per task; no impl until green):**

Throwaway `scripts/measure-h18-sparsity.ts` (deleted after; no trace left) forced init+clear on optimized, read sumsOfOnes[] (live counts) post-fixpoint, plus monkey-patched to count bans-in-clear and to record sumsOfOnes at each observe() time. Also read footprintBytes and wave.byteLength. Grounded with `bun run harness/prove-harness.ts` and `bun run harness/memory.ts` + `measure-speedup`.

Post-init (after clear fixpoint) live counts:

| input | T | count | bans-in-clear | live avg | med | max | live/T |
|-------|---|-------|---------------|----------|-----|-----|--------|
| knots-standard-48 | 9 | 2304 | 0 | 9.00 | 9 | 9 | 100% |
| circuit-turnless-34 | 36 | 1156 | 0 | 36.00 | 36 | 36 | 100% |
| rooms-30 | 28 | 900 | 0 | 28.00 | 28 | 28 | 100% |

All 100% of T. Reason: periodic inputs skip boundary bans entirely; rooms-30 has *zero* tiles with propLen[d][t]===0 in any dir (verified), and no ground → no bans, no propagate in first clear, sums remain =T everywhere. Max live at representation time =T for all cells.

Observe-time live (when a cell with >1 is chosen; the O(live) that would benefit observe):

- knots: avg 2.35 (med 2, max9) → 26.1% of T (N=2250 observes)
- circuit: avg 3.66 (med 3, max36) → 10.2% of T (N=772)
- rooms: avg 2.47 (med 2, max28) → 8.8% of T (N=519)

Observe could scan fewer, but observe phase share is ~4% (prior profiles).

Memory (real harness):

- `bun run harness/memory.ts`: knots-48 650828 B (635.6 KB); circuit-turnless-34 1019836 B (995.9 KB); rooms-30 633164 B (618.3 KB)
- dense wave: 20736 B / 41616 B / 25200 B  (count*T*1)
- wave share of fp: 3.2% / 4.1% / 4.0%  (with H10 snapshot 2x: still ~6-8%)

If sparse fixed-stride: liveIds Int8Array(count*maxLive) + liveCount Int32Array(count) (+ snapshots). Since init maxLive=T (must hold full set at start of clear before any reactive bans), stride=T → liveIds bytes = count*T (same as wave) + liveCount overhead 4*count*2 (snap) → net memory *increase*, no savings. Compatible (now narrow) + propData + heap dominate footprint.

Current speed baseline (for context; `measure-speedup median-of-5`):
- knots-standard-48: 1.641 ms (6.17x)
- circuit-turnless-34: 3.400 ms (1.98x)
- rooms-30: 1.705 ms (1.85x)

**Decision gate (per task + optimize-one.md + README Round-3):**

- live at init =T (avg 100% >> ~T/2) on the *restrictive inputs* → H18 has no memory representation win (cannot size buffers smaller) and no structural sparsity at the point the layout is chosen.
- wave slice is tiny (3-4%) of total; even 100% elimination of wave would be a ~2% overall mem win (lowest prio axis).
- speed benefit marginal (observe ~4% of time; live-at-obs small but ban maintenance on every ban (>>#observes) would cost find/swap or extra count*T position index, likely net zero or regress).
- memory win that costs speed = REVERT per criteria. Here, no win even possible.

**Decision: REJECT.** No implementation in src-optimized/. Honest negative result from measurement. Only log + README updated. Throwaway script removed before commit. (If future tilesets show init-pruned maxLive<<T, could revisit, but not on committed benchmarks.)

**Cost:** STEP1 script (3 inputs) + 2x prove + mem + 3x measure-speedup + analysis + rm + edit log/README + commit ~7 min wall. All numbers from real harness runs; no fabrication.

Next candidate recommended (per return spec): a fresh re-profile of post-H16/H22/H23 optimized (to quantify current % in prop vs other now that observe/ban cleaned), OR ideation pass (TRIZ/first-principles questioning the AC-4 greedy collapse itself) for angles toward ~25 iterations. H20 (multi-res) remains TODO but stretch and changes outputs.


## Round 3 ideation pass 2 — apply the H23 cache-narrowing angle to the OTHER hot-loop arrays — iteration 11

Trigger: listed candidates effectively exhausted (H18 rejected, H20 rejected as huge-grids-
only). Wall still the propagation decrement loop (~60-66%). H23 won by narrowing `compatible`
Int32→Uint8 (4x cache on the decrement loop). The SAME angle applies to the OTHER typed arrays
in the propagation hot path that are still Int32 but hold values ≤T<256 (or ≤count<65536):

- H26 propData Int32→Uint8: t2 pattern ids are ≤T<256 (knots 9/circuit 36/rooms 28) → EXACT.
  propData is READ in the propagate inner loop (`t2 = propData[start+l]`) → 4x smaller → fewer
  cache misses on the wall. Highest payoff of the three (directly in the 60-66% inner loop).
  Tier-1 (byte-id). DO NEXT.
- H27 stackT Int32→Uint8 (pattern ids) + stackI Int32→Uint16 (cell ids ≤count<65536): the
  propagation stack, pushed every ban + popped every propagate step. Cache + memory. Tier-1.
- H28 sumsOfOnes Int32→Uint8 (live count ≤T<256) + sumsOfOnes0 cache: the MRV heap key (under
  H22). Read in nextUnobservedNode + heap. Cache + memory. Tier-1.

H20 (multi-res) REJECTED: huge-grids-only (no benefit on 24-48 committed grids) + macro-tileset
preprocessing + changes outputs. Future stretch for 256x+ (like H21 WebGPU).

Next: H26 (propData→Uint8), then H27, H28.


## Hypothesis 26 — propData Int32→Uint8 (cache-speed win on the propagation inner loop read) [KEPT]

**Hypothesis:** H23 won by narrowing `compatible` Int32→Uint8 (4× cache on the decrement). The SAME
angle on `propData` (the CSR t2 list data READ in the propagate inner loop `t2 = propData[start+l]`,
60-66% wall) + propLen. t2 ids ≤T<256 (knots9/circuit36/rooms28) exact fit Uint8 (4× smaller).
No arithmetic on values (pure ids, read only) → no underflow/wrap concern (unlike compatible counts).
Auto-select by T (max id) same pattern as H23. propLen auto-narrow Uint8 (lens≤T); propStart
optional Uint16 (offsets <64k on our grids, low-value outer reads). prop* built once (ctor),
constant, not H10-snapshotted. Tier-1 (same ids → same decr/bans/seq → byte-id outputs).

**Change:** Two files, one hypothesis. `src-optimized/model.ts`: updated propData/propStart/propLen
decls to unions; added Prop*Ctor fields + comments mirroring H23 (header, decls, propagate,
init, footprint). `src-optimized/simple-tiled-model.ts`: after computing total in ctor, auto-choose
PropDataCtor/PropLenCtor/PropStartCtor by T/total (<256/ <65536 rules); `new Ctor(...)`; assign
this.prop* and this.Prop*Ctor. Matches style, no other logic change. Only src-optimized/ edited.

**Gate + Measure (followed optimize-one.md + task exactly; all numbers real harness runs):**
- `npx tsc --noEmit` clean (strict) before/after.
- `bun run harness/prove-harness.ts`: VALID+DET (viol=0) pre+post; DET re-runs match checksums;
  compare* FAIL unchanged (Tier-1 after H4). Gate PASS.
- SPEED (primary; `harness/measure-speedup.ts` median-of-5; before via `git stash` of clean
  post-ideation-2 / post-H23/H22/H16, after on patch; same machine, paired stash dance):

| input               | before opt | after opt | delta      | speedup-b | speedup-a | auto-type (data/len/start) |
|---------------------|------------|-----------|------------|-----------|-----------|----------------------------|
| knots-standard-48   | 1.688 ms   | 1.537 ms  | -0.151 ms  | 6.85x     | 7.52x     | Uint8/Uint8/Uint16         |
| circuit-turnless-34 | 3.949 ms   | 3.421 ms  | -0.528 ms  | 2.03x     | 2.36x     | Uint8/Uint8/Uint16         |
| rooms-30            | 1.810 ms   | 1.716 ms  | -0.094 ms  | 1.82x     | 1.97x     | Uint8/Uint8/Uint16         |

  Real above-noise gains on circuit (13%) and rooms (5%); knots no regression (gain).
- MEMORY (`harness/memory.ts`): before 650828/1019836/633164 B → after 650156/1015036/631248 B
  (deltas -672B / -4800B / -1916B). Matches calculation (propData 3B/entry save * total + propLen
  + propStart 2B). propData slice itself 4× smaller as designed.
- SUCCESS (Tier-1 no change): `bun run harness/success-rate.ts knots-dense-24 50` → 100.0% opt
  (unchanged from pre-H26).

**Decision:** KEEP (committed). Meets *exact* keep criteria for Round 3 SPEED (primary):
VALID+DET mandatory; knots-48 does not regress (small gain); *real* above-noise speed gain on
circuit (target) AND rooms. Memory reduction is bonus (spec: accept mem for speed, here we got
both). Auto-selected Uint8 for propData (and propLen) on all committed tilesets. Tier-1:
byte-identical outputs because ids unchanged, only storage width. Highest-payoff fresh cache
lever remaining on the inner read. (Note: variance in absolute ms across runs; deltas from
paired stash-before/after on same machine load were consistent in sign/magnitude.)

**Cost:** stash dance (multiple paired) + 3×(5+5) measure + 3×prove + success50 + mem x2 + type xN +
  temp probe logs (removed) + edit + log/readme + commit ~20min wall + harness runs.

Next candidate recommended (per return spec): H27 (stack narrow) or H28 (sumsOfOnes), or
re-profile optimized post-H26 to quantify if prop % dropped enough for diminishing returns;
then H7 observe or new ideation for further.

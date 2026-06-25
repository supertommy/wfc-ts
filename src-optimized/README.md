# src-optimized — Optimization Plan + Candidate List

The optimized WFC solver. Starts from the reference (`src/`) and is optimized
under the Mike Acton ratchet. Each iteration is run by a subagent following
`prompts/optimize-one.md`; this file is the shared state the subagent reads and
updates. The orchestrating `loop_control` decides stop/continue from the exit
criteria at the bottom.

## Reference baseline (measured, median-of-5, this machine: macOS arm64 Bun 1.3)

| input | ref median |
|-------|-----------|
| knots-standard-48 (T=9, 48×48) | ~10.07 ms |
| circuit-turnless-34 (T=36, 34×34) | ~6.98 ms |
| rooms-30 (T=28, 30×30) | ~3.10 ms |

## Profile (where the cycles go) — `bun run scripts/profile.ts`

Two regimes:

| input | T | dominant | share |
|-------|---|----------|------|
| knots-standard-48 | 9 | propagate 56% + nextUnobs(flush+extract) 22% | post-H4/H22/H23+ (see iter-15 profile) |
| circuit-turnless-34 | 36 | **propagation** (decr loop) ~87% | (clear now <1% thanks H10; next ~7%) |
| rooms-30 | 28 | **propagation** ~85% | narrowing (H23+) made prop % *higher* as other work shrank |

Small-T-large-grid is **scan-bound**; larger-T is **propagation-bound**.

## Match contract

Gate = VALID + DET (valid+complete tiling, deterministic). The optimized need
NOT byte-match the reference (WFC outputs aren't unique). `compare*` is
informational. See `prompts/optimize-one.md`.

## Candidate list (ranked by Amdahl payoff; status updated each iteration)

| # | candidate | tier | targets | status | result |
|---|-----------|------|---------|--------|--------|
| H1 | flatten wave + compatible to typed arrays (SoA) | 1 (byte-id) | propagation + scan reads | KEPT | 1.27/1.17/1.19x on knots-48/circuit/rooms |
| H2 | flatten propagator to flat CSR typed arrays | 1 (byte-id) | propagation (circuit/rooms) | KEPT | 1.40/1.59x on circuit/rooms (prop-bound targets; +~16-20% over H1); knots within noise |
| H4 | heap-based entropy selection (O(log n) extract-min + decrease-key) | 2 (valid+det) | scan (knots-48, 83%) | KEPT | 6.65x on knots-48 (1.72ms vs 11.44); 1.60/1.62x on circuit/rooms; compare* FAIL expected (Tier-2) |
| H5 | propagation: skip/dedup work on already-collapsed cells; trim per-decrement overhead | 1 (byte-id) | propagation (now dominant post-H4) | REVERTED | regressed (added checks in hot path cost more than saved; knots 2.05→2.25ms, circ 4.95→6.67ms); see log |
| H6 | heap decrease-key cost on large-T (many bans) — batch/lazy heap updates | 2 (valid+det) | ban + heap (circuit T=36) | KEPT | batching: opt 2.03→1.97 / 4.96→4.70 / 2.54→2.13 ms (knots/circuit/rooms); +5-16% on prop-bound; no knots regress; VALID+DET |
| H7 | observe weighted-pick is O(T) per collapse — precompute/cumsum for large T | 1 (byte-id) | observe (circuit T=36) | REVERTED | O(T) cumsum+bisect no gain vs linear (circuit 4.73→4.72ms within noise); exact sel. preserved (byte-id vs H6); see log |
| H8 | ban per-call overhead (sums updates + 4x compat zero + entropy + heap update/remove) for high ban volume | 2 (valid+det) | ban+heap (25-31% on circuit/rooms) | REVERTED | no above-noise gain (entropy subprof largest but Math.log defer net ~0 within var); see log |
| H9 | eliminate dist[] materialization in observe (direct wave+weights scan for sum/pick, still O(T) but save stores) | 1 (byte-id) | observe (4%) | REJECTED | low-Amdahl sub-micro of the observe phase; H7 already showed observe O(T) reorders yield no measurable gain at T=9/36, so a strictly smaller observe tweak (saving a few stores) cannot net a win. Not worth an iteration. |
| H10 | cache clear() fixpoint (prelim-action pruning): snapshot wave/compat/sums/ent/obs post-bans+initial-prop; restore .set() on reuse | 2 (valid+det) | speed (all; clear 8-12%) + success (N seeds) | KEPT | subprof clear 7.7-11% (0.26-0.46ms); medians opt: knots 1.993→1.799 / circ 4.896→4.479 / rooms 2.248→1.950 ms (5.51→5.93x /1.55→1.61x /1.55→1.71x); mem +426kB knots-48 (acceptable); success 95% unch; VALID+DET (compare* FAIL from H4); see log |
| H11 | bitpacked wave (1 bit/pattern) + narrow compatible | 1 (byte-id) | memory | REJECTED | wave-bitpack HURTS hot-path access (bit ops vs byte reads) — rejected on SPEED grounds (speed > memory). The compatible-narrowing sub-part landed as H23 (KEPT cache-SPEED win). |
| H12 | restart-with-derived-seeds on contradiction (no undo stack) | 2 (valid+det; new contract: seed+budget) | success-rate | KEPT | 95%→100% on knots-dense-24 (N=100); deriveRestartSeed(base,k) pure mulberry-mix; speed flat (within noise) on knots-48/circuit/rooms; mem unchanged; VALID+DET (new contract); see log |
| H13 | CDCL-style conflict learning across restarts (learn forbidden collapse-combos, forbid next restart) | 2 (valid+det) | success-rate (big swing) | REJECTED | STEP1: H12 already 100% + median att=0 on harder 48/64 cases (knots-dense-48/64, circuit-48); no target for CDCL (see log). Pivot to speed ideation on prop wall. |
| H14 | one-step look-ahead selection (forward-checking-lite; pick collapse minimizing threatened cells) | 2 (valid+det) | success-rate | REJECTED | success axis already maxed — H12 gets 100% on committed AND harder/larger inputs (H13 stress investigation: knots-dense-48/64, circuit-48 all 100% first-try); no measurable target for a success candidate. |
| H15 | watched-literal propagation (full AC-4 counts → single watched witness + fixed-pool dll watchers) | 2 (valid+det) | speed (circuit/rooms prop wall) | REVERTED | no win (regressed 5-23% on all; list mgmt+rescans > saved decrements); see log |
| H16 | steppable/cancelable run loop (generator yielding every N observes) | 1 (byte-id, same output) | web-ecosystem / robustness | KEPT | *stepRun(seed,limit,budget,yieldEvery=1,signal?) generator yields {done,observedCell,attempt,cellsResolved,ok?,complete?}; run() direct loop unchanged (dupe logic in gen); cancel via break/return/abort; same outputs+VALID+DET+speed (no reg); step check (551 yields+final, cs match, cancel ok) on knots-24. See log. |
| H17 | threat-first / annealed selection (resolve most-threatened cell first, or anneal acceptance) | 2 (valid+det) | success-rate | REJECTED | same as H14 — success axis maxed (H12); no measurable target. |
| H18 | sparse live-set wave for restrictive tilesets (adaptive dense/sparse per tileset) | 1 (byte-id) | memory + speed | REJECTED | STEP1: post-init live=100% of T (avg/med/max=T) on knots/circuit/rooms (0 init bans even for nonper rooms); observe-time live ~9-26% of T; wave slice 3.2-4.1% of fp (651/1020/633 KB total); maxLive=T at layout time → no mem win possible (stride=T + overhead); observe ~4% only so speed marginal at best. Mem lowest prio → REJECT (no code landed). See log. |
| H19 | arena recycling (reuse collapsed-cell wave space for active watch/undo buffers) | 2 | memory (bounded under backtracking) | REJECTED | no backtracking landed (H13 rejected; H12 is restart-based, no undo stack) → arena recycling has no target. |
| H20 | multi-resolution / nested-doll WFC (coarsen 2x2→1 macro-cell, then refine) | 2 | memory + speed (huge grids) | REJECTED | huge-grids-only — no benefit on the committed 24-48 grids (coarsening a 24x24 to 12x12 barely reduces work) + needs macro-tileset preprocessing + changes outputs. Future stretch for 256x+ grids (like H21 WebGPU). Not this round. |
| H21 | WebGPU propagation acceleration (optional path; portable JS fallback mandatory) | 2 | speed | REJECTED | REJECTED for committed benchmark (small 24-48 grids; seq. dep. cascade + dispatch/launch overheads dominate CPU 3.5ms path; cannot measure w/o native adapter setup in Bun/Node harness). Future stretch: parallel cellular relaxation for large-grid (256x+) *throughput*. See log. Plain-JS path untouched. |
| H22 | MRV selection (sumsOfOnes) instead of entropy — eliminate the per-ban Math.log recompute entirely | 2 (valid+det) | speed (ban entropy cost ~8-12%) | KEPT | default MRV (from Entropy); ban() entropy work (sums+Math.log) now guarded `if (Entropy)`. Tier-2 (select order changes); knots 1.725→1.695ms (no reg), circuit 4.032→3.650ms (+9.5%), rooms 1.885→1.784ms (+5%); dense success 100%→100%; mem ~unchanged; VALID+DET; See log. |
| H23 | compatible Int32 → Uint8 (counts are ≤T<256 for our tilesets, exact — no cap) | 1 (byte-id) | speed (propagation decrement loop — the 60-66% wall, via 4x cache reduction) | KEPT | Uint8 (maxPropLen=5/14/8 for knots/circuit/rooms); knots 1.791→1.728ms (no reg), circuit 4.358→4.037ms (+7.4%), rooms 1.965→1.898ms (+3.4%); mem -498kB/-1.0MB/-604kB; VALID+DET (byte-id); Tier-1 cache win on wall. See log. |
| H24 | fast-log bitcast approximation (replace Math.log with bitcast log2 ~5-10x faster) | 2 (valid+det) | speed (ban entropy cost) | REJECTED | subsumed by H22 — MRV eliminates the per-ban Math.log ENTIRELY for the default path; fast-log only matters for the now-unused Entropy path. Strictly worse than H22 (approx vs elimination). |
| H25 | spatially-biased selection (among min-entropy cells, pick nearest last-collapsed) | 2 (valid+det) | speed (propagation cache locality) | REJECTED | STEP1: already highly clustered (circuit avgManh consecutive-obs=4.24 vs ~23 random; rooms=3.02 vs~20). Heap+MRV does local nucleation naturally; no headroom. Even clean window-bias impl (b) tightens cluster but regresses speed (no cache win). See log. |
| H26 | propData Int32→Uint8 (t2 ids are ≤T<256, exact) + propLen Uint8 + propStart Uint16 | 1 (byte-id) | speed (propagation inner loop — the wall, via 4x cache on propData read) | KEPT | Uint8 (propData/propLen), Uint16 (propStart) for T=9/36/28 + totals<2k; knots 1.688→1.537ms (no reg), circuit 3.949→3.421ms (+13%), rooms 1.810→1.716ms (+5%); mem deltas -0.7/-4.8/-1.9 KB (prop shrink); VALID+DET (byte-id); Tier-1 cache win on inner-loop read. See log. |
| H27 | stackT Int32→Uint8 (pattern ids ≤T<256) + stackI Int32→Uint16 (cell ids ≤count<65536) + dirty Uint16 | 1 (byte-id) | memory (stack family ~3x smaller) + marginal speed | KEPT | Uint8/Uint16/Uint16 (all inputs); knots 1.489→1.479ms (flat), circuit 2.953→3.004ms (noise), rooms 1.587→1.645ms (noise); mem 650k→505k /1015k→724k /631k→455k (-145/-291/-176 kB); VALID+DET; Tier-1 byte-id. See log. |
| H28 | sumsOfOnes Int32→Uint8 (live count ≤T<256) + sumsOfOnes0 cache | 1 (byte-id) | memory (tiny) + marginal speed (heap reads) | KEPT | Uint8 for all (T=9/36/28<256); knots 1.475→1.486ms (noise), circ 2.963→2.900ms (noise), rooms 1.606→1.596ms (noise); mem -13.8kB/-6.9kB/-5.4kB (sums+s0); VALID+DET byte-id; completes ideation-2 narrowing (H23/26/27/28). See log. |
| H29 | drop dead entropy arrays (entropies/sumsOfW*/weightLogW + *0 snaps) under MRV (default) | 1 (byte-id under MRV) | memory + micro clear | KEPT | ~55KB drop (circuit 731→675 KB); knots/rooms also down; speed flat or tiny gain (less clear); success 100% unch; Entropy smoke ok+valid; VALID+DET. Free mem win + MRV cleanup complete. See iter-18 log. |
| H30 | MRV bucket priority queue (buckets[1..T] exploiting tiny integer range) replacing f64 heap for default | 2 (valid+det) | speed (knots nextUnobs 22% secondary) | KEPT | first-principles on MRV (sumsOfOnes int keys); Dial buckets + dll + min-i tiebreak for exact heap-MRV match. knots 1.337→1.045ms (1.28x), circ 2.628→2.550, rooms 1.390→1.240 (+12%); mem -9kB/-4.5kB/-3.5kB; VALID+DET, byte-id vs post-H31 (Tier-1 for selection); See log. |
| H31 | precomputed neighbor table (removes per-iter wrap/edge/mul from propagate outer loop — the 85%+ wall) | 1 (byte-id) | speed (prop wall) | KEPT | Int32Array(count*4) w/ -1 sentinel (built once in init); knots 1.481→1.343ms (no reg), circuit 3.284→2.634 (+20%), rooms 1.680→1.395 (+17%); mem +37/+18.5/+14.4 kB; VALID+DET (Tier-1 byte-id); clear untouched (~1%). See log. |
| H33 | elide gen-wrap reset in flushHeapUpdates (gen collision impossible in practice) | 1 (byte-id micro) | speed (flush ~4-8% of now-visible next) | REVERTED | below noise (no measurable win); guard kept for safety (predictable never-taken branch per flush). See log. |
| H34 | propagator-CSR dedup (share propData slices for identical (d,t1) lists from tile symmetry) | 1 (byte-id) | memory (propData) + micro inner-read cache | REJECTED | instrumentation (ideation-4 pass): knots 36 slots → 8 unique (maxDup=5, 78% sharing), circuit 144 → 79 (65 dups), rooms 112 → 61 (maxDup=16). Real structural dups from symmetry. But prop* total bytes tiny post H26 (0.27/1.79/0.79 KB); 45% dedup saves <1KB vs 400-659 KB working set. Inner propData read already L1 (short lists + H31 locality). Speed win < noise. Marginal like H9/H33. See log for full dup+size data + TRIZ/FP assessment. |
| H35 | observed Int32Array(count) → Uint8 (T<256 ids; sentinel for -1) | 1 (byte-id) | memory (cold) | REJECTED | observed written only at end (run/stepRun success path) + returned by result(); never read in propagate/observe/ban/next/flush. Excluded from footprint gate. Saves ~3-4 KB (circuit 4.6 KB → 1.1 KB). No hot-path impact. Below noise on all axes. Future 4c polish only. |
| H36 | compatible transpose to d-major (inner t2 stride-1 within dir's t slice vs current t*4 + d stride-4) | 1 (byte-id) | speed (prop inner decrement loop, 85%+ wall) | REJECTED | post H23 (bpe=1) + H31 (neighbor table): iter-15 profile wall is decr. Instrumentation (ideation-4): cell block T4bytes 36/144/112; avg t2-span under load 31/100/61.5 B (knots 100% lists ≤ 64 B, circuit only 17% ≤ 64 B /67% ≤ 128 B, rooms 54%/100%). Touched per list avg 4.5/9.4/4 B. With H31 spatial clustering, short fanout lists already resident in 1-3 cachelines. Stride-4 predictable; transpose would stride-1 inner but strided writes in ban() + changes all sites (clear, H10, init). History (H5/H15/H33 reverts) shows added complexity in prop path nets ≤ noise or regress. No >5-10% plausible. |
| H37 | dirty-cell + bitset support propagation (AC-3-ish domain filtering) | 2 (valid+det; algorithm rewrite) | speed (propagation wall) | REJECTED | Script-local `scripts/cpu-bitset-propagation-proto.ts` matched current AC-4 final waves (`diffs=0`) but lost on target propagation: circuit core `0.0801ms` vs AC-4 `0.0380ms`, rooms `0.0310ms` vs `0.0126ms`, knots too tiny. It scans live neighbor tiles / seeds masks while current AC-4 frontier touches short CSR lists. Do not promote. |
| H38 | cell-batched AC-4 propagation | 2 (valid+det; algorithm rewrite) | speed (propagation wall) | REJECTED | Script-local `scripts/cpu-batched-ac4-proto.ts` matched current AC-4 final waves (`diffs=0`) but even in-place drain lost: circuit `0.0469ms` vs stack AC-4 `0.0387ms`, rooms `0.0140ms` vs `0.0130ms`, knots `0.0021ms` vs `0.0016ms`. Pending-bit/queue/tile-buffer bookkeeping outweighed saved neighbor/base setup. |
| H39 | generated/specialized hot propagation kernel per model shape | 1/2 (implementation specialization; should preserve algorithm) | speed (prop + observe overhead) | TODO | Bake `T`, `T4`, array kinds, and hot-loop structure for a concrete model to reduce generic property/union polymorphism. Try only after algorithmic propagation candidates unless profiling points here. |
| H40 | propagation work ordering experiments (FIFO/spatial/ring vs LIFO) | 2 (valid+det; ordering changes) | speed (cache locality) | TODO | Measure whether queue order improves locality without changing fixpoint validity. Expected payoff lower than changing unit-of-work; keep as final Round 4 candidate. |

H3 (index-ordered active-cell bitset to trim the scan) is **deliberately skipped**:
H4's heap replaces the scan entirely, so H3 would be throwaway work.

**Re-profile before picking** (the reference profile in `scripts/profile.ts` is
stale post-H4 — the scan it shows is gone). Instrument `src-optimized/model.ts`
with per-phase timers (heap extract / nextUnobservedNode, observe, propagate, ban+heap-update, clear) — *temporarily only* — run on the three inputs (few reps, median), capture distribution, then `git checkout --` revert before any commit. (See iter-15 in OPTIMIZATION-LOG.md + src-optimized/README Round-3 narrative.) Add fresh candidates from the profile + ideation pass (TRIZ + first-principles).

## Stealable techniques (from references/three-wfc and references/fast-wfc)

- fast-wfc (C++): precomputed propagator table `[d][t1]→allowed`, AC-4 support
  counts that decrement on ban, incremental entropy memo (`plogp` sums). H1
  already did the flat support counts; H2 does the flat propagator table.
- three-wfc (TS, 2025): typed arrays everywhere, **min-heap with key→pos map for
  O(log n) extract-min + decrease-key**, dedup propagation stack, zero allocation
  in the hot path. Read `references/three-wfc/lib/WFCMinHeap.ts` before H4 — it's
  the exact heap pattern to port (note: in lib/ not src/). Its tie-breaking is
  deterministic by cell index (no per-cell PRNG noise), which is valid+det for us.
  H4 ported the heap; future candidates may steal the dedup stack or zero-alloc.

## Speedup target

**Round 1 target (H1–H4): MET + surpassed.** knots-standard-48 ≥3x → ~6.6x;
circuit ≥1.4x → 1.66x; rooms ≥1.5x → 1.71x. All VALID+DET. External comparison
(benchmarks/external/RESULTS.md) confirms we beat every comparable implementation
including three-wfc (1.20–5.59x apples-to-apples).

**Round 2 target (H5+, this round): push propagation headroom.** The scan is
gone (H4); propagation is now the dominant cost on every input. No external bar
remains to chase (we already beat three-wfc/blazin/kchapelier), so this is pure
self-improvement. Soft target (set/raised after the first H5 measurement,
grounded in an optimized re-profile): **circuit-turnless-34 and rooms-30 each
≥2.5x vs the reference**, while holding knots-48 (no regression) and keeping
VALID+DET. The real stop is exhaustion: re-profile the optimized each stall and
stop when no high-payoff candidate remains.

Additional exit authority (from the user): stop when, after re-profiling, no
high-payoff optimization remains, OR we surpass all known external benchmarks
(already done — see RESULTS.md).

## Exit criteria (the orchestrator checks each loop turn)

Stop the loop when EITHER:
- the target above is reached on all three meaningful inputs with VALID+DET
  passing; or
- every candidate in the list is marked KEPT / REVERTED / REJECTED (nothing left
  untried, and re-profiling shows no high-payoff new candidate).

## Round 2 conclusion (H5+ propagation-push) — STOPPED at exhaustion

Tried 4 hypotheses this round; **1 KEPT (H6), 3 REVERTED (H5/H7/H8), 1 REJECTED
(H9)**. Final optimized vs reference (prove-harness, VALID+DET): knots-48 6.45x
(1.62ms), circuit 1.73x (4.32ms), rooms 1.70x (1.88ms) — up from the Round 1 end
state (6.3x / 1.66x / 1.71x) on the back of H6 alone.

The 2.5x soft target on circuit/rooms was NOT reached and is not reachable by
ratcheting the current algorithm: the Round 2 baseline profile (fresh this round)
shows propagation at 60-66% of the optimized time, and H5 empirically proved the
propagation decrement loop cannot be trimmed with guards (the branch+load
overhead exceeds the skipped work because the common case has live compatible
patterns). H7 showed observe O(T) is already fast at T=9/36. H8's ban sub-profile
found entropy/plogp (Math.log) is the biggest ban sub-cost, but deferring it to
the H6 flush nets no win (the work moves without coalescing). H9 is a sub-micro
of the already-failed H7 lever.

**The wall is propagation, and it's algorithmic, not micro-architectural.** The
decrement loop is already flat CSR with AC-4 support counts — close to optimal
for the simple-tiled-model propagation algorithm. A further circuit/rooms win
would require a different propagation algorithm (out of scope for the ratchet,
which optimizes the existing algorithm; a new algorithm is a separate project).
Loop paused on exhaustion after H28 (narrowing complete); iter-15 re-profile + ideation-3 minted 4 fresh (H29–H31/H33). H31 KEPT iter-16; H30 KEPT iter-17; H29 KEPT iter-18 (mem win, completes MRV cleanup); H33 REVERTED iter-19. Iteration 20 (ideation-4) rigorously assessed remaining angles (propagator dedup from symmetry data, compatible transpose from stride spans, observed narrow, + TRIZ/FP/Biomimicry angles on AC-4 wall) — minted only REJECTEDs (H34/H35/H36). Real stop only when ideation yields nothing worth trying (genuine exhaustion confirmed).

## Round 4 — CPU algorithm-level propagation ratchet — REOPENED

The user reopened the CPU ratchet after GPU exhaustion to test loop-rethinking candidates. This round is not another micro-layout pass. The current AC-4 typed-array solver is the shippable baseline; each high-risk algorithmic candidate should first land as a script-local prototype or isolated optional implementation that proves VALID+DET and speed against the current optimized solver before touching the main `Model` hot path.

Candidate order: H37 dirty-cell bitset propagation, H38 cell-batched AC-4, H39 generated/specialized kernels, H40 propagation ordering. Stop only after these are measured and a fresh ideation pass yields no higher-payoff CPU path.

## Round 3 — "best WFC in the world" (multi-axis, TRIZ-derived) — CONCLUDED at genuine exhaustion

**Round 3 DONE (~20 iterations, 11 KEPT).** Final: knots-48 11.5x, circuit 2.77x, rooms 3.22x (MET 3x);
success 100%; memory -47% (circuit 1244KB→659KB); steppable/cancelable run loop (H16). Ideation pass 4
rigorously confirmed no >5-10% candidate remains (H34/H35/H36 data-grounded marginal). The AC-4
propagation inner decrement loop is the irreducible wall in plain JS (alg rewrites H5/H15 reverted;
cache/neighbor/selection all optimized). See OPTIMIZATION-LOG.md Round 3 conclusion. Next: Phase 4c
open-source finish (visualizer, learning guide, README).

**Priority: SPEED > success-rate > memory.** Memory is least important; we
ACCEPT more memory for faster performance. A memory-only win that costs speed
is REVERTED. A speed win that costs memory is KEPT.

**Hard constraints:**
- Plain JS/TS ONLY — no WASM, no native addons. (WebGPU is allowed as an
  OPTIONAL acceleration path, but a portable plain-JS fallback MUST stay working
  in both Node and browser. The solver core stays Node+browser-portable: no
  Node-only APIs in the hot path.)
- Typed arrays / ArrayBuffers encouraged. Workers only if isomorphic across
  Node+browser (default single-threaded).
- Gate stays VALID+DET (or, for success-rate candidates that change the run
  contract, the new deterministic contract: same (seed, budget) -> same output).
- Never edit src/ / harness/ / test/ / performance-test/inputs/.

**New gate tools (trusted, in harness/):**
- `bun run harness/success-rate.ts <input> [N=100]` — completion rate over N
  seeds, ref vs opt. The success-axis gate. (Baseline finding: on knots-dense-24
  N=50, opt completes 92% vs ref 46% — the H4 heap order is already far more
  robust than mxgmn's scan+noise.)
- `bun run harness/memory.ts [input]` — optimized typed-array footprint bytes.
  The memory-axis gate (informational given memory is lowest priority).
- `bun run harness/measure-speedup.ts <input> 5` — speed (primary axis).
- `bun run harness/prove-harness.ts` — VALID+DET (mandatory, always).

**Keep criteria by axis (priority speed > success > memory):**
- SPEED candidate: KEEP iff VALID+DET + faster (above noise) on target input(s) +
  knots-48 does not regress. Memory growth is ACCEPTABLE (not a reject reason).
- SUCCESS candidate: KEEP iff (new contract det) + completion rate up on the
  hard input(s) + speed does not regress meaningfully (speed outranks success:
  don't tank speed for success). Measure via success-rate.ts.
- MEMORY candidate: KEEP iff VALID+DET + footprint down + NO speed regression.
  Lowest priority; only pursue if free or speed-neutral (e.g. narrowing
  `compatible` may help cache -> speed-neutral-or-better; bitpacking `wave` to
  1 bit likely HURTS hot-path access -> reject on speed grounds).

**Recommended attack order (by priority, not by H-number):**
1. H10 preliminary-action pruning — KEPT (circuit/rooms -9/-13%).
2. H15 watched-literal propagation — REVERTED (list overhead > AC-4 savings).
3. H12 restart-with-derived-seeds — KEPT (100% on dense+harder cases w/ ~0 retries); success axis MET. (H13 CDCL rejected: no target on harder cases.)
4. H14/H17 success refinements — REJECTED (success axis maxed, no target).
5. **H23 compatible→Uint8 — KEPT** (cache win: circuit +7%, rooms +3.4%, knots held; all Uint8; VALID+DET byte-id).
6. **H26 propData/ propLen/Start narrow — KEPT** (H23 angle on inner prop read: Uint8/Uint8/Uint16; circuit +13%, rooms +5%, knots held; mem win; VALID+DET byte-id).
7. **H22 MRV selection — KEPT** (elim per-ban Math.log via MRV default+guard; circuit +9.5%, rooms +5%, knots held; VALID+DET).
8. H24 fast-log approx — REJECTED (subsumed by H22). H25 spatial — REJECTED after STEP1 (already clustered; see log).
9. **H16 steppable/cancelable run — KEPT** (the web differentiator: *stepRun yields every N, AbortSignal or natural cancel, portable; run() verbatim fast path no-reg; same outputs; no other JS WFC offers step+cancel).
10. H21 WebGPU — stretch speed path (now that H24/H25 rejected).
11. Memory candidates (H18 sparse, H20 multi-res) — last; only if speed-neutral-or-better. H18 REJECTED after STEP1 (live=T at init on committed inputs; wave ~3-4% of fp; no mem win possible). H20 stretch. (H11/H19 REJECTED earlier.)

**Round 3 target:** push circuit-turnless-34 and rooms-30 speedup vs reference
well past the Round 2 wall (1.7x) toward >=3x via the algorithmic levers (H10/H15),
AND (H12 achieved dense 95%→100%). H13 rejected after investigation (H12 already 100% on harder cases with ~0 retries).
The remaining axis is SPEED on circuit/rooms prop wall (H5/H8/H15 reverted). The real stop is idea exhaustion: an
ideation pass (see optimize-one.md STALL->IDEATE) yields no new high-payoff
candidate. Minimum ~25 iterations or until exhausted.

**Post-H13 (this iteration):** STEP1 stress (knots-dense-48/64, circuit-48, N=30-50) showed H12
completes 100% with median attempts=0 (max=1). CDCL has no target. Per task instruction:
REJECT without impl; pivot recommendation to SPEED ideation on propagation (the unmet axis).

**Post-H23 (this iteration):** H23 (cache-narrow compatible) KEPT. All our tilesets auto-selected
Uint8Array (maxPropLen 5/14/8 <<256). Speed: circuit 4.358→4.037ms (+7.4% on the wall),
rooms +3.4%, knots no-reg (slight gain). Mem shrinks ~half for large inputs (compat+0 is
now 1B/entry vs 4B). VALID+DET + byte-id (Tier-1). First cache-layout win on prop wall.

**Post-H22 (this iteration):** H22 (MRV) KEPT. Switched default to MRV + guarded the entropy sums+Math.log
recompute in ban() (skipped when heuristic != Entropy). Speed win on ban path: circuit 4.032→3.650ms
(+9.5%), rooms 1.885→1.784ms (+5.4%), knots 1.725→1.695 (no reg, slight gain). Success 100% dense
unchanged (H12 covers). Mem neutral (left H10 snapshots as-is). VALID+DET. Tier-2 (order change).
Now propagation remains the wall; H24 (subsumed) + H25 (already-clustered, no headroom) rejected after investigation+exp. Round 3 speed target still open (circuit/rooms ~1.9-2.1x). Pivot to H16 or H21 or final ideation.

**Post-H16 (this iteration):** H16 steppable/cancelable run loop KEPT as the "best on web" differentiator. Added *stepRun(seed, limit, restartBudget=100, yieldEvery=1, signal?:AbortSignal) : Generator<StepStatus> which mirrors run() logic exactly (dupe for hot-path purity) and yields {done:false, observedCell, attempt, cellsResolved} per N observes + final {done:true,ok,complete}. run() left verbatim as direct loop (generator drain regressed ~2x, switched to (a)). Verified: same outputs (cs match), VALID+DET, step check (knots-24: 551 observes+final done, yields correct, cancel+abort clean), speed no-reg (knots 6.3x/1.63ms, circ~1.88x/3.59ms, rooms~2.22x/1.78ms within noise), success 100%, mem unch. No other JS WFC has this. Portable plain TS. See log.

**Post-H26 (this iteration):** H26 (propData+propLen+propStart cache-narrow) KEPT. Mirrored H23 auto-select: propData Uint8 (ids<T<256 exact), propLen Uint8, propStart Uint16 (offsets<64k on committed). Directly shrinks the inner-loop read `t2=propData[start+l]` (60-66% wall). Speed (paired med5): knots 1.688→1.537ms (no reg ~9% win), circuit 3.949→3.421ms (+13% /0.53ms), rooms 1.810→1.716ms (+5%/0.09ms). Mem win bonus: -672B / -4.8kB / -1.9kB (matches 3B+3B+2B per entry * counts). Auto-type Uint8/Uint8/Uint16 for all three inputs. VALID+DET, Tier-1 byte-id (no arith on propData). See log. Next: H27/H28 or re-profile to see if prop wall % dropped.

**Post-H27 (this iteration):** H27 (stack + dirty cache-narrow) KEPT. Mirrored auto-select: stackT Uint8 (by T), stackI+dirtyHeapCells Uint16 (by count<64k). Stack+dirty family ~3× smaller bytes (was big ~33% slice). Speed within noise on paired med5 (knots 1.489→1.479ms flat/gain, circ 2.953→3.004ms ~+1.7% noise, rooms 1.587→1.645ms ~+3.6% noise); mem win 650k→505k / 1015k→724k / 631k→455k (-145k/-291k/-176kB). VALID+DET Tier-1 (stack empty at H10 snap, scalars ok). Next: H28 or re-profile + ideation-4 (this pass).

**Post-H28 (prior):** H28 completed ideation-2 narrowing. **Iter 15 (this):** RE-PROFILE (see log for per-phase %: prop now 56/87/85% on knots/circuit/rooms; next 22% on knots; clear <2%; heap-extract low) + ideation-3 (TRIZ+first-principles) minted H29 (dead entropy drop under MRV) + H30 (MRV buckets) + H31 (precomp neighbors) + H33 (flush micro). **Iter 16:** H31 KEPT. **Iter 17:** H30 KEPT. **Iter 18:** H29 KEPT. **Iter 19:** H33 REVERTED (below noise). **Iter 20 (this):** ideation-4 (TRIZ for param conflict speed-vs-correctness + first-principles questioning AC-4/stride assumptions + biomimicry) + fresh instrumentation on propagator dups + compatible t2 spans. Current (post-H29/H30/H31): knots ~0.86-1.4 ms (~7.6-11×), circuit ~2.38-2.61 ms (~2.56-2.92×), rooms ~0.87-1.36 ms (~2.4-3.2×) (machine variance; VALID+DET 100% dense+harder); mem circuit 659 KB (−47%). Candidate list now contains only REJECTED from this pass (H34 dedup, H35 observed narrow, H36 transpose); no TODO. See below + log for recommendation: genuine exhaustion.

**Post-H33 (prior):** H33 (micro) REVERTED honestly (within noise). **Iter 20 (this):** IDEATION PASS 4 — candidate list empty. Applied creative-ideation (TRIZ + first-principles + biomimicry) to wall evidence (iter-15 profile: prop 85-87% circuit/rooms; history of H5/H15/H8 reverts proving AC-4 trim/rewrite overhead > savings in JS; H23/H26/H31 cache+precomp wins already applied). Temporarily instrumented *only* src-optimized/model.ts (reverted pre-commit; git clean), ran on committed tilesets: propagator dup data + compatible stride/span stats. Minted 3 fresh candidates (H34 dedup, H35 observed, H36 d-transpose) — all classified MARGINAL/REJECTED with numbers (see table + log). No HIGH-PAYOFF (>5-10% plausible on speed priority) surfaced. Other angles (bitset reformulation, drop wave under MRV, fuse sums/wave, etc.) either contradict invariants, duplicate prior reverts, or affect <1% of cycles. **Recommendation: genuine exhaustion — conclude Round 3.** No further iterations; proceed to Phase 4c (visualizer, guide, OSS polish). See full writeup in OPTIMIZATION-LOG.md.

## Exit criteria (the orchestrator checks each loop turn)

Stop the loop when EITHER:
- the Round 3 target is met on all axes (circuit/rooms >=3x, dense completion
  >=99%, knots-48 held, VALID+DET) and further gains look marginal; or
- every candidate is KEPT/REVERTED/REJECTED AND a fresh ideation pass
  (optimize-one.md STALL->IDEATE) yields no new high-payoff candidate. This is
  the real stop: not "filing stalled" (that triggers ideation), but "ideation
  itself yields nothing worth building."
# src-optimized — Optimization Plan + Candidate List

The optimized WFC solver. Starts from the reference (`src/`) and is optimized
under the Mike Acton ratchet. Each iteration is run by a subagent following
`prompts/optimize-one.md`; this file is the shared state the subagent reads and
updates. The orchestrating `loop_control` decides stop/continue from the exit
criteria at the bottom.

## Reference baseline (measured, median-of-5, this machine: macOS arm64 Bun 1.3)

| input | ref median |
|-------|-----------|
| knots-standard-48 (T=9, 48×48) | 10.43 ms |
| circuit-turnless-34 (T=36, 34×34) | 7.23 ms |
| rooms-30 (T=28, 30×30) | 3.14 ms |

## Profile (where the cycles go) — `bun run scripts/profile.ts`

Two regimes:

| input | T | dominant | share |
|-------|---|----------|------|
| knots-standard-48 | 9 | **entropy scan** (nextUnobservedNode) | 83.6% — O(cells²) full scan per step |
| circuit-turnless-34 | 36 | **propagation** (compatible-decrement loop) | 66.5% |
| rooms-30 | 28 | **propagation** | 78.2% |

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
| H20 | multi-resolution / nested-doll WFC (coarsen 2x2→1 macro-cell, then refine) | 2 | memory + speed (huge grids) | TODO | stretch; needs macro-tileset preprocessing; changes outputs. |
| H21 | WebGPU propagation acceleration (optional path; portable JS fallback mandatory) | 2 | speed | REJECTED | REJECTED for committed benchmark (small 24-48 grids; seq. dep. cascade + dispatch/launch overheads dominate CPU 3.5ms path; cannot measure w/o native adapter setup in Bun/Node harness). Future stretch: parallel cellular relaxation for large-grid (256x+) *throughput*. See log. Plain-JS path untouched. |
| H22 | MRV selection (sumsOfOnes) instead of entropy — eliminate the per-ban Math.log recompute entirely | 2 (valid+det) | speed (ban entropy cost ~8-12%) | KEPT | default MRV (from Entropy); ban() entropy work (sums+Math.log) now guarded `if (Entropy)`. Tier-2 (select order changes); knots 1.725→1.695ms (no reg), circuit 4.032→3.650ms (+9.5%), rooms 1.885→1.784ms (+5%); dense success 100%→100%; mem ~unchanged; VALID+DET; See log. |
| H23 | compatible Int32 → Uint8 (counts are ≤T<256 for our tilesets, exact — no cap) | 1 (byte-id) | speed (propagation decrement loop — the 60-66% wall, via 4x cache reduction) | KEPT | Uint8 (maxPropLen=5/14/8 for knots/circuit/rooms); knots 1.791→1.728ms (no reg), circuit 4.358→4.037ms (+7.4%), rooms 1.965→1.898ms (+3.4%); mem -498kB/-1.0MB/-604kB; VALID+DET (byte-id); Tier-1 cache win on wall. See log. |
| H24 | fast-log bitcast approximation (replace Math.log with bitcast log2 ~5-10x faster) | 2 (valid+det) | speed (ban entropy cost) | REJECTED | subsumed by H22 — MRV eliminates the per-ban Math.log ENTIRELY for the default path; fast-log only matters for the now-unused Entropy path. Strictly worse than H22 (approx vs elimination). |
| H25 | spatially-biased selection (among min-entropy cells, pick nearest last-collapsed) | 2 (valid+det) | speed (propagation cache locality) | REJECTED | STEP1: already highly clustered (circuit avgManh consecutive-obs=4.24 vs ~23 random; rooms=3.02 vs~20). Heap+MRV does local nucleation naturally; no headroom. Even clean window-bias impl (b) tightens cluster but regresses speed (no cache win). See log. |

H3 (index-ordered active-cell bitset to trim the scan) is **deliberately skipped**:
H4's heap replaces the scan entirely, so H3 would be throwaway work.

**Re-profile before picking** (the reference profile in `scripts/profile.ts` is
stale post-H4 — the scan it shows is gone). Instrument `src-optimized/model.ts`
with per-phase timers (heap extract / observe / propagate / ban+heap-update) or
use `bun --cpu-profile` on `harness/run.ts optimized <input>` to rank H5/H6/H7 by
Amdahl on the *current* cost distribution. Add new candidates the new profile
reveals.

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
Loop stopped on exhaustion: every high-payoff candidate tried, fresh profiles
reveal no new high-payoff candidate.

## Round 3 — "best WFC in the world" (multi-axis, TRIZ-derived)

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
6. **H22 MRV selection — KEPT** (elim per-ban Math.log via MRV default+guard; circuit +9.5%, rooms +5%, knots held; VALID+DET).
7. H24 fast-log approx — REJECTED (subsumed by H22). H25 spatial — REJECTED after STEP1 (already clustered; see log).
8. **H16 steppable/cancelable run — KEPT** (the web differentiator: *stepRun yields every N, AbortSignal or natural cancel, portable; run() verbatim fast path no-reg; same outputs; no other JS WFC offers step+cancel).
9. H21 WebGPU — stretch speed path (now that H24/H25 rejected).
10. Memory candidates (H18 sparse, H20 multi-res) — last; only if speed-neutral-or-better. H18 REJECTED after STEP1 (live=T at init on committed inputs; wave ~3-4% of fp; no mem win possible). H20 stretch. (H11/H19 REJECTED earlier.)

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

## Exit criteria (the orchestrator checks each loop turn)

Stop the loop when EITHER:
- the Round 3 target is met on all axes (circuit/rooms >=3x, dense completion
  >=99%, knots-48 held, VALID+DET) and further gains look marginal; or
- every candidate is KEPT/REVERTED/REJECTED AND a fresh ideation pass
  (optimize-one.md STALL->IDEATE) yields no new high-payoff candidate. This is
  the real stop: not "filing stalled" (that triggers ideation), but "ideation
  itself yields nothing worth building."
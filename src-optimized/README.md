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
| H11 | bitpacked wave (1 bit/pattern) + narrow compatible (Uint16/Uint8, counts capped at 255) | 1 (byte-id, layout-only) | memory | TODO | easy memory win; wave 8x, compatible 2-4x. Guard saturation. |
| H12 | restart-with-derived-seeds on contradiction (no undo stack) | 2 (valid+det; new contract: seed+budget) | success-rate | TODO | we're fast, so N restarts beat backtracking; derived seeds keep determinism. |
| H13 | CDCL-style conflict learning across restarts (learn forbidden collapse-combos, forbid next restart) | 2 (valid+det) | success-rate (big swing) | TODO | the miniSAT engine; makes hard inputs actually solvable. Highest-leverage success idea. |
| H14 | one-step look-ahead selection (forward-checking-lite; pick collapse minimizing threatened cells) | 2 (valid+det) | success-rate | TODO | prevents immediate dead-ends, no backtracking; cost ~T/observe, hard-inputs mode. |
| H15 | phase-shifted watched literals (AC-4 counts → promote to single watched witness when support ≤2) | 2 (valid+det) | speed (circuit/rooms prop wall) | TODO | the propagation-wall win, memory-conscious (on-demand promotion). |
| H16 | steppable/cancelable run loop (generator yielding every N observes) | 1 (byte-id, same output) | web-ecosystem / robustness | TODO | no JS WFC lib does this; table-stakes for browser use + visualizer. |
| H17 | threat-first / annealed selection (resolve most-threatened cell first, or anneal acceptance) | 2 (valid+det) | success-rate | TODO | stretch; escape bad basins; needs experiment. |
| H18 | sparse live-set wave for restrictive tilesets (adaptive dense/sparse per tileset) | 1 (byte-id) | memory + speed | TODO | stretch; wins only when live ≪ T (circuit); bad for permissive (knots). |
| H19 | arena recycling (reuse collapsed-cell wave space for active watch/undo buffers) | 2 | memory (bounded under backtracking) | TODO | depends on H12/H13 landing; keeps memory bounded as run progresses. |
| H20 | multi-resolution / nested-doll WFC (coarsen 2x2→1 macro-cell, then refine) | 2 | memory + speed (huge grids) | TODO | stretch; needs macro-tileset preprocessing; changes outputs. |
| H21 | WebGPU propagation acceleration (optional path; portable JS fallback mandatory) | 2 | speed | TODO | stretch; WebGPU allowed but MUST keep plain-JS path working in Node+browser. |

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
1. H10 preliminary-action pruning — wins on ALL THREE axes, IFR-aligned, low risk.
2. H15 watched-literal propagation — the circuit/rooms speed wall (full watched
   literals, accept the extra watch-list memory since speed > memory).
3. H12 restart-with-derived-seeds, then H13 CDCL conflict learning — the
   success-rate frontier (make hard inputs actually completable).
4. H14 look-ahead / H17 threat-annealed selection — success-rate refinements.
5. H16 steppable run loop — web-ecosystem robustness (needed for "best on web").
6. H21 WebGPU — stretch speed path only if 1-5 don't reach the target.
7. Memory candidates (H11 narrow-compatible, H18 sparse, H19 arena, H20 multi-
   res) — last; only if speed-neutral-or-better.

**Round 3 target:** push circuit-turnless-34 and rooms-30 speedup vs reference
well past the Round 2 wall (1.7x) toward >=3x via the algorithmic levers (H10/H15),
AND raise knots-dense-24 completion rate (success-rate.ts) from 92% -> >=99% via
H12/H13, while holding knots-48 >=6x. The real stop is idea exhaustion: an
ideation pass (see optimize-one.md STALL->IDEATE) yields no new high-payoff
candidate. Minimum ~25 iterations or until exhausted.

## Exit criteria (the orchestrator checks each loop turn)

Stop the loop when EITHER:
- the Round 3 target is met on all axes (circuit/rooms >=3x, dense completion
  >=99%, knots-48 held, VALID+DET) and further gains look marginal; or
- every candidate is KEPT/REVERTED/REJECTED AND a fresh ideation pass
  (optimize-one.md STALL->IDEATE) yields no new high-payoff candidate. This is
  the real stop: not "filing stalled" (that triggers ideation), but "ideation
  itself yields nothing worth building."
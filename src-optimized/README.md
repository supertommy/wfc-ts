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
| H7 | observe weighted-pick is O(T) per collapse — precompute/cumsum for large T | 1 (byte-id) | observe (circuit T=36) | TODO | — |
| H8 | ban per-call overhead (sums updates + 4x compat zero + entropy + heap update/remove) for high ban volume | 2 (valid+det) | ban+heap (25-31% on circuit/rooms) | TODO | — |

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
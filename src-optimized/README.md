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
| H4 | heap-based entropy selection (O(log n) extract-min + decrease-key) | 2 (valid+det) | scan (knots-48, 83%) | TODO | — |

H3 (an index-ordered active-cell bitset to trim the scan) is **deliberately
skipped**: H4's heap replaces the scan entirely, so H3 would be throwaway work.
If H4 turns out infeasible, H3 becomes the fallback.

After H2 + H4 land, re-profile (`bun run scripts/profile.ts`) and add new
candidates the new hottest stage reveals.

## Stealable techniques (from references/three-wfc and references/fast-wfc)

- fast-wfc (C++): precomputed propagator table `[d][t1]→allowed`, AC-4 support
  counts that decrement on ban, incremental entropy memo (`plogp` sums). H1
  already did the flat support counts; H2 does the flat propagator table.
- three-wfc (TS, 2025): typed arrays everywhere, **min-heap with key→pos map for
  O(log n) extract-min + decrease-key**, dedup propagation stack, zero allocation
  in the hot path. Read `references/three-wfc/src/WFCMinHeap.ts` before H4 — it's
  the exact heap pattern to port. Its tie-breaking is deterministic by cell index
  (no per-cell PRNG noise), which is valid+det for us.

## Speedup target

Set after H1 + H2 measured (2 hypotheses), grounded in the profile. The two
regimes have different ceilings, so the target is per-input, all must hold with
VALID+DET:

- **knots-standard-48 ≥ 3x** — the scan-bound input (83% in the entropy scan).
  H1+H2 give ~1.3x here; the binding win is H4's heap taking the scan toward
  O(log n). 3x is an engineer's estimate, not a proven ceiling.
- **circuit-turnless-34 ≥ 1.4x** — propagation-bound; already met by H1+H2 (~1.4x).
  H4 may add a little from circuit's 24% scan. The bar is "hold the propagation
  gains, don't regress."
- **rooms-30 ≥ 1.5x** — propagation-bound; already met by H1+H2 (~1.6x). Hold.

So the binding target is really H4 delivering the scan win on knots-48 without
losing the propagation gains on circuit/rooms. Reached when all three bars are
met with VALID+DET passing on the committed state.

Additional exit authority (from the user): the loop may also stop when, after
re-profiling, no high-payoff optimization remains, OR the optimized surpasses
all known external benchmarks (kchapelier / blazinwfc / lite-wfc) — the latter
requires the benchmarks/external/ harness, built when the optimization is far
enough along to evaluate that bar (likely right after H4).

## Exit criteria (the orchestrator checks each loop turn)

Stop the loop when EITHER:
- the target above is reached on all three meaningful inputs with VALID+DET
  passing; or
- every candidate in the list is marked KEPT / REVERTED / REJECTED (nothing left
  untried, and re-profiling shows no high-payoff new candidate).
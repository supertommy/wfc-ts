# HANDOFF — wfc-ts ratchet optimization

**Read this first if resuming in a fresh/compacted session.** Everything needed
to continue is in files + git; this orients you. Project root:
`/Users/tommy/Documents/projects/supertommy-oss/wfc-ts`.

## What this project is

Open-source Wave Function Collapse (**simple tiled model**) in TypeScript,
optimized via the **Mike Acton ratchet technique** — a measured, evidence-grounded
loop where each optimization iteration is a subagent, gated by a proof harness
the model cannot talk its way around. Two goals: a real optimized solver + a
reproducible case study (like macton/differentiable-collisions-optc).

## Where we are (Phases 0–4a DONE)

- **Phase 0–1**: scaffold + faithful TS port of mxgmn's SimpleTiledModel as
  `src/` (the correctness anchor + speedup baseline). Verified valid + deterministic.
- **Phase 2**: proof harness in `harness/` — `prove-harness.ts` gates on
  **VALID + DET** (valid+complete tiling; deterministic run-twice). `compare.ts`
  (byte-match to reference) is **informational, not a gate**. Proven vs identity
  copy in `HARNESS-BASELINE.md`.
- **Phase 3**: ratchet loop ran 3 hypotheses (all KEPT, see `OPTIMIZATION-LOG.md`):
  - H1 flatten wave/compatible → typed arrays (SoA)
  - H2 flatten propagator → flat CSR typed arrays
  - H4 heap-based entropy selection (O(log n); Tier-2, changes collapse sequence,
    gated valid+det — `compare*` reads FAIL and that's expected)
  - (H3 skipped as throwaway — H4's heap replaces the scan.)
- **Phase 4a**: external head-to-head in `benchmarks/external/RESULTS.md`. **We
  are the fastest on every input where comparison is possible**, including
  three-wfc (the 2025 optimized TS solver using the SAME heap technique): 1.20–
  5.59× faster apples-to-apples (both non-periodic, Knots). vs kchapelier
  2.28–9.96×; vs blazinwfc 1.94–11.89× (Dense: blazin times out, we 0.32ms).
  Circuit/Rooms only comparable via kchapelier (three-wfc/blazin/lite can't
  express those mxgmn tilesets — honest N/A, format limits).

## Current measured state (this machine, macOS arm64 Bun 1.3, median-of-5)

Optimized vs reference: knots-standard-48 **6.3×** (1.68ms), circuit-turnless-34
**1.66×** (4.39ms), rooms-30 **1.71×** (1.80ms). All VALID+DET.

## NEXT: Phase 4c — open-source finish (Round 3 ratchet CONCLUDED at genuine exhaustion)

Round 3 (~20 iterations, 11 KEPT: H10/H12/H16/H22/H23/H26/H27/H28/H29/H30/H31) is DONE. Final
optimized vs reference (VALID+DET): knots-48 11.5x, circuit 2.77x, rooms 3.22x (MET 3x); success 100%
on committed + harder/larger inputs; memory circuit 1244KB→659KB (-47%); steppable/cancelable run
loop (H16, a web differentiator). The AC-4 propagation inner decrement loop is the irreducible
plain-JS wall (alg reverts H5/H15; ideation-4 confirmed no >5-10% candidate remains). See
OPTIMIZATION-LOG.md Round 3 conclusion + src-optimized/README.md.

The optimization is complete across all three axes (speed/success/memory) + web fit. What remains
is the open-source case-study finish:
1. **Generalization check** (alternate seeds / larger grids — mandatory before any final claim).
2. **Web visualizer** (`viz/`) — uses the H16 steppable run loop to animate the collapse.
3. **Learning guide** (`docs/`) + the four `prompts/` instruction docs — the case-study artifact.
4. Final README + open-source packaging (API docs, types, examples, benchmarks/external/RESULTS.md
   refresh with the post-Round-3 numbers).

The ratchet loop is STOPPED. To resume optimization later, re-engage loop_control with the
Round 3 prompt (a fresh ideation pass would be needed — current candidates are exhausted).

## Key files (read order for a fresh session)

1. This file.
2. `src-optimized/README.md` — candidate list, target, baseline, exit criteria (the living state).
3. `OPTIMIZATION-LOG.md` — per-hypothesis measured history.
4. `prompts/optimize-one.md` — the per-iteration methodology (match contract, gate/measure/keep-revert/commit/log, hard rules).
5. `HARNESS-BASELINE.md` — the gate contract (valid+det; compare informational).
6. `benchmarks/external/RESULTS.md` — the external comparison (we win).

## Match contract (the gate)

Optimized must produce a **valid + complete** tiling and be **deterministic**
(same seed → same output, every run). It does NOT need to byte-match the
reference. `bun run harness/prove-harness.ts` enforces VALID+DET; `compare*` is
informational. Tier-1 (layout-only) stays byte-identical; Tier-2 (algorithmic,
e.g. H4) changes the sequence — `compare*` FAIL is expected, not a regression.

## Hard rules (from optimize-one.md)

Never fabricate a measurement (run the harness). One change per iteration.
Never delete/weaken a gate or test. Never edit `src/`, `harness/`, `test/`, or
`performance-test/inputs/` — only `src-optimized/` (+ `benchmarks/external/`).
Every kept gain committed before the subagent returns. Reverted hypotheses stay
in the log with measurements.

## Gotchas

- **No background jobs/monitors are running** (verified). The earlier 2h "hang"
  was a real bug (blazin's backtracking loops on Dense; fixed with a per-solver
  child-process kill timeout in `benchmarks/external/bench-child.ts`).
- **Memory tool has a persistent write-lock from another navi session** —
  couldn't capture cross-session notes there; everything is in files + git instead.
- `git config user.name/email` is set locally (tommyato) so subagent commits work.
- Reference repos cloned in `../references/` (WaveFunctionCollapse, fast-wfc,
  three-wfc, kchapelier-wfc, blazinwfc, lite-wfc) — read-only, not committed.
- Bash gotcha: `cd dir && clone A & clone B &` backgrounds `(cd dir && clone A)`
  in a subshell, so later clones inherit the wrong cwd. Don't background clones.

## Commands

- `bun run typecheck` — tsc --noEmit, strict (must stay clean).
- `bun test` — reference correctness suite.
- `bun run harness/prove-harness.ts` — the gate (VALID+DET) + speedup, all inputs.
- `bun run harness/measure-speedup.ts <input> [N]` — median-of-N ref vs opt (speed axis).
- `bun run harness/success-rate.ts <input> [N=100]` — completion rate over N seeds, ref vs opt (success axis).
- `bun run harness/memory.ts [input]` — optimized typed-array footprint bytes (memory axis).
- `bun run benchmarks/external/run.ts` — external head-to-head (~45s; child-process timeout guarded).
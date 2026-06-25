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

## NEXT: H5+ — push propagation headroom (self-improvement)

The scan is gone (H4); **propagation is now the dominant cost on every input**.
There is no external bar to chase (we already beat three-wfc/blazin/kchapelier),
so this round is pure self-improvement: push propagation until re-profiling shows
no high-payoff candidate remains.

**Resume by re-engaging the ratchet loop** (`loop_control`, after-turn, max 100),
one `worker` subagent per iteration following `prompts/optimize-one.md`. The
loop orchestration prompt is in `src-optimized/README.md` (Exit criteria section)
and was last used as `loop_control start` — re-run it. Each iteration: ground via
`bun run harness/prove-harness.ts`, check exit, pick next TODO candidate from
`src-optimized/README.md`, spawn worker, report.

**Profiling note**: `scripts/profile.ts` instruments the *reference* and is STALE
post-H4 (the scan it shows is gone). To find the optimized's current bottleneck,
instrument `src-optimized/model.ts` with per-phase timers (nextUnobservedNode/heap
extract, observe, propagate, ban+heap-update) or use `bun --cpu-profile` on
`harness/run.ts optimized <input>`.

Candidate seed for this round (in `src-optimized/README.md`): H5 dedup/skip
propagation work on already-collapsed cells + per-decrement overhead; H6 heap
decrease-key cost (many bans on large-T); H7 observe weighted-pick O(T) for
large T (circuit T=36). Re-profile to rank by Amdahl before picking.

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
- `bun run harness/measure-speedup.ts <input> [N]` — median-of-N ref vs opt.
- `bun run benchmarks/external/run.ts` — external head-to-head (~45s; child-process timeout guarded).
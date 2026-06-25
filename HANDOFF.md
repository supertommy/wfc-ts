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

## NEXT: Round 3 — "best WFC in the world" (multi-axis, TRIZ-derived)

Round 2 (H5+) hit the AC-4 propagation wall and stopped correctly. Round 3
re-frames via an **ideation stall-mode**: when filing stalls or a wall is
confirmed, the loop runs a creative-ideation pass (TRIZ / first-principles /
biomimicry) to mint frame-breaking candidates, then continues — so it no longer
halts at algorithmic walls.

**Priority: SPEED > success-rate > memory.** Memory least important; accept more
memory for speed. **Plain JS/TS only — NO WASM.** WebGPU allowed as optional
path (portable JS fallback mandatory in Node+browser). Solver core stays
Node+browser-portable.

Backlog (H10–H21, ranked by priority in `src-optimized/README.md` Round 3
section): H10 preliminary-action pruning (all 3 axes, IFR-aligned, first), H15
watched-literal propagation (the circuit/rooms speed wall), H12 restart-with-
derived-seeds + H13 CDCL conflict learning (success-rate frontier), H14/H17
look-ahead + threat-annealed selection, H16 steppable run loop (web), H21 WebGPU
(stretch), then memory candidates (H11/H18/H19/H20) last.

**New gate tools** (trusted, in harness/): `harness/success-rate.ts` (completion
rate over N seeds — success axis; baseline: opt 92% vs ref 46% on dense N=50),
`harness/memory.ts` (footprint bytes — memory axis), plus existing
`measure-speedup.ts` (speed) + `prove-harness.ts` (VALID+DET). Keep criteria are
per-axis (see optimize-one.md + README Round 3).

Target: circuit/rooms ≥3x vs ref (via H10/H15), knots-dense completion 92%→≥99%
(via H12/H13), knots-48 held ≥6x. Real stop = an ideation pass yields no new
high-payoff candidate. Minimum ~25 iterations or until exhausted.

Resume via `loop_control` (after-turn, max ~60), one `worker` subagent per
iteration following `prompts/optimize-one.md` (now with STALL→IDEATE branch).

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
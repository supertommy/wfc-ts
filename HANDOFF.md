# HANDOFF — wfc-ts optimization + GPU investigation

**Read this first if resuming in a fresh/compacted session.** Everything needed
to continue is in files + git; this orients you. Project root:
`/Users/tommy/Documents/projects/supertommy-oss/wfc-ts`.

## What this project is

Open-source Wave Function Collapse (**simple tiled model**) in TypeScript,
optimized via the **Mike Acton ratchet technique** — a measured, evidence-grounded
loop where each optimization iteration is a subagent, gated by a proof harness
the model cannot talk its way around. Two goals: a real optimized solver + a
reproducible case study (like macton/differentiable-collisions-optc).

## Where we are (Phases 0–4a DONE; Round 3 optimization concluded)

- **Phase 0–1**: scaffold + faithful TS port of mxgmn's SimpleTiledModel as
  `src/` (the correctness anchor + speedup baseline). Verified valid + deterministic.
- **Phase 2**: proof harness in `harness/` — `prove-harness.ts` gates on
  **VALID + DET** (valid+complete tiling; deterministic run-twice). `compare.ts`
  (byte-match to reference) is **informational, not a gate**. Proven vs identity
  copy in `HARNESS-BASELINE.md`.
- **Phase 3 / Round 1**: H1/H2/H4 kept: typed-array SoA wave/compatible, flat CSR
  propagator, and heap entropy selection.
- **Round 2**: propagation-push attempts mostly reverted/rejected; H6 batched heap
  updates kept. Conclusion: CPU AC-4 decrement loop already near-optimal.
- **Round 3**: ideation-driven multi-axis loop concluded at genuine exhaustion.
  Kept H10/H12/H16/H22/H23/H26/H27/H28/H29/H30/H31: clear-fixpoint cache,
  deterministic restart, steppable run loop, MRV + bucket PQ, byte-narrowing of
  hot arrays, dropped dead entropy state, and precomputed neighbor table.
- **Phase 4a**: external head-to-head in `benchmarks/external/RESULTS.md`. We beat
  every comparable JS/TS implementation tested (three-wfc, kchapelier, blazinwfc;
  some tilesets N/A because competitor formats cannot express them).

## Current measured state (this machine, macOS arm64 Bun 1.3)

Final optimized vs reference (VALID+DET): knots-standard-48 **11.5×** (0.86ms),
circuit-turnless-34 **2.77×** (2.38ms), rooms-30 **3.22×** (0.88ms). Success rate
is **100%** on committed + harder/larger inputs via H12 deterministic restarts.
Memory: circuit 1244KB → **659KB (-47%)**. Steppable/cancelable run loop exists
for web visualizer use.

## GPU investigation status (latest thread)

The pure-JS ratchet is complete, but the user challenged whether WebGPU could help by **limiting
CPU/GPU boundary crossings**. We tested that in stages:

1. `scripts/webgpu-prototype.ts`: naive parallel AC-4 propagation was correct but slower due to
   per-iteration readbacks.
2. `scripts/webgpu-prototype-v2.ts`: fused worklist propagation + one final readback crossed over
   for a **single large circuit propagation** (GPU ~2.5× at 128, ~3.1× at 256).
3. `src-optimized/webgpu/propagate-gpu.ts` + `gpu-runner.ts` + `scripts/bench-gpu-fullrun.ts`:
   hybrid CPU-observe/GPU-propagate was correct but full-run GPU lost **200–3000×** because it
   still crossed the boundary per observe (`mapAsync` count/log readbacks × ~N observes).
4. `scripts/webgpu-boundary-probe.ts` (commit `c9374de`): proved on Apple M3 Max/Dawn that many
   queued dispatches with one final readback are feasible (~67ms for 50k dispatches) and a simple
   cross-workgroup atomic barrier completed for 1–64 workgroups.
5. Throwaway full-GPU/chunked prototype (script deleted, log committed `94bd52a`): GPU owned MRV
   select + observe + propagation state and collapsed crossings to start/end. **Single observe +
   prop matched CPU exactly**, but multi-observe chaining produced deterministic, complete-looking
   but **invalid** tilings (e.g. circuit-16 had 22 illegal adjacency pairs; knots-16 had 456).

Current interpretation: the boundary-crossing idea is valid; the next blocker is **GPU algorithm /
frontier lifecycle correctness**, not raw overhead. Likely root areas: dropped worklist items,
ping-pong parity/clearing, not proving both frontier counts empty before next observe, observe bans
not all enqueued, or stale `sumsOfOnes` selection.

A KB investigation was added and committed in `tommyato-knowledge`:
`investigations/gpu-frontier-data-structures-for-wfc.md` (commit `4a7e7c0`). Key framing:
WFC propagation should be modeled as a GPU graph **frontier** problem (`advance` / `filter` /
`compute`) rather than a CPU stack. Relevant sources: NVIDIA Merrill/Garland BFS, Gunrock frontiers,
GPU Gems scan/stream-compaction, CUB `DeviceScan`/`DeviceSelect` style primitives.

## NEXT after compact

User intent: **continue fixing the GPU algorithm** by applying GPU-native frontier/worklist research.
Do not jump back to Phase 4c polish yet unless the user changes direction.

Latest post-compact progress:
- Added `scripts/debug-gpu-lockstep.ts` and logged it in `OPTIMIZATION-LOG.md`.
- It compares CPU vs GPU after every observe+propagate: full `wave`, full `sumsOfOnes`, and live-slot `compatible`.
- Deterministic lowest-t lockstep PASS on circuit 8/16 and knots 8/16.
- Parallel MRV `atomicMin` select + lowest-t observe PASS on circuit-16 and knots-16.
- Forced-random lockstep PASS on circuit-16 seed0 and knots-16 seeds 0/12345.
- GPU-owned weighted observe PASS under a true fixpoint drain.
- Root cause found: the old fixed `diameter=max(MX,MY)` propagation bound is unsafe. `circuit-turnless-16-gpu-weighted` produced a cascade still non-empty after 16 layers at step 172; draining to fixpoint took 19 layers (`...->8->4->1->0`). This explains Stage 3 invalid complete-looking outputs: it observed again before propagation reached fixpoint.
- `src-optimized/webgpu/propagate-gpu.ts` was fixed to use safe `count*T` max cascade steps with early-stop count sampling and non-drain throws.
- Atomic append, parallel MRV selection, GPU weighted observe, and sums maintenance are correct under a true fixpoint drain. The remaining GPU design problem is performance/portability of proving frontier-empty without per-observe CPU readback.

Recommended next technical step:
1. Do **not** use grid diameter as a no-readback propagation bound again. It is wrong.
2. Decide the GPU research direction:
   - correctness-first: keep per-iteration/periodic count sampling until frontier-empty (correct, but likely slow), or
   - performance-first: design a device-side convergence/indirect/persistent mechanism so the GPU proves frontier-empty before observe without CPU readback, or
   - pause GPU and return to OSS polish.
3. If continuing GPU, rebuild the chunked prototype with the fixed safe-drain invariant and measure whether any convergence strategy can beat JS.
4. Only switch to scan/compact if a real atomic-append frontier lifecycle bug is proven; current evidence says the fault was the unsafe bound.

The pure-JS solver remains the shippable path. Treat GPU as a research branch until it passes
VALID+DET on small grids and then crosses over on large heavy grids.

## Open-source finish (after GPU research pauses/concludes)

Once the GPU investigation is paused or resolved, remaining Phase 4c work:
1. **Generalization check** (alternate seeds / larger grids — mandatory before any final claim).
2. **Web visualizer** (`viz/`) — uses the H16 steppable run loop to animate the collapse.
3. **Learning guide** (`docs/`) + the four `prompts/` instruction docs — the case-study artifact.
4. Final README + open-source packaging (API docs, types, examples, benchmarks/external/RESULTS.md
   refresh with the post-Round-3 numbers).

The ratchet loop is STOPPED. To resume CPU optimization later, re-engage loop_control with a fresh
ideation pass; current pure-JS candidates are exhausted.

## Key files (read order for a fresh session)

1. This file.
2. `OPTIMIZATION-LOG.md` — per-hypothesis measured history + WebGPU prototype results.
3. `src-optimized/README.md` — optimization candidate list and Round 3 conclusion.
4. `src-optimized/webgpu/propagate-gpu.ts` — correct single-propagation GPU backend + incremental hybrid path.
5. `src-optimized/webgpu/gpu-runner.ts` — Stage 2 hybrid full-run runner (correct but too slow).
6. `scripts/debug-gpu-lockstep.ts` — current CPU/GPU lockstep debugger; propagation/sums PASS.
7. `scripts/webgpu-boundary-probe.ts` — latest boundary-crossing feasibility probe.
8. `scripts/webgpu-prototype-v2.ts` — single-propagation large-grid crossover prototype.
9. KB: `/Users/tommy/Documents/projects/superhq/tommyato-knowledge/investigations/gpu-frontier-data-structures-for-wfc.md`.
10. `prompts/optimize-one.md` — CPU ratchet methodology if needed.
11. `HARNESS-BASELINE.md` — the gate contract (valid+det; compare informational).
12. `benchmarks/external/RESULTS.md` — external comparison (needs post-Round-3 refresh before release).

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

- **No background jobs/monitors are running** unless a fresh session starts one.
- Stage 2 GPU hybrid is correct but unusably slow; do not optimize around per-observe `mapAsync`.
  The only promising GPU direction is GPU-native frontier correctness with crossings collapsed.
- The throwaway full-GPU/chunked prototype script was deleted before commit; details are in
  `OPTIMIZATION-LOG.md` commit `94bd52a` and the compacted conversation summary.
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
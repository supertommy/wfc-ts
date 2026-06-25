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

Current interpretation after lockstep debugging: the boundary-crossing idea is valid, and the Stage 3
invalidity root cause was found. The fused atomic-append AC-4 frontier kernel, parallel MRV selection,
GPU weighted observe, and `sumsOfOnes` maintenance all match CPU under a true fixpoint drain. The broken
assumption was using grid diameter as a no-readback propagation bound; WFC support cascades can outlive
geometric distance and must prove frontier-empty before the next observe.

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

Discussion framing for the next session:
- The question is no longer “can GPU WFC be correct?” — yes, under a true fixpoint drain.
- The question is “can GPU WFC prove frontier-empty cheaply enough to beat the optimized JS solver?”
- Safe `count*T` dispatches are correct but likely too slow for full runs.
- Per-observe CPU readback is correct but already measured catastrophically slow in Stage 2.
- The only plausible win is a GPU-side convergence mechanism (indirect dispatch / persistent loop / cooperative barrier-like design), but WebGPU portability is the risk.
- The pure-JS solver remains the shippable path. Treat GPU as research until it passes VALID+DET and crosses over on large heavy grids.

Post-discussion continuation:
- Added `scripts/webgpu-persistent-proto.ts` to test the most direct performance path: one persistent GPU dispatch owns MRV select, weighted observe, propagation-to-fixpoint, repeat, then one final readback.
- Result: correct/deterministic on `circuit-turnless-8`, but slow (`15.0ms` cold / `7.7ms` repeat vs JS `2.1ms`, ~0.14x) and barrier-fragile. `circuit-16` and `knots-8` exceeded the safety timeout during probing.
- Important learning: a persistent spin-barrier can prove device-side convergence, but it is not the performant WebGPU path as implemented. Avoid spin-barrier mega-kernels for the shippable solver. If GPU research continues, pivot to no-spin designs: indirect/chunked command sequences with bounded sync, or scan/compact/fixed-epoch frontier formulations.
- User wants the next GPU work to continue as a **ratchet loop**, not a one-off hand-coded branch. Use the Mike Acton loop shape again: one hypothesis per iteration, script-local prototype first, real measurement, keep/revert, log every result, commit kept/research checkpoints. Do not touch the shippable JS solver or public exports until a GPU path proves VALID+DET and a real crossover.
- GPU ratchet iteration 1 added `scripts/bench-gpu-crossover-gate.ts`. Baseline current hybrid on `circuit-turnless-128`: JS `57.4ms`, GPU `23599.6ms`, VALID PASS, DET PASS, `0.002x`; boundary counts for one GPU run were `135970` writeBuffer calls, `136717` submits, `24381` mapAsync readbacks. This is now the standard gate for future GPU candidates.
- GPU ratchet iteration 2 tested chunked fixed-epoch command batches in the optional propagation path. Correctness gates PASS and submits dropped sharply (`136717` → `35451` at circuit-128), but wall time did not improve (`26168ms` at K=16; `36310ms` at K=32) because per-observe CPU mirror return still requires ~2 `mapAsync` calls per observe (`23635` mapAsync for `11816` observes). Conclusion: propagation-layer batching is below the real bottleneck; next candidates must remove per-observe banned-log/readback dependency by keeping observe/selection/progression on GPU for chunks, or switch to bulk relaxation.
- GPU ratchet iteration 3 added `scripts/webgpu-no-spin-chunk-proto.ts`: a command-ordered full-GPU run (`select -> weighted observe -> K propagation layers`, repeated `count` times) with one submit and one final readback. It was VALID+DET on circuit 8/16/32 for tested K, but very slow: circuit-32,K=16 was `681ms` vs JS `6.77ms` (`0.010x`) with `19456` dispatches; K=32 was `1744ms`. Conclusion: collapsing readbacks is necessary but insufficient if the algorithm still emits `count*(3+K)` dispatches and has no cheap proof K is always enough. Next branch: bulk relaxation/fixed-point epochs or true frontier compaction/indirect.
- GPU ratchet iteration 4 added `scripts/webgpu-bulk-relax-proto.ts`: whole-grid relaxation propagation (`scan unsupported live tiles -> apply bans -> repeat`). It exactly matched CPU AC-4 final waves. It sometimes beat the safe worklist GPU for single propagation (`circuit-128`: `9.18ms` bulk vs `11.10ms` worklist; `circuit-256`: `25.43ms` vs `26.44ms`), but CPU was still ~`0.05-0.07ms` because realistic single-observe cascades were only 775 total bans. Conclusion: dense scans solve synchronization but do too much work; next remaining branch is indirect frontier dispatch to reduce worklist over-dispatch.
- GPU ratchet iteration 5 added `scripts/webgpu-indirect-frontier-proto.ts`: GPU writes `dispatchWorkgroupsIndirect` args from the current frontier count so each layer launches only `ceil(frontier/64)` groups. Correct and strongest GPU micro-result (`circuit-256`: worklist `32.19ms` → indirect `5.11ms`), but CPU is still `0.074ms` on the same cascade (~69x faster). This was the last plausible no-spin frontier branch. **GPU ratchet is STOPPED as exhausted.** Keep WebGPU code/prototypes as research only; resume Phase 4c JS/OSS polish.

## Open-source finish (after GPU research pauses/concludes)

Once the GPU investigation is paused or resolved, remaining Phase 4c work:
1. **Generalization check** (alternate seeds / larger grids — mandatory before any final claim).
2. **Web visualizer** (`viz/`) — uses the H16 steppable run loop to animate the collapse.
3. **Learning guide** (`docs/`) + the four `prompts/` instruction docs — the case-study artifact.
4. Final README + open-source packaging (API docs, types, examples, benchmarks/external/RESULTS.md
   refresh with the post-Round-3 numbers).

The CPU ratchet loop is REOPENED for **Round 4 algorithm-level propagation experiments**. The user explicitly wants another CPU ratchet round that tries the loop-rethinking candidates, not another pass of tiny layout filings. Keep the shippable optimized solver stable unless a candidate proves VALID+DET and faster.

Round 4 candidate order, highest expected payoff first:
1. **Dirty-cell + bitset support propagation**: script-local alternate engine first. Represent each cell domain as one or more `u32` lanes; precompute support masks by `(d,t,lane)`; when a cell changes, visit neighboring cells and remove live tiles with no bitset support. This changes the propagation formulation (AC-3-ish domain filtering) and may coalesce many tile bans per changed cell.
2. **Cell-batched AC-4**: keep support counts but batch newly banned tiles by changed cell/direction, processing all tile removals for a cell together to reduce repeated neighbor/queue overhead.
3. **Generated/specialized hot kernel**: generate or specialize per tileset/grid shape so `T`, `T4`, typed-array constructors, and maybe propagator list access become monomorphic constants. Only pursue after algorithmic propagation candidates, unless profiling shows polymorphism/dispatch overhead.
4. **Propagation ordering experiments**: LIFO vs FIFO vs spatial/ring ordering of changed cells/tile bans. Lower expected payoff; measure only if the higher-payoff propagation formulation candidates fail.

Round 4 loop rules:
- One hypothesis per iteration.
- For algorithm rewrites, start as a script-local prototype or isolated optional file that compares against the current optimized solver and independent validator before touching `src-optimized/model.ts`.
- If a prototype proves VALID+DET and faster on the real gates, promote it cleanly into `src-optimized/` in a later iteration.
- Measure against the current optimized JS solver, not just reference. Mandatory gates remain `bun run typecheck` and `bun run harness/prove-harness.ts` for promoted solver changes; prototypes must run their own correctness comparison and/or use validator paths.
- Log every result in `OPTIMIZATION-LOG.md`, update `src-optimized/README.md`, and commit useful checkpoints.
- Stop only when the Round 4 candidates are exhausted and a fresh ideation pass yields no high-payoff CPU path.

Round 4 progress:
- Iteration 1 H37 dirty-cell bitset propagation was correct but slower; rejected.
- Iteration 2 H38 cell-batched AC-4 was correct but slower; rejected.
- Iteration 3 H39 generated propagation kernel was correct and faster on circuit/rooms single-propagation drains, but used `new Function`; do **not** ship eval.
- Iteration 4 H41 static default-MRV specialized propagation passed gates but regressed full-run speed, so the model change was reverted.
- Iteration 5 H40 propagation ordering prototype was correct and showed a consistent FIFO drain-only win (~1.1-1.17x on circuit/rooms).
- Iteration 6 H42 minimal FIFO propagation passed gates but regressed full-run speed, so the model change was reverted.
- Iteration 7 STALL→IDEATE (TRIZ) found new candidates.
- Iteration 8 H43 precomputed `propCompatOffset[start+l]=t2*4+d` was KEPT: gates pass, circuit improved in A/B (~4-10%), knots flat/slightly better, rooms noise-flat, tiny memory cost.
- Iteration 9 H44 precomputed `neighborCompatBase[i*4+d]=neighbor*T4|-1` was KEPT: gates pass, higher-rep A/B improved knots/circuit/rooms (`1.016→0.984ms`, `2.376→2.293ms`, `1.086→1.068ms`).
- Iteration 10 post-H44 sanity profile added `scripts/profile-optimized-phases.ts`: current speed ~0.98ms knots / 2.29ms circuit / 1.05ms rooms; propagation still dominates circuit (~82%, 772 drains) and rooms (~73%, 519 drains). Continue with H45 as a script-local prototype only: conservative deterministic multi-observe batching, full VALID+DET + success + speed gates before any promotion.

The GPU ratchet loop is also STOPPED. The no-spin WebGPU paths tested after compact did not produce a viable crossover.

Only restart GPU research if a genuinely new algorithmic seam appears (not another variant of per-observe readbacks, fixed-epoch dispatch trains, dense scans, or frontier over-dispatch). If restarting anyway, use an objective like:

> Continue the WebGPU WFC performance ratchet. Each iteration chooses exactly one GPU convergence/frontier hypothesis, implements it only as a script-local prototype or isolated optional WebGPU file, measures correctness and speed against optimized JS, logs the result in OPTIMIZATION-LOG.md, updates HANDOFF.md if it changes the strategic picture, commits useful checkpoints, then proposes the next hypothesis. Preserve the shippable JS solver. Stop when no plausible no-spin GPU path remains or a VALID+DET GPU path crosses over on large heavy grids.

Suggested first GPU ratchet hypotheses:
1. **Chunked fixed-epoch no-spin propagation**: after each observe, enqueue K propagation dispatches without readback, then a batched count readback/check. Ratchet K (e.g. 4/8/16/32) and measure correctness/perf. This trades exact per-layer sync for fewer host crossings without spin barriers.
2. **Indirect/compacted frontier batch**: build next frontier via scan/compact or atomic append, use `dispatchWorkgroupsIndirect` where possible, and read back only at chunk boundaries. Goal: keep GPU occupancy and avoid persistent spin barriers.
3. **Bulk relaxation/fixed-point epochs**: abandon AC-4 stack shape for GPU path; every epoch recomputes unsupported live tiles in parallel and bans them. Use fixed epochs per observe or per chunk; validate whether overwork is cheaper than synchronization on large grids.
4. **Large-grid-only crossover harness**: before deeper engineering, write a gate that compares JS vs GPU candidates on circuit 128/256/512 with timeout, VALID+DET, and exact boundary-crossing counts. Do not optimize blind.
5. **No-spin full-GPU observe chunks**: GPU performs N observes with conservative over-drain between them, then host validates/drains/restarts chunk. Useful only if correctness can be maintained without per-observe mapAsync.

Hard stop criteria for the GPU ratchet:
- Any candidate that requires non-portable spin barriers for correctness is research-only and should not be promoted.
- Any candidate slower than JS on circuit-128/256 after removing obvious debug overhead is rejected unless it teaches a new path.
- Any candidate that is not VALID+DET is rejected or kept only as a negative logged prototype.
- Do not weaken the JS solver, proof harness, or public package for GPU work.

## Key files (read order for a fresh session)

1. This file.
2. `OPTIMIZATION-LOG.md` — per-hypothesis measured history + WebGPU prototype results.
3. `src-optimized/README.md` — optimization candidate list and Round 3 conclusion.
4. `src-optimized/webgpu/propagate-gpu.ts` — correct single-propagation GPU backend + incremental hybrid path.
5. `src-optimized/webgpu/gpu-runner.ts` — Stage 2 hybrid full-run runner (correct but too slow).
6. `scripts/debug-gpu-lockstep.ts` — current CPU/GPU lockstep debugger; propagation/sums PASS.
7. `scripts/webgpu-boundary-probe.ts` — latest boundary-crossing feasibility probe.
8. `scripts/bench-gpu-crossover-gate.ts` — standard large-grid VALID+DET+boundary-count gate for GPU ratchet candidates.
9. `scripts/webgpu-no-spin-chunk-proto.ts` — no-spin full-GPU command-ordered observe chunk prototype (correct small, too slow).
10. `scripts/webgpu-bulk-relax-proto.ts` — bulk relaxation propagation prototype (correct, dense-scan work volume too high).
11. `scripts/webgpu-indirect-frontier-proto.ts` — indirect frontier dispatch prototype (best GPU micro-result, still far behind CPU).
12. `scripts/webgpu-prototype-v2.ts` — single-propagation large-grid crossover prototype.
13. KB: `/Users/tommy/Documents/projects/superhq/tommyato-knowledge/investigations/gpu-frontier-data-structures-for-wfc.md`.
14. `prompts/optimize-one.md` — CPU ratchet methodology if needed.
15. `HARNESS-BASELINE.md` — the gate contract (valid+det; compare informational).
16. `benchmarks/external/RESULTS.md` — external comparison (needs post-Round-3 refresh before release).

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
  The only promising GPU direction is GPU-side frontier-empty detection with crossings collapsed.
- The throwaway full-GPU/chunked prototype script was deleted before commit; details are in
  `OPTIMIZATION-LOG.md` commit `94bd52a`. Its invalidity is now best explained by the unsafe
  fixed-diameter drain bound, later proven/fixed in commit `89ca978`.
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
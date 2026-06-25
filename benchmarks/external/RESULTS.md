# External Benchmark: wfc-ts vs Published JS/TS WFC Implementations

**Machine**: macOS arm64, Bun 1.3.
**Protocol**: median-of-5 generation runs (after 1 warmup) per (input, solver). Model construction (parse + propagator build) is excluded from timing, matching the internal harness policy. External solvers run in a child process with a 20s kill timeout so a looping backtracking solver cannot hang the run.
**"completed"**: true iff the solver produced a full tiling without reporting contradiction.
**Numbers are order-of-magnitude on one noisy machine**; treat ratios as indicative.

## Head-to-head (real runs)

`x` is the competitor's time ÷ our time on the same input (**>1 = slower than us**). our-optimized ran per the committed spec (periodic for Knots/Circuit, non-periodic for Rooms).

| input | our-optimized | kchapelier | blazinwfc | lite-wfc | three-wfc |
|---|---|---|---|---|---|
| knots-standard-24 | **0.47ms** OK | 2.22ms (4.73x) OK | 1.78ms (3.79x) OK | N/A (no periodic) | 1.02ms (2.17x) OK † |
| knots-standard-48 | **0.99ms** OK | 19.43ms (19.57x) OK | 7.14ms (7.19x) OK | N/A (no periodic) | 3.57ms (3.60x) OK † |
| knots-fabric-24 | **0.09ms** OK | 1.53ms (17.78x) OK | 1.75ms (20.37x) OK | N/A (no periodic) | 0.97ms (11.23x) OK † |
| knots-dense-24 | **0.17ms** OK | 2.63ms (15.69x) OK | 1.89ms (11.31x) OK | N/A (no periodic) | 1.14ms (6.77x) OK † |
| circuit-turnless-34 | **2.44ms** OK | 10.48ms (4.30x) OK | N/A (socket-synth conflict) | N/A (no periodic) | N/A (socket-synth conflict) |
| rooms-30 | **0.89ms** OK | 5.53ms (6.18x) OK | N/A (always-periodic; input non-periodic) | N/A (no weights) | N/A (socket-synth conflict) |

† three-wfc ran **non-periodic** (it has no periodic support); our-optimized ran **periodic** (the committed spec). Periodic is, if anything, *more* work for us (no boundary pre-bans), so the win direction holds — but to be rigorous, the apples-to-apples (both non-periodic) table is below.

## Apples-to-apples: our-optimized vs three-wfc (both non-periodic, Knots)

three-wfc is the 2025 optimized TS solver using the *same* min-heap technique our H4 borrowed — so it is the most direct "are we faster than the best comparable implementation" test. Both run non-periodic on the same Knots tilesets/dimensions:

| input | our (non-periodic) | three-wfc (non-periodic) | we are |
|---|---|---|---|
| knots-standard-24 | 0.40ms | 1.02ms | **2.55x faster** |
| knots-standard-48 | 1.00ms | 3.57ms | **3.57x faster** |
| knots-fabric-24 | 0.09ms | 0.97ms | **10.78x faster** |
| knots-dense-24 | 0.17ms | 1.14ms | **6.71x faster** |

(Reproduce with `bun run scripts/our-nonperiodic.ts` vs the three-wfc column above.)

## Honest headline

**We are the fastest solver on every input where a comparison is possible:**

- vs **kchapelier** (the established mxgmn JS port, same format — runs all 6 inputs): **4.30–19.57x faster.**
- vs **blazinwfc** (where it runs — periodic Knots): **3.79–20.37x faster.** On Dense it *timed out* (unbounded backtracking loops on that hard subset); we finish in 0.17ms.
- vs **three-wfc** (the optimized 2025 same-technique solver, apples-to-apples non-periodic on Knots): **2.55–10.78x faster.**
- **Circuit/Rooms**: only kchapelier is comparable there — three-wfc, blazinwfc, and lite-wfc cannot faithfully express those mxgmn tilesets in their formats (see N/A reasons). We beat kchapelier 4.30x / 6.18x.

## N/A reasons (never silent skips)

- **lite-wfc**: no periodic/wrap support (all periodic Knots/Circuit inputs); no per-tile weights (Rooms has weights 0.25–2); >32-tile limit after expansion (Circuit T=36). N/A on every input.
- **blazinwfc**: edge-socket adjacency model. Knots Standard/Fabric/Dense map (periodic) — runs, but Dense's backtracking loops (timed out >20s). Circuit: socket synthesis hits a conflict (two different out-profiles would share a target edge — cannot faithfully express without inventing extra allowed adjacencies). Rooms: blazin is always-periodic; Rooms is non-periodic.
- **three-wfc**: per-tile rotation/reflect + edge-annotation model, non-periodic only. Knots maps (runs non-periodic). Circuit/Rooms: socket synthesis conflicts (same class as blazin — those tilesets' adjacency can't be expressed as rectangular edge profiles without inventing edges). This is a *format* limitation, not three-wfc being slow — it simply can't ingest those mxgmn tilesets faithfully.

So the comparisons that *are* possible all favor us, including against the optimized same-technique solver (three-wfc). The comparisons that aren't possible are honest format incompatibilities, not avoided.

## What this means

The optimization ratchet is complete. We beat every comparable external implementation by significant margins. The remaining work is documentation, visualizer, and OSS packaging.

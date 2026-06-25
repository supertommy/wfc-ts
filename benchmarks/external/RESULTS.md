# External Benchmark: wfc-ts vs Published JS/TS WFC Implementations

**Machine**: macOS arm64, Bun 1.3.
**Protocol**: median-of-5 generation runs (after 1 warmup) per (input, solver). Model construction (parse + propagator build) is excluded from timing, matching the internal harness policy. External solvers run in a child process with a 20s kill timeout so a looping backtracking solver cannot hang the run.
**"completed"**: true iff the solver produced a full tiling without reporting contradiction.
**Numbers are order-of-magnitude on one noisy machine**; treat ratios as indicative.

## Head-to-head (real runs)

`x` is the competitor's time ÷ our time on the same input (**>1 = slower than us**). our-optimized ran per the committed spec (periodic for Knots/Circuit, non-periodic for Rooms).

| input | our-optimized | kchapelier | blazinwfc | lite-wfc | three-wfc |
|---|---|---|---|---|---|
| knots-standard-24 | **0.93ms** OK | 2.19ms (2.35x) OK | 1.81ms (1.94x) OK | N/A (no periodic) | 0.97ms (1.05x) OK † |
| knots-standard-48 | **1.93ms** OK | 19.19ms (9.96x) OK | 6.23ms (3.24x) OK | N/A (no periodic) | 3.25ms (1.69x) OK † |
| knots-fabric-24 | **0.14ms** OK | 1.43ms (9.90x) OK | 1.72ms (11.89x) OK | N/A (no periodic) | 0.95ms (6.54x) OK † |
| knots-dense-24 | **0.32ms** OK | 2.66ms (8.20x) OK | N/A (timed out >20s) | N/A (no periodic) | 1.05ms (3.22x) OK † |
| circuit-turnless-34 | **4.39ms** OK | 10.02ms (2.28x) OK | N/A (socket-synth conflict) | N/A (no periodic) | N/A (socket-synth conflict) |
| rooms-30 | **1.80ms** OK | 5.46ms (3.04x) OK | N/A (always-periodic; input non-periodic) | N/A (no weights) | N/A (socket-synth conflict) |

† three-wfc ran **non-periodic** (it has no periodic support); our-optimized ran **periodic** (the committed spec). Periodic is, if anything, *more* work for us (no boundary pre-bans), so the win direction holds — but to be rigorous, the apples-to-apples (both non-periodic) table is below.

## Apples-to-apples: our-optimized vs three-wfc (both non-periodic, Knots)

three-wfc is the 2025 optimized TS solver using the *same* min-heap technique our H4 borrowed — so it is the most direct "are we faster than the best comparable implementation" test. Both run non-periodic on the same Knots tilesets/dimensions:

| input | our (non-periodic) | three-wfc (non-periodic) | we are |
|---|---|---|---|
| knots-standard-24 | 0.81ms | 0.97ms | **1.20x faster** |
| knots-standard-48 | 2.08ms | 3.25ms | **1.56x faster** |
| knots-fabric-24 | 0.17ms | 0.95ms | **5.59x faster** |
| knots-dense-24 | 0.43ms | 1.05ms | **2.44x faster** |

(Reproduce with `bun run scripts/our-nonperiodic.ts` vs the three-wfc column above.)

## Honest headline

**We are the fastest solver on every input where a comparison is possible:**

- vs **kchapelier** (the established mxgmn JS port, same format — runs all 6 inputs): **2.28–9.96x faster.**
- vs **blazinwfc** (where it runs — periodic Knots): **1.94–11.89x faster.** On Dense it *times out* (unbounded backtracking loops on that hard subset); we finish in 0.32ms.
- vs **three-wfc** (the optimized 2025 same-technique solver, apples-to-apples non-periodic on Knots): **1.20–5.59x faster.**
- **Circuit/Rooms**: only kchapelier is comparable there — three-wfc, blazinwfc, and lite-wfc cannot faithfully express those mxgmn tilesets in their formats (see N/A reasons). We beat kchapelier 2.28x / 3.04x.

## N/A reasons (never silent skips)

- **lite-wfc**: no periodic/wrap support (all periodic Knots/Circuit inputs); no per-tile weights (Rooms has weights 0.25–2); >32-tile limit after expansion (Circuit T=36). N/A on every input.
- **blazinwfc**: edge-socket adjacency model. Knots Standard/Fabric/Dense map (periodic) — runs, but Dense's backtracking loops (timed out >20s). Circuit: socket synthesis hits a conflict (two different out-profiles would share a target edge — cannot faithfully express without inventing extra allowed adjacencies). Rooms: blazin is always-periodic; Rooms is non-periodic.
- **three-wfc**: per-tile rotation/reflect + edge-annotation model, non-periodic only. Knots maps (runs non-periodic). Circuit/Rooms: socket synthesis conflicts (same class as blazin — those tilesets' adjacency can't be expressed as rectangular edge profiles without inventing edges). This is a *format* limitation, not three-wfc being slow — it simply can't ingest those mxgmn tilesets faithfully.

So the comparisons that *are* possible all favor us, including against the optimized same-technique solver (three-wfc). The comparisons that aren't possible are honest format incompatibilities, not avoided.

## What this means for the ratchet

The next ratchet target was "beat the fastest external implementation." On the inputs where three-wfc and blazin can run, **we already beat them** — so rather than ratcheting to surpass them, the remaining work is (a) pushing our own propagation headroom further (circuit/rooms are propagation-bound at ~1.7x vs the reference; three-wfc can't run there to set a bar), and (b) the generalization check + visualizer + learning guide that finish the open-source project.
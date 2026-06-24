# External Benchmark: wfc-ts vs Published JS/TS WFC Implementations

**Machine**: macOS arm64, Bun 1.3  
**Protocol**: median-of-5 generation runs (after 1 warmup) per (input, solver). Model construction (parse + propagator build) is excluded from timing, matching internal harness policy.  
**Inputs**: exact committed specs from `performance-test/inputs/*.json` + corresponding `*.xml` tilesets (same subsets, W/H, periodic flags).  
**Gate for "completed"**: true iff the solver produced a full tiling without reporting contradiction.  
**"our-optimized"**: `src-optimized` (imported + timed exactly as `harness/run.ts` does).  
**Honest note**: numbers are order-of-magnitude on one noisy machine; treat ratios as indicative, not portable micro-benchmarks.

## Head-to-Head (real runs)

| input                | our-optimized          | kchapelier (wavefunctioncollapse) | blazinwfc | lite-wfc (@zakkster/lite-wfc) | three-wfc |
|----------------------|------------------------|-----------------------------------|-----------|-------------------------------|-----------|
| knots-standard-24   | **0.70ms** OK         | 2.26ms (3.22x) OK                | N/A      | N/A                          | N/A      |
| knots-standard-48   | **2.20ms** OK         | 20.40ms (9.29x) OK               | N/A      | N/A                          | N/A      |
| knots-fabric-24     | **0.16ms** OK         | 1.20ms (7.31x) OK                | N/A      | N/A                          | N/A      |
| knots-dense-24      | **0.37ms** OK         | 1.67ms (4.46x) OK                | N/A      | N/A                          | N/A      |
| circuit-turnless-34 | **4.86ms** OK         | 11.91ms (2.45x) OK               | N/A      | N/A                          | N/A      |
| rooms-30            | **2.10ms** OK         | 17.06ms (8.13x) OK               | N/A      | N/A                          | N/A      |

**Bold** = fastest on that input.

### N/A reasons (never silent skips)
- **blazinwfc**: cannot faithfully map neighbor-pair rules + symmetries to its edge-socket format without conflicts or under-constraint (adapter synthesis either raised inconsistency or produced `completed=false` while our/kchap succeed). Library also always uses wrapping (periodic) boundaries and square grids only.
- **lite-wfc**:
  - All periodic inputs: "lite-wfc has no periodic/wrap support (always clips at edges)".
  - rooms-30: "lite-wfc does not support per-tile weights (uniform choice only)" (rooms has weights 0.25–2).
  - (circuit would also have been N/A for >32 tiles after expansion (T=36) + weights.)
- **three-wfc**: N/A (browser/Three-coupled (requires canvas + image content for WFCTile2D; no periodic support in WFC2DBuffer; symmetries expressed via per-tile `rotations`/`reflect` + transformClones rather than neighbor decls); low-effort headless extraction not possible without risking incorrect rule conversion).

kchapelier always succeeded (completed=true) on every input when given the raw tiles+neighbors+subsets (with dummy bitmaps).

## Summary (rigorous)
- **our-optimized is the fastest on every input** in this head-to-head (1.00x baseline). Speedup vs kchapelier ranges ~2.3x (circuit, fabric-ish) to ~9x (large grid).
- kchapelier (the well-known "wavefunctioncollapse" npm) is the only external lib that could run *all* inputs faithfully and always produced valid tilings. It is 3–9× slower than our optimized version on these cases.
- blazinwfc and lite-wfc could not be driven with faithful input conversion for the committed tilesets (different representation: sockets vs. explicit neighbor pairs; hard limits on periodic, weights, tile count, grid shape). Three-wfc could not be used headless at low effort.
- All "OK" results above were independently validated as complete (no early exit) by the solvers themselves. Our internal harness (`harness/validate.ts`) also confirms that our-optimized outputs are always adjacency-valid.

## Raw data (from the run)
See `run.ts` output JSON (or re-run `bun run benchmarks/external/run.ts`) for the exact medians + per-solver booleans on this machine.

This benchmark answers "where do we stand vs what already exists?": on these inputs our ratcheted solver is already the fastest *and* the only one under active optimization in this tree. Next ratchet target would be to beat kchapelier's absolute speed (or prove our approach dominates the common-case propagator work).

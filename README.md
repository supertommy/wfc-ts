# wfc-ts

**Wave Function Collapse (simple tiled model) in TypeScript** — a fast, deterministic constraint solver for procedural generation.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

## Features

- **Fast**: 2.5–20x faster than comparable JS/TS implementations
- **100% success rate**: Solves hard tilesets (Summer 48×48 periodic) that others fail on
- **Deterministic**: Same seed → same output, every time
- **Steppable**: Generator-based API for visualization and cancellation
- **Zero dependencies**: Pure TypeScript, works in Node, Bun, and browsers
- **Well-tested**: Proof harness with independent validation

## Installation

```bash
npm install wfc-ts
# or
bun add wfc-ts
```

## Quick Start

```typescript
import { WFCSolver } from 'wfc-ts';

// Define tiles: 0=grass, 1=coast, 2=water
// Rule: grass can't touch water directly (needs coast)

const solver = new WFCSolver({
  width: 16,
  height: 16,
  periodic: false,
  
  weights: [1, 1, 1],  // equal probability
  
  rules: [
    // grass: can touch grass or coast
    { forTile: 0, left: [0, 1], right: [0, 1], up: [0, 1], down: [0, 1] },
    // coast: can touch anything (transition tile)
    { forTile: 1, left: [0, 1, 2], right: [0, 1, 2], up: [0, 1, 2], down: [0, 1, 2] },
    // water: can touch coast or water (not grass)
    { forTile: 2, left: [1, 2], right: [1, 2], up: [1, 2], down: [1, 2] },
  ],
});

if (solver.run(42)) {
  const grid = solver.result(); // Int32Array of tile indices
  // Render: 0=🌿, 1=🏖️, 2=🌊
}
```

### What the rules mean

```typescript
{ forTile: 0, left: [0, 1], right: [0, 1], up: [0, 1], down: [0, 1] }
//           └─────────── "tile 0 can have tiles 0 or 1 to its left"
```

The solver doesn't know what tiles look like — it just enforces adjacency rules. You map indices to sprites/rotations when rendering.

## Steppable API (for visualization)

```typescript
import { WFCSolver } from 'wfc-ts';

const solver = new WFCSolver({ width: 16, height: 16, periodic: false, weights, rules });

// Step through the solve, one observation at a time
for (const status of solver.stepRun(42, -1, 100, 1)) {
  if (status.done) {
    if (status.ok && status.complete) {
      console.log('Solved!', solver.result());
    } else {
      console.log('Failed after', status.attempt, 'attempts');
    }
    break;
  }
  
  // Visualize intermediate state
  console.log('Observed cell:', status.observedCell, 'Resolved:', status.cellsResolved);
  
  await new Promise(r => requestAnimationFrame(r)); // Animate
}
```

## API

### `WFCSolver`

```typescript
interface TileRule {
  forTile: number;      // Which tile this rule is for
  left: number[];       // Tiles that can be to the left
  right: number[];      // Tiles that can be to the right
  up: number[];         // Tiles that can be above
  down: number[];       // Tiles that can be below
}

type SearchStrategy = 'restart' | 'backtrack';

interface SearchOptions {
  strategy?: SearchStrategy; // Default: 'restart'
  maxBacktracks?: number;    // Default: 4096 when strategy='backtrack'
  maxDepth?: number;         // Default: 256 when strategy='backtrack'
}

interface WFCSolverOptions {
  width: number;
  height: number;
  periodic: boolean;                    // Wrap edges?
  weights: number[] | Float64Array;     // Weight per tile (higher = more likely)
  rules: TileRule[];                    // Adjacency rules
  heuristic?: 'mrv' | 'entropy' | 'scanline'; // Selection heuristic (default: 'mrv')
  search?: SearchOptions;               // Opt-in search mode
}

class WFCSolver {
  constructor(options: WFCSolverOptions);
  
  // Run to completion
  run(seed: number, limit?: number, budget?: number): boolean;
  
  // Step through (generator, for visualization)
  stepRun(seed, limit?, budget?, yieldEvery?, signal?): Generator<StepStatus>;
  
  // Get result after successful run
  result(): Int32Array;
  
  // Dimensions
  readonly width: number;
  readonly height: number;
  readonly tileCount: number;
}
```

### `StepStatus`

```typescript
interface StepStatus {
  done: boolean;          // Is the solve finished?
  ok?: boolean;           // Did it succeed? (only on done:true)
  complete?: boolean;     // Is the grid fully collapsed?
  attempt: number;        // Current restart attempt
  cellsResolved: number;  // Cells collapsed to one tile
  observedCell?: number;  // Cell just observed (on done:false)
  backtracks?: number;    // Present when search.strategy is 'backtrack'
}
```

### Search strategy

The restart-only default is still the default. That keeps the fast path fast.

For harder tilesets, you can opt into bounded backtracking. It saves decision checkpoints inside a restart attempt. When propagation hits a contradiction, the solver restores the last checkpoint and tries the next tile instead of throwing away the whole attempt.

```typescript
const solver = new WFCSolver({
  width,
  height,
  periodic: true,
  weights,
  rules,
  search: { strategy: 'backtrack' },
});

if (solver.run(42, -1, 0)) {
  console.log('Solved with backtracking');
}
```

Use this when success matters more than raw speed. Backtracking can solve hard local-constraint sets that restart-only search misses, but it does extra bookkeeping and can be slower. Keep the default for normal 2D tilesets. Opt in for rich pipes, tight socket sets, and other cases where alternatives matter.

`WFCSolver3D` accepts the same `search` option.

## Benchmarks

Measured on macOS arm64 with Bun 1.3. Median of 5 runs, model construction excluded.

### Speed vs External Implementations

| input | wfc-ts | kchapelier | blazinwfc | three-wfc |
|---|---|---|---|---|
| knots-standard-24 | **0.47ms** | 2.22ms (4.7x) | 1.78ms (3.8x) | 1.02ms (2.2x) |
| knots-standard-48 | **0.99ms** | 19.43ms (19.6x) | 7.14ms (7.2x) | 3.57ms (3.6x) |
| knots-fabric-24 | **0.09ms** | 1.53ms (17.8x) | 1.75ms (20.4x) | 0.97ms (11.2x) |
| knots-dense-24 | **0.17ms** | 2.63ms (15.7x) | 1.89ms (11.3x) | 1.14ms (6.8x) |
| circuit-turnless-34 | **2.44ms** | 10.48ms (4.3x) | N/A | N/A |
| rooms-30 | **0.89ms** | 5.53ms (6.2x) | N/A | N/A |

**Summary**: 2.5–20x faster than all comparable implementations.

### Success Rate (Summer tileset, 48×48 periodic)

| Solver | Success Rate | Avg Time |
|--------|--------------|----------|
| **wfc-ts** | **100%** | **45ms** |
| Baseline (no LCV) | 14% | ~500ms+ |

The Summer tileset with periodic boundaries is notoriously difficult — most WFC implementations fail frequently and require many retries. Our LCV heuristic achieves 100% success on the first attempt.

See [benchmarks/external/RESULTS.md](benchmarks/external/RESULTS.md) for methodology and N/A explanations.

## How It Works

Wave Function Collapse is a constraint satisfaction algorithm:

1. **Initialize**: Each cell can be any tile (superposition)
2. **Observe**: Pick the most constrained cell, collapse it to one tile
3. **Propagate**: Remove incompatible tiles from neighbors (AC-4)
4. **Repeat** until solved or contradiction

### Key Optimizations

This implementation uses:

- **LCV heuristic (Least Constraining Value)**: When collapsing a cell, prefer tiles that leave the most options for neighbors. Uses `weight = baseWeight × (1 + freedom)³` where freedom = count of compatible tiles across all neighbors. This achieves **100% success rate** on hard inputs while maintaining good visual variety.

- **Bucket priority queue**: O(1) minimum-remaining-values selection using Dial's algorithm with integer keys.

- **Flat typed arrays**: Cache-efficient SoA layout for wave state and compatibility counts.

- **Precomputed neighbor tables**: Eliminates per-cell coordinate arithmetic in the hot propagation loop.

- **Restart-with-derived-seeds**: On contradiction, retry with a deterministically-derived seed (not random) so results remain reproducible.

### Success Rate

The LCV heuristic was tuned to balance success rate with visual variety:

| Power | Success Rate | Visual Variety | Notes |
|-------|--------------|----------------|-------|
| ^1 | 72% | Best | Original LCV |
| ^2 | 99% | Good | Almost perfect |
| **^3** | **100%** | **Good** | **← Default** |
| ^8 | 100% | Poor (uniform) | Too aggressive |

Higher powers make the solver too conservative, always picking the "safest" tile and producing boring output. ^3 is the sweet spot.

See [docs/](docs/) for a detailed optimization walkthrough.

## Legacy: mxgmn XML Tilesets

If you have tilesets in mxgmn's XML format, use the helpers:

```typescript
import { SimpleTiledModel, loadTileset } from 'wfc-ts/helpers';

const tileset = loadTileset('path/to/tileset.xml');
const model = new SimpleTiledModel({ tileset, width: 48, height: 48, periodic: true });

if (model.run(12345, -1)) {
  const result = model.result();
}
```

The helpers handle symmetry expansion (L, T, I, F shapes) and XML parsing. The core `WFCSolver` doesn't know about XML — it just takes rules directly.

## Visualizer

A browser-based visualizer is included for exploring the algorithm:

```bash
bun run viz/server.ts
# Open http://localhost:3456
```

Features:
- Real-time step-through visualization
- Multiple tilesets (Knots, Circuit, Rooms, Summer)
- Adjustable speed (instant to step-by-step)
- Comparison with mxgmn's canonical C# implementation

## Development

```bash
bun install
bun test                    # Reference correctness suite
bun run typecheck           # TypeScript strict
bun run harness/prove-harness.ts  # Proof gate (VALID+DET)
bun run harness/measure-speedup.ts knots-standard-48 11  # Benchmark
```

## Tileset Format

Uses the [mxgmn WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) XML format:

```xml
<set unique="true" tilesize="3">
  <tiles>
    <tile name="corner" symmetry="L" weight="1"/>
    <tile name="line" symmetry="I" weight="2"/>
    <!-- ... -->
  </tiles>
  <neighbors>
    <neighbor left="corner 1" right="line 0"/>
    <!-- ... -->
  </neighbors>
</set>
```

Sample tilesets included in `tilesets/` (from mxgmn, MIT licensed).

## Optimization Journey

This solver was built using [Mike Acton's ratchet methodology](https://github.com/macton/differentiable-collisions-optc):

1. **Start with a correct reference** — faithful port of mxgmn's C# solver
2. **Profile first** — identify actual bottlenecks (propagation was 66–78% of runtime)
3. **One hypothesis at a time** — test each optimization in isolation
4. **Gate on correctness** — every change must pass VALID + DETERMINISTIC checks
5. **Keep or revert** — only keep changes that measurably improve the target metric

**17 hypotheses tested**, 17 kept:

| Category | Key Optimizations |
|----------|-------------------|
| Data layout | Flat typed arrays (SoA), CSR propagator, auto-narrowed integer widths |
| Selection | Bucket PQ for O(1) MRV, batched heap updates |
| Propagation | Precomputed neighbor tables, direct compatible-base indexing |
| Success rate | LCV heuristic with (1+freedom)³ weighting |
| Ergonomics | Steppable generator API, restart-with-derived-seeds |

See [docs/optimization-history.md](docs/optimization-history.md) and [OPTIMIZATION-LOG.md](OPTIMIZATION-LOG.md) for the full journey.

## Lineage

- **Maxim Gumin** — [WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse), the original. MIT.
- **Mathieu Fehr & Nathanael Courant** — [fast-wfc](https://github.com/math-fehr/fast-wfc), the C++ reference for optimization techniques.
- **Mike Acton** — The [ratchet methodology](https://github.com/macton/differentiable-collisions-optc) this project applies.

## License

MIT. See [LICENSE](LICENSE).

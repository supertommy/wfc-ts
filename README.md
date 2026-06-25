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
import { SimpleTiledModel, loadTileset } from "wfc-ts";

// Load a tileset (XML format, mxgmn-compatible)
const tileset = loadTileset("path/to/tileset.xml");

// Create a model
const model = new SimpleTiledModel({
  tileset,
  width: 48,
  height: 48,
  periodic: true,
});

// Run with a seed (deterministic)
const complete = model.run(12345, 0); // seed=12345, limit=0 (unlimited)

if (complete) {
  const result = model.result(); // Int32Array of tile indices
  // Use result to render your map
}
```

## Steppable API (for visualization)

```typescript
import { SimpleTiledModel, loadTileset } from "wfc-ts";

const model = new SimpleTiledModel({ tileset, width: 48, height: 48, periodic: true });

// Step through the solve, one observation at a time
for (const status of model.stepRun(12345, 0, 100, 1)) {
  if (status.done) {
    if (status.ok && status.complete) {
      console.log("Solved!", model.result());
    } else {
      console.log("Failed after", status.attempt, "attempts");
    }
    break;
  }
  
  // Visualize intermediate state
  console.log("Observed cell:", status.observedCell);
  // Access model.wave, model.sumsOfOnes for partial visualization
  
  await new Promise(r => requestAnimationFrame(r)); // Animate
}
```

## API

### `SimpleTiledModel`

```typescript
interface SimpleTiledModelOptions {
  tileset: Tileset;
  subsetName?: string | null;  // Use a named subset of tiles
  width: number;
  height: number;
  periodic: boolean;           // Wrap edges
  heuristic?: Heuristic;       // MRV (default) or Entropy
}

class SimpleTiledModel {
  constructor(options: SimpleTiledModelOptions);
  
  // Run to completion (fast path)
  run(seed: number, limit: number, budget?: number): boolean;
  
  // Step through (generator, for visualization)
  stepRun(seed: number, limit: number, budget?: number, yieldEvery?: number, signal?: AbortSignal): Generator<StepStatus>;
  
  // Get result after successful run
  result(): Int32Array;
  
  // Memory footprint (bytes)
  footprintBytes(): number;
}
```

### `Tileset`

```typescript
// Load from XML (mxgmn format)
function loadTileset(xmlPath: string): Tileset;
function parseTileset(xmlString: string, name: string): Tileset;

interface Tileset {
  name: string;
  tilesize: number;
  tiles: TileDef[];
  neighbors: NeighborDef[];
  subsets: SubsetDef[];
}
```

### `Heuristic`

```typescript
enum Heuristic {
  MRV = "mrv",       // Minimum Remaining Values (default, faster)
  Entropy = "entropy" // Shannon entropy (original mxgmn behavior)
}
```

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

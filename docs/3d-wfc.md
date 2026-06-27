# 3D Wave Function Collapse

`WFCSolver3D` extends the core solver from a 2D grid to a voxel grid. The algorithm is the same -- observe one cell, propagate constraints, repeat -- but every cell can have six neighbors instead of four.

## How 3D differs from 2D

| 2D | 3D |
|---|---|
| `width × height` cells | `width × height × depth` cells |
| 4 directions | 6 directions |
| result index: `x + y * width` | result index: `x + y * width + z * width * height` |
| easy to inspect as an image | needs slicing, orbit camera, or debug tooling |

A 32³ grid has 32,768 cells. A 32² grid has 1,024. That 32× cell count is the first performance difference you feel.

## Direction convention

3D rules use named fields. Prefer the names over numeric direction indices.

| field | axis | meaning |
|---|---|---|
| `left` | -X | neighbor at `x - 1` |
| `right` | +X | neighbor at `x + 1` |
| `up` | +Y | neighbor at `y + 1` |
| `down` | -Y | neighbor at `y - 1` |
| `front` | -Z | neighbor at `z - 1` |
| `back` | +Z | neighbor at `z + 1` |

The flattened result is Z-outer row-major:

```typescript
const index = x + y * width + z * width * height;

const x = index % width;
const y = Math.floor(index / width) % height;
const z = Math.floor(index / (width * height));
```

## Defining 3D rules

Each tile gets one rule with six adjacency lists:

```typescript
import type { TileRule3D } from 'wfc-ts';

const solid = 1;
const empty = 0;

const rules: TileRule3D[] = [
  {
    forTile: empty,
    left: [empty, solid],
    right: [empty, solid],
    up: [empty, solid],
    down: [empty, solid],
    front: [empty, solid],
    back: [empty, solid],
  },
  {
    forTile: solid,
    left: [empty, solid],
    right: [empty, solid],
    up: [empty, solid],
    down: [empty, solid],
    front: [empty, solid],
    back: [empty, solid],
  },
];
```

A list means: "when this tile is in a cell, these tile ids may appear in that direction." The lists are directed. If tile A allows tile B to its right, tile B should usually also allow tile A to its left. Socket-based tilesets are easiest when you generate both sides from face data instead of writing every list by hand.

## Common 3D patterns

### Symmetric blocks

Solid/empty or material-fill tiles often allow the same neighbors on every face.

```typescript
{
  forTile: STONE,
  left: [STONE, AIR],
  right: [STONE, AIR],
  up: [STONE, AIR],
  down: [STONE, AIR],
  front: [STONE, AIR],
  back: [STONE, AIR],
}
```

### Socket pipes

Pipes are better described as face openings. Two touching faces are compatible when they agree: opening meets opening, wall meets wall. The 3D visualizer uses this pattern for straights, elbows, tees, and six-way junctions.

```typescript
const opposite = [1, 0, 3, 2, 5, 4];
const fields = ['left', 'right', 'up', 'down', 'front', 'back'] as const;

function buildRule(tile: { open: number[] }, tileIndex: number, tiles: { open: number[] }[]): TileRule3D {
  const rule = { forTile: tileIndex } as TileRule3D;
  for (let d = 0; d < 6; d++) {
    rule[fields[d]] = [];
    for (let other = 0; other < tiles.length; other++) {
      if (tiles[other].open[opposite[d]] === tile.open[d]) rule[fields[d]].push(other);
    }
  }
  return rule;
}
```

### Boundary-only tiles

For non-periodic grids, out-of-bounds neighbors are skipped. That means a tile with an empty adjacency list in a direction can sit on the matching boundary, but it cannot sit where an in-bounds neighbor exists in that direction.

Example: if `up: []`, the tile can only appear on the top face of a non-periodic grid. With `periodic: true`, there is always a wrapped neighbor, so an empty list creates a contradiction.

## Result and partial states

`result()` returns an `Int32Array` of length `width * height * depth`.

After a successful complete run, every value is a tile id. During step-by-step visualization, or after a limited/incomplete run, unresolved cells are represented as `-1` by visualizers and validators.

Use the `StepStatus` from `stepRun()` to distinguish success from partial progress:

```typescript
for (const status of solver.stepRun(42, -1, 100, 1)) {
  if (status.done) {
    if (status.ok && status.complete) console.log('complete', solver.result());
    break;
  }
}
```

## Validation

The 3D harness validates outputs without sharing topology code with the solver:

```bash
bun run harness/validate-3d.ts
bun run harness/prove-harness-3d.ts
```

`validate3D` reports:

- `valid`: no adjacency violations, and no unresolved cells when `complete=true`
- `violations`: directed adjacency failures
- `adjacencyChecks`: directed checks performed; an undirected interior edge is counted once from each side
- `unresolvedCells`: cells with `-1`
- `firstViolation`: the first concrete failing directed pair, useful for debugging rule mistakes

## Performance notes

- Memory scales with `cells × tiles × 6 directions`.
- 3D contradiction rates can be higher because every observed cell has more constraints.
- Use the default `heuristic: 'mrv'` first.
- For rich socket tilesets, try `search: { strategy: 'backtrack' }` when you care more about completion than raw speed.
- Keep 3D examples small while authoring rules. Validate a 4³ fixture before trying 32³.

## Visualizer

Run the 3D visualizer:

```bash
bun run viz3d/server.ts
# Open http://localhost:3457
```

It renders the socket-pipe fixture with orbit controls, a Z-slice slider, and step/run controls.

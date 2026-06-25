# Architecture

## Code Structure

```
src/                  Reference implementation (correctness anchor)
src-optimized/        Optimized implementation (what you import)
├── model.ts          Core WFC algorithm (Model class)
├── simple-tiled-model.ts   SimpleTiledModel (tileset → Model)
├── tileset.ts        XML parsing and tile expansion
├── prng.ts           Deterministic PRNG (mulberry32)
├── bucket-pq.ts      O(1) bucket priority queue for MRV
└── index.ts          Public exports
```

## Data Layout (Structure of Arrays)

The optimized solver uses flat typed arrays instead of nested objects. This improves cache locality and reduces GC pressure.

### Wave State

```typescript
// Instead of: cells: Array<Set<number>>
wave: Uint8Array          // [count * T] — 1 if tile possible, 0 if banned
sumsOfOnes: Uint8Array    // [count] — remaining tile count per cell
```

To check if tile `t` is possible in cell `i`: `wave[i * T + t]`

### Propagator (CSR format)

The adjacency rules are stored in Compressed Sparse Row format:

```typescript
propStart: Uint16Array    // [D * T] — where each (direction, tile) list starts
propLen: Uint8Array       // [D * T] — length of each list
propData: Uint8Array      // [total] — the actual tile indices
```

To iterate tiles compatible with tile `t1` in direction `d`:
```typescript
const start = propStart[d * T + t1];
const len = propLen[d * T + t1];
for (let l = 0; l < len; l++) {
  const t2 = propData[start + l];
  // t2 is compatible with t1 in direction d
}
```

### Support Counts (AC-4)

```typescript
compatible: Uint8Array    // [count * T * 4] — support counts
// compatible[i * T * 4 + t * 4 + d] = how many tiles in direction d support tile t in cell i
```

When this count hits zero, the tile is banned.

### Neighbor Table

```typescript
neighbors: Int32Array     // [count * 4] — neighbor cell index per direction (-1 if none)
neighborCompatBase: Int32Array  // [count * 4] — precomputed neighbor * T * 4 for fast indexing
```

Precomputing these eliminates per-propagation coordinate arithmetic.

## Priority Queue

Instead of a heap (O(log n) operations), we use a **bucket priority queue**:

```typescript
buckets: Array<number[]>  // buckets[k] = list of cells with k remaining tiles
minBucket: number         // smallest non-empty bucket index
inBucket: Int32Array      // [count] — which bucket each cell is in (-1 if collapsed)
```

Since the number of remaining tiles is bounded by T (typically < 100), we can use direct-indexed buckets for O(1) extract-min and O(1) decrease-key.

## Run Loop

```typescript
run(seed, limit, budget) {
  for (let attempt = 0; attempt < budget; attempt++) {
    this.clear();  // restore to initial state
    const random = mulberry32(deriveRestartSeed(seed, attempt));
    
    while (true) {
      const cell = this.nextUnobservedNode(random);  // MRV selection
      if (cell < 0) return true;  // all collapsed — success!
      
      this.observe(cell, random);  // collapse to one tile
      
      if (!this.propagate()) {  // AC-4 constraint propagation
        break;  // contradiction — try next attempt
      }
    }
  }
  return false;  // exhausted budget
}
```

## Steppable Generator

For visualization, `stepRun` is a generator that yields after each observation:

```typescript
*stepRun(seed, limit, budget, yieldEvery, signal?) {
  // ... same logic, but:
  yield { done: false, observedCell: cell, attempt, cellsResolved };
  // Check signal?.aborted for cancellation
}
```

This enables frame-by-frame animation without blocking the main thread.

## Memory Footprint

Typical footprint for a 48×48 grid with 36 tiles:

| Array | Size | Notes |
|-------|------|-------|
| wave | 83 KB | count × T |
| compatible | 332 KB | count × T × 4 |
| sumsOfOnes | 2.3 KB | count |
| neighbors | 37 KB | count × 4 × 4 bytes |
| propagator | ~2 KB | depends on tileset |
| **Total** | ~460 KB | |

Most memory is in `compatible` (the AC-4 support counts).

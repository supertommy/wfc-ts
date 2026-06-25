# WFC-TS Handoff Notes

## Current State (2026-06-25)

**Visualizer is working and verified:**
- Server: `bun run viz/server.ts` → http://localhost:3456
- All 4 tilesets working: Knots, Circuit, Rooms, Summer
- Canonical mxgmn comparison working (runs actual C# solver)
- Defaults: Summer tileset, Instant speed

**Recent commits:**
- `8db1f3e` - Default to Summer tileset and Instant speed
- `cdafc5b` - Add Summer game tileset with unique tile support
- `4e64dae` - Fix tile rendering with subsets and rotation direction

## Success Rate Ratchet — COMPLETED

**H46: LCV (Least Constraining Value) — KEPT** ✅

Implemented in commit `5d10b99`. When selecting which tile to collapse to,
weight by how many options each candidate leaves for neighbors.

### Results

| Test Case | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Summer 48×48 periodic | 14% | **72%** | **+58pp (5.1×)** |
| Summer 48×48 non-periodic | 92% | **100%** | **+8pp** |
| Speed | baseline | maintained | No regression |

### How It Works

In `observe()`, instead of pure weighted random:
1. For each candidate tile t, count "freedom" = total compatible tiles across all neighbors
2. Weight = original_weight × (1 + freedom)
3. Higher freedom tiles are more likely to be picked

This is deterministic (same seed = same result) and actually faster
(fewer restarts = less wasted work).

### H49: Tabu-based backtracking — REVERTED ❌

Tried a tabu-based approach: track (cell, tile) choices that led to
contradiction, penalize them on restart. **Result: 74% → 49%** (worse!).

Why it failed: A (cell, tile) choice being "bad" depends on PRIOR choices,
not just on the pair itself. The same tile at the same cell can be good in
one collapse order and bad in another. Global tabu doesn't capture this.

True checkpoint-based backtracking would work but adds significant complexity
and memory overhead. The 72-74% success rate from LCV alone is acceptable.

### Remaining Hypotheses (if pursuing >80%)

### Files to Create

```
harness/success-rate-sweep.ts  — Run N seeds, report success %
scripts/success-rate-baseline.ts — Establish baseline for each tileset/size
```

### Baseline to Establish

Run before starting hypotheses:
```bash
# Measure current success rate
bun run harness/success-rate-sweep.ts --tileset Summer --size 48 --seeds 100 --periodic
```

Expected baseline: ~40-60% success rate for Summer 48×48

### Implementation Notes

**LCV implementation sketch:**
```typescript
// In observe(), when selecting which tile to collapse to:
// Instead of pure weighted random, score candidates by neighbor freedom

function countNeighborFreedom(cell: number, tile: number): number {
  let freedom = 0;
  for (const dir of [0, 1, 2, 3]) {
    const neighbor = neighbors[cell * 4 + dir];
    if (neighbor < 0) continue;
    // Count how many tiles remain valid for neighbor if we pick `tile`
    const validForNeighbor = countCompatible(tile, dir, wave, neighbor);
    freedom += validForNeighbor;
  }
  return freedom;
}

// Pick tile with highest freedom (or weighted random biased toward high freedom)
```

**Key constraint:** Don't break determinism — same seed must produce same result. LCV scoring is deterministic so this is fine.

### Visualizer Details (for debugging)

- Port: 3456
- Summer tileset uses `unique="True"` (pre-rotated tile images)
- Canonical comparison caps Summer at 16×16 (larger sizes contradict)
- Server logs to stdout: `[canonical] tileset=... size=... seed=...`

### Commands

```bash
# Run visualizer
bun run viz/server.ts

# Run proof harness (must pass before any commit)
bun run harness/prove-harness.ts

# Run speed benchmarks
bun run harness/measure-speedup.ts

# Type check
bun run typecheck
```

## Why Summer Fails at Large Sizes

1. **Tight adjacency rules** — grass↔cliff↔water transitions are specific
2. **No backtracking** — WFC commits to choices, can't undo
3. **Cascading constraints** — larger grid = longer propagation chains
4. **Periodic boundaries** — edges must wrap correctly, adding constraints

The mxgmn canonical also fails and retries up to 10 seeds per case.

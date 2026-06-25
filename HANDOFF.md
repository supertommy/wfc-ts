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

## Next Task: Success Rate Ratchet Loop

**Problem:** WFC often hits contradictions on harder tilesets (Summer 48×48 fails ~50%+ of seeds).

**Goal:** Improve success rate using the same ratchet methodology we used for speed.

### Ratchet Setup

**Metric:** Success rate (% of seeds that complete without contradiction)  
**Gate:** VALID when successful, speed ≤ 1.1x baseline  
**Test case:** Summer 48×48, 100 seeds, periodic=true

### Hypotheses to Test (in order)

1. **H1: LCV (Least Constraining Value)**
   - When choosing which tile to collapse to, pick the one that leaves the most options for neighbors
   - Expected: significant success rate improvement, minor speed cost
   - Location: `src-optimized/model.ts` in the observe/collapse logic

2. **H2: Smarter MRV tiebreaker**
   - When multiple cells have same entropy, pick the one whose neighbors are most constrained
   - Expected: moderate improvement

3. **H3: Propagation order**
   - Process most-constrained cells first in the AC-4 propagation queue
   - Expected: small improvement

4. **H4: Limited backtracking**
   - On contradiction, undo last N choices and retry with different tiles
   - Expected: large improvement but complexity cost
   - Consider: checkpoint/restore state efficiently

5. **H5: Weighted retry**
   - Track which early tile choices led to failures, bias against them on retry
   - Expected: moderate improvement for retry scenarios

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

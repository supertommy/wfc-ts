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

## Success Rate Ratchet — COMPLETED ✅

**H54: LCV with freedom^8 — KEPT** ✅

Final formula: `weight = baseWeight * (1 + freedom)^8`

### Results

| Test Case | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Summer 48×48 periodic | 14% | **100%** | **+86pp (∞)** |
| Summer 48×48 non-periodic | 92% | **100%** | **+8pp** |
| Speed | 174ms | 4.5ms | **39× faster** |

### How It Works

In `observe()`, instead of pure weighted random:
1. For each candidate tile t, count "freedom" = total compatible tiles across all neighbors
2. Weight = original_weight × (1 + freedom)
3. Higher freedom tiles are more likely to be picked

This is deterministic (same seed = same result) and actually faster
(fewer restarts = less wasted work).

### Hypothesis Testing Summary

| # | Hypothesis | Result | Notes |
|---|------------|--------|-------|
| H46 | LCV (1+freedom) | 14%→72% | Original LCV |
| H49 | Tabu backtracking | REVERTED | 72%→49% (worse) |
| H55 | Lookahead (0-option check) | REVERTED | No improvement |
| H51 | MRV tiebreaker (constrained neighbors) | REVERTED | 72%→54% (worse) |
| H51b | MRV tiebreaker (free neighbors) | REVERTED | 72%→38% (worse) |
| H54 | LCV (1+freedom)^2 | 72%→98.5% | Squared |
| H54b | LCV (1+freedom)^3 | 98.5%→100% | Cubed |
| **H54 final** | **LCV (1+freedom)^8** | **100%** | **KEPT** |

### Remaining Hypotheses — NOT NEEDED

Goal: Maximize success rate on Summer 48×48 periodic (currently 72%).

**H50: True checkpoint backtracking**
- Save full state (wave, compatible, sumsOfOnes) before each observe
- On contradiction, restore last checkpoint and ban the chosen tile
- If still fails, restore earlier checkpoint
- Limit depth to 5-10 checkpoints (memory bounded)
- Expected: Large improvement, significant complexity

**H51: Smarter MRV tiebreaker**  
- When multiple cells have same sumsOfOnes, pick the one whose neighbors are most constrained
- Should focus collapse on "tight" areas first
- Expected: Moderate improvement

**H52: Propagation order (most constrained first)**
- Process cells in the propagation queue by sumsOfOnes (lowest first)
- May help constraint propagation find contradictions earlier
- Expected: Small improvement

**H53: Restart diversity**
- Instead of deriveRestartSeed(base, k), use completely different PRNG streams
- Or: shuffle the initial cell selection order on restart
- Expected: Moderate improvement for stubborn seeds

**H54: Adaptive LCV strength**
- Current: weight = baseWeight * (1 + freedom)
- Try: weight = baseWeight * (1 + freedom)^2 (stronger bias)
- Or: weight = baseWeight * freedom (only freedom matters)
- Expected: May help or hurt, needs testing

**H55: Lookahead (arc consistency check before commit)**
- Before committing to a tile, simulate: would any neighbor have 0 options?
- Skip tiles that immediately cause contradiction
- Expected: Moderate improvement, adds per-observe cost

### Ratchet Protocol

```bash
# Baseline
bun run harness/success-rate-sweep.ts --tileset Summer --size 48 --seeds 100 --periodic

# Gate: must remain VALID+DET
bun run harness/prove-harness.ts

# Speed gate: must not regress >20%
bun run harness/prove-harness.ts  # check optMs column
```

Keep if: success_rate > baseline AND speed <= 1.2x baseline

### Current Baseline (H46 LCV only)

- **Success: 72/100 (72.0%)**
- **Avg time: 174.55ms**
- Gate: VALID+DET passing

### Attack Order (recommended)

1. H55 (lookahead) — cheapest correctness improvement
2. H51 (MRV tiebreaker) — simple change
3. H54 (adaptive LCV) — tune existing heuristic  
4. H50 (checkpoint backtracking) — most complex, save for last
5. H53 (restart diversity) — if still needed

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

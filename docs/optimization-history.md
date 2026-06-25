# Optimization History

This document chronicles the optimization journey from the reference implementation to a 2.5–20x faster solver.

## The Ratchet Method

We used the **Mike Acton ratchet technique**: every optimization is measured against a proof harness, and only changes that pass gates and show real speedup are kept. Progress ratchets forward without drifting backward.

The gates:
- **VALID**: Independent validator confirms the output is a legal tiling
- **DET**: Same seed produces identical output every run
- **SPEED**: Measured median-of-N, not guessed

## Round 1: Foundation (6.6x on scan-bound inputs)

### H1: Flatten to Typed Arrays (1.2–1.3x)

**Problem**: The reference used nested `Array<Array<boolean>>` for wave state.

**Solution**: Flat `Uint8Array` with manual indexing: `wave[i * T + t]`.

**Why it works**: 
- Contiguous memory → better cache locality
- No object headers → less memory
- No GC pressure → predictable performance

### H2: CSR Propagator (1.4–1.6x on propagation-bound)

**Problem**: Propagation rules stored as nested arrays.

**Solution**: Compressed Sparse Row format with `propStart`, `propLen`, `propData`.

**Why it works**: Sequential memory access in the inner loop. The propagator is read-only after construction, so we can pack it tightly.

### H4: Heap-Based Selection (6.6x on large grids)

**Problem**: Finding the minimum-entropy cell scanned all cells — O(n) per observation.

**Solution**: Min-heap with decrease-key support. O(log n) extract-min, O(log n) update.

**Why it works**: For a 48×48 grid (2304 cells) with 2000+ observations, O(n) scans dominate. The heap makes selection nearly free.

### H6: Batched Heap Updates (5–16% on propagation-bound)

**Problem**: Each `ban()` call updated the heap immediately — many updates per propagation wave.

**Solution**: Mark cells dirty, batch heap updates at propagation end.

**Why it works**: Fewer heap operations, amortized cost.

## Round 2: Propagation Wall (2.5–3x on propagation-bound)

After Round 1, the scan was gone. Now **propagation dominated** (~85% of time on circuit/rooms).

### H10: Cache Clear Fixpoint (10–20%)

**Problem**: `clear()` rebuilt all state from scratch on each restart attempt.

**Solution**: Snapshot the post-initialization state; restore with fast `.set()` instead of recomputing.

**Why it works**: Most restarts start from the same initial state. Copying is cheaper than recomputing.

### H12: Restart with Derived Seeds (5% → 100% success)

**Problem**: Hard inputs failed ~5% of seeds with no recovery.

**Solution**: On contradiction, restart with a deterministically-derived seed. Budget of 100 attempts.

**Why it works**: The solver is fast enough that 100 restarts are cheaper than backtracking. Deterministic derivation preserves reproducibility.

### H22: MRV Instead of Entropy (5–10%)

**Problem**: Entropy calculation required `Math.log()` per ban.

**Solution**: Use raw tile count (Minimum Remaining Values) instead of Shannon entropy.

**Why it works**: `Math.log` is expensive. MRV works just as well for most tilesets.

### H23: Narrow Compatible Array (7–10%)

**Problem**: Support counts stored as `Int32Array` — 4 bytes each.

**Solution**: Use `Uint8Array` — counts never exceed T (<256).

**Why it works**: 4× less memory in the hot loop → 4× better cache utilization. The inner loop is memory-bound.

## Round 3: Micro-Layout (3x on all inputs)

With big wins harvested, we focused on cache-line optimization.

### H26–H28: Narrow All Arrays

Applied the H23 technique everywhere:
- `propData`: Int32 → Uint8 (tile IDs < 256)
- `propStart`: Int32 → Uint16 (offsets < 65536)
- `stackT`: Int32 → Uint8, `stackI`: Int32 → Uint16
- `sumsOfOnes`: Int32 → Uint8

Each narrowing improved cache efficiency.

### H30: Bucket Priority Queue (28% on scan-bound)

**Problem**: Even a heap has O(log n) overhead.

**Solution**: Direct-indexed buckets. `buckets[k]` holds all cells with k remaining tiles.

**Why it works**: Since k ∈ [1, T] and T < 100, we can use array indexing instead of heap comparisons. O(1) extract-min, O(1) update.

### H31: Precomputed Neighbor Table (17–20%)

**Problem**: Every propagation step computed `(x + dx) % MX` and neighbor indices.

**Solution**: Precompute `neighbors[cell * 4 + dir]` at initialization.

**Why it works**: Removes arithmetic from the inner loop. The table is small (count × 4 × 4 bytes).

## Round 4: Exhaustion

### What Didn't Work

- **H37 Dirty-cell bitset**: Added tracking overhead exceeded saved work
- **H38 Cell-batched AC-4**: Bookkeeping cost exceeded benefit
- **H40/H42 FIFO propagation**: Drain-only wins didn't survive full-run measurement
- **H45 Batched observations**: Stale choices caused contradictions

### What Did Work

- **H43 Precomputed compatible offsets**: Removed inner-loop address arithmetic
- **H44 Precomputed neighbor compatible bases**: Removed outer-loop multiply

### The Wall

The remaining propagation cost is **irreducible** in plain JavaScript:
- The AC-4 decrement loop is the essential work
- Every optimization that changed the algorithm shape regressed
- The remaining wins are all layout/precompute, not algorithmic

## Final Numbers

| Input | Reference | Optimized | Speedup |
|-------|-----------|-----------|---------|
| knots-standard-48 | 10.6ms | 0.99ms | **10.7x** |
| circuit-turnless-34 | 7.1ms | 2.44ms | **2.9x** |
| rooms-30 | 3.3ms | 0.89ms | **3.7x** |

vs external implementations: **2.5–20x faster** than all comparable JS/TS solvers.

## Lessons

1. **Measure first**: Profile before optimizing. The bottleneck shifted three times (scan → propagation → inner loop).

2. **Data layout matters**: Flat typed arrays beat nested objects. Narrow arrays beat wide ones.

3. **Precompute > runtime math**: Moving arithmetic to initialization always won.

4. **Algorithmic changes are risky**: Most algorithm rewrites regressed. Safe layout changes won.

5. **Know when to stop**: After Round 4, no plausible >5% CPU win remained. Ship it.

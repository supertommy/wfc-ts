# wfc-ts Learning Guide

This guide explains Wave Function Collapse and walks through the optimization techniques used in wfc-ts.

## Contents

1. [WFC Concepts](./wfc-concepts.md) — What WFC is and how it works
2. [Architecture](./architecture.md) — Code structure and data layout
3. [Optimization History](./optimization-history.md) — The ratchet journey from 1x to 20x

## Quick Overview

Wave Function Collapse is a constraint satisfaction algorithm inspired by quantum mechanics metaphors. Each cell starts in a "superposition" of all possible tiles, then collapses one at a time while propagating constraints to neighbors.

The core loop:
1. **Observe**: Pick the most constrained cell (minimum remaining values)
2. **Collapse**: Choose one tile from its possibilities (weighted random)
3. **Propagate**: Remove incompatible tiles from neighbors (AC-4)
4. **Repeat** until solved or contradiction

This implementation achieves 2.5–20x speedup over comparable JS/TS solvers through:
- Flat typed arrays (SoA layout)
- Bucket priority queue for O(1) MRV selection
- Precomputed neighbor and propagation tables
- Cache-optimized data widths (Uint8/Uint16 where possible)
- Restart-with-derived-seeds for 100% success

See the individual docs for details.

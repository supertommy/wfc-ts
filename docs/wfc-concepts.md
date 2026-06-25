# WFC Concepts

## What is Wave Function Collapse?

Wave Function Collapse (WFC) is a procedural generation algorithm created by Maxim Gumin in 2016. It generates outputs that locally resemble a sample input — like generating a map where every 3x3 region looks like it could have come from an example map.

The name comes from a quantum mechanics metaphor: each cell starts in a "superposition" of all possible states, then "collapses" to a single state when observed.

## Simple Tiled Model

This implementation is the **simple tiled model** variant:
- You define a set of **tiles** (like "corner", "straight", "cross")
- You define which tiles can be **neighbors** in each direction
- The algorithm fills a grid respecting those constraints

This is different from the **overlapping model** which learns patterns from a sample image.

## The Algorithm

### 1. Initialization

Every cell starts with all tiles possible:

```
[ A B C D ]  [ A B C D ]  [ A B C D ]
[ A B C D ]  [ A B C D ]  [ A B C D ]
[ A B C D ]  [ A B C D ]  [ A B C D ]
```

### 2. Observation

Pick the cell with the **fewest remaining possibilities** (MRV heuristic) and collapse it to one tile:

```
[ A B C D ]  [ A B C D ]  [ A B C D ]
[ A B C D ]  [    B    ]  [ A B C D ]   ← collapsed!
[ A B C D ]  [ A B C D ]  [ A B C D ]
```

### 3. Propagation

Remove tiles from neighbors that are now incompatible. If tile B can only have A or C to its right, remove D from the right neighbor:

```
[ A B C D ]  [ A B C D ]  [ A   C   ]   ← D removed
[ A B C D ]  [    B    ]  [ A B C D ]
[ A B C D ]  [ A B C D ]  [ A B C D ]
```

This removal might cascade — if removing D from a cell means it can no longer support some tile in *its* neighbor, propagate again.

### 4. Repeat

Keep observing the most constrained cell and propagating until:
- **Success**: Every cell has exactly one tile
- **Contradiction**: Some cell has zero tiles remaining

### 5. On Contradiction

If a contradiction occurs, the algorithm can:
- **Backtrack**: Undo the last choice and try another (expensive)
- **Restart**: Start over with a different random seed (what we do)

## AC-4 Arc Consistency

The propagation step uses **AC-4** (Arc Consistency algorithm #4), a classic constraint satisfaction technique.

Instead of re-checking all constraints after each change, AC-4 maintains **support counts**: for each (cell, tile, direction), how many neighbor tiles currently support it?

When a tile is removed ("banned"):
1. Decrement support counts for tiles that depended on it
2. If any count hits zero, ban that tile too
3. Repeat until no more bans

This is much faster than naive constraint checking.

## Heuristics

### Minimum Remaining Values (MRV)

Always observe the cell with the fewest remaining tiles. This:
- Fails fast (a cell with 1 option is forced; a cell with 0 is a contradiction)
- Reduces the search space

### Entropy (original mxgmn)

The original algorithm uses Shannon entropy, accounting for tile weights:
```
entropy = log(sum(weights)) - sum(weight * log(weight)) / sum(weights)
```

MRV is faster (no Math.log) and works just as well for most tilesets.

## Tile Symmetry

Tiles can have rotational and reflective symmetry:
- `X`: all 8 transformations identical (like a blank tile)
- `T`: 4 rotations (like a T-junction)
- `I`: 2 rotations (like a straight pipe)
- `L`: 4 rotations (like an L-bend)
- `\`: 2 rotations (like a diagonal)
- `F`: no symmetry, all 8 distinct

The tileset parser expands symmetric tiles into their variants automatically.

## Periodic vs Non-Periodic

- **Periodic**: The grid wraps (right edge connects to left, bottom to top)
- **Non-periodic**: Edges don't connect; boundary cells have fewer neighbors

Periodic is often used for seamlessly tiling textures.

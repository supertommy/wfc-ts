# 3D WFC Visualizer

A small browser surface for seeing `WFCSolver3D` collapse a voxel grid.

```bash
bun run viz3d/server.ts
# Open http://localhost:3457
```

The default `Pipes` tileset is a rich socket family:

- `empty`
- straight X/Y/Z pipes
- elbows that turn across axes
- tees that branch into three directions
- `junction-6`, a six-way connector

Each tile declares which of its six faces has an opening. The server generates adjacency rules from those sockets. Two neighbors are compatible when the touching faces agree: open meets open, wall meets wall.

That gives you local connectivity. It means no interior pipe opening points into a wall. It does **not** guarantee one global connected component. You can still get separate pipe islands because WFC enforces neighbor constraints, not graph-wide reachability.

The visualizer renders the same sockets. A tile with two openings becomes a turn or straight. A tile with three openings becomes a branch. The six-way junction gets arms in every direction.

Rich pipes use opt-in backtracking on the solve routes:

```typescript
search: { strategy: 'backtrack', maxBacktracks: 4096, maxDepth: 256 }
```

The library restart-only default remains the fast default. The visualizer opts in because rich socket sets need alternatives when a local choice creates a later contradiction.

## Controls

- **Tileset**: currently `Pipes`.
- **W/H/D**: grid dimensions.
- **Seed**: deterministic solve seed.
- **Periodic**: wrap edges.
- **Auto-rotate**: spin the camera.
- **Z**: hide layers above a selected depth.
- **Run / Step / Reset**: solve instantly, advance one yielded step, or clear the scene.

## Smoke checklist

Use this when changing the visualizer:

- Page loads without console errors.
- Default tileset (Pipes 4x4x4) renders rich socket geometry.
- "Step" advances one observe/propagate cycle.
- "Run" completes the solve with animation.
- Orbit camera drag rotates; scroll zooms.
- Z slider hides voxels above the selected layer.
- Unresolved cells show as translucent gray.
- Completed solve shows colored geometry per pipe type.
- Repeated solves dispose old geometry before rendering the next result.

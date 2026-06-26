# 3D WFC Visualizer

## Usage
```bash
bun run viz3d/server.ts
# Open http://localhost:3457
```

## Acceptance Criteria
- [ ] Page loads without console errors
- [ ] Default tileset (Pipes 4×4×4) renders as colored cubes
- [ ] "Step" button advances one observe/propagate cycle
- [ ] "Run" button completes the solve with animation
- [ ] Orbit camera: drag to rotate, scroll to zoom
- [ ] Z-scrubber: slider hides voxels above selected Z level
- [ ] Unresolved cells shown as translucent gray
- [ ] Completed solve shows solid colored cubes per tile type
- [ ] Memory: no leaks on repeated solves (dispose properly)
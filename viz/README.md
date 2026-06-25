# wfc-ts Visualizer

A web-based visualization of Wave Function Collapse in action.

## Usage

Open `index.html` in a browser:

```bash
# Using Python
python3 -m http.server 8080 -d viz
# Then open http://localhost:8080

# Or using Bun
bunx serve viz
```

## Features

- **Step-by-step visualization**: Watch the algorithm collapse cells one at a time
- **Speed control**: Slow (1/frame), Medium (10/frame), Fast (50/frame), or Instant
- **Grid size**: 24×24 to 64×64
- **Seed control**: Reproducible results with the same seed
- **Color coding**:
  - Dark colors = few remaining tile options (more constrained)
  - Bright colors = many remaining options
  - Solid colors = collapsed to a specific tile

## How It Works

This demo simulates the WFC stepRun API. In a real project, you would:

```typescript
import { SimpleTiledModel, loadTileset } from "wfc-ts";

const model = new SimpleTiledModel({ tileset, width: 48, height: 48, periodic: true });

for (const status of model.stepRun(12345, 0, 100, 1)) {
  if (status.done) {
    if (status.ok && status.complete) {
      console.log("Solved!");
    }
    break;
  }
  
  // Visualize: status.observedCell was just collapsed
  // Access model.result() for current state
  
  await new Promise(r => requestAnimationFrame(r));
}
```

The visualizer demonstrates:
- The stepRun generator API (H16)
- MRV (Minimum Remaining Values) cell selection
- Propagation reducing neighbor possibilities
- Real-time progress feedback

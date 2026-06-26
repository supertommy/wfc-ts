// 3D WFC Visualization Server
// Usage: bun run viz3d/server.ts
// Open http://localhost:3457

import { WFCSolver3D, type TileRule3D } from "../src/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3457;

// Pipes 3D tileset: 5 tiles with directional pipe constraints
// Tile 0: empty — background, connects to all tiles
// Tile 1: X-axis pipe — connects pipe/junction/empty on left/right, empty on others
// Tile 2: Y-axis pipe — connects pipe/junction/empty on up/down, empty on others
// Tile 3: Z-axis pipe — connects pipe/junction/empty on front/back, empty on others
// Tile 4: 6-way junction — connects to any pipe or junction or empty
const PIPES_RULES: TileRule3D[] = [
  { forTile: 0, left: [0, 1, 2, 3, 4], right: [0, 1, 2, 3, 4], up: [0, 1, 2, 3, 4], down: [0, 1, 2, 3, 4], front: [0, 1, 2, 3, 4], back: [0, 1, 2, 3, 4] },
  { forTile: 1, left: [0, 1, 4], right: [0, 1, 4], up: [0], down: [0], front: [0], back: [0] },
  { forTile: 2, left: [0], right: [0], up: [0, 2, 4], down: [0, 2, 4], front: [0], back: [0] },
  { forTile: 3, left: [0], right: [0], up: [0], down: [0], front: [0, 3, 4], back: [0, 3, 4] },
  { forTile: 4, left: [0, 1, 4], right: [0, 1, 4], up: [0, 2, 4], down: [0, 2, 4], front: [0, 3, 4], back: [0, 3, 4] },
];
const PIPES_WEIGHTS = [1, 1.5, 1.5, 1.5, 0.8];
const PIPES_COLORS = [0x333333, 0xff4444, 0x44ff44, 0x4488ff, 0xffdd00];
const PIPES_NAMES = ["empty", "pipe-X", "pipe-Y", "pipe-Z", "junction"];

interface TilesetConfig {
  name: string;
  rules: TileRule3D[];
  weights: number[];
  colors: number[];
  tileNames: string[];
}

const tilesets: Record<string, TilesetConfig> = {
  Pipes: {
    name: "Pipes",
    rules: PIPES_RULES,
    weights: PIPES_WEIGHTS,
    colors: PIPES_COLORS,
    tileNames: PIPES_NAMES,
  },
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API: Get tileset info
    if (url.pathname === "/api/tilesets") {
      const info: Record<string, { name: string; tiles: string[]; colors: number[] }> = {};
      for (const [key, ts] of Object.entries(tilesets)) {
        info[key] = {
          name: ts.name,
          tiles: ts.tileNames,
          colors: ts.colors,
        };
      }
      return Response.json(info);
    }

    // API: Run 3D solver (streaming via SSE)
    if (url.pathname === "/api/solve-3d") {
      const tilesetName = url.searchParams.get("tileset") || "Pipes";
      const width = parseInt(url.searchParams.get("width") || "4");
      const height = parseInt(url.searchParams.get("height") || "4");
      const depth = parseInt(url.searchParams.get("depth") || "4");
      const seed = parseInt(url.searchParams.get("seed") || "42");
      const periodic = url.searchParams.get("periodic") === "true";
      const yieldEvery = parseInt(url.searchParams.get("yieldEvery") || "1");

      const ts = tilesets[tilesetName];
      if (!ts) {
        return Response.json({ error: "Unknown tileset" }, { status: 400 });
      }

      const solver = new WFCSolver3D({
        width,
        height,
        depth,
        periodic,
        weights: ts.weights,
        rules: ts.rules,
        heuristic: "mrv",
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const startTime = performance.now();
          const count = width * height * depth;
          const T = ts.weights.length;

          // Access wave state for partial results
          const wave = solver.getWave();

          function getPartialResult(): number[] {
            const result: number[] = new Array(count);
            for (let i = 0; i < count; i++) {
              const base = i * T;
              let found = -1;
              let possible = 0;
              for (let t = 0; t < T; t++) {
                if (wave[base + t]) {
                  found = t;
                  possible++;
                  if (possible > 1) {
                    result[i] = -1;
                    break;
                  }
                }
              }
              if (possible === 1) result[i] = found;
              else result[i] = -1;
            }
            return result;
          }

          try {
            for (const status of solver.stepRun(seed, -1, 100, yieldEvery)) {
              const result =
                status.done && status.ok && status.complete
                  ? Array.from(solver.result())
                  : getPartialResult();

              const data = {
                done: status.done,
                observedCell: status.observedCell,
                attempt: status.attempt,
                cellsResolved: status.cellsResolved,
                ok: status.ok,
                complete: status.complete,
                elapsed: performance.now() - startTime,
                result,
              };

              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

              if (status.done) break;
            }
          } catch (e) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
            );
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // API: Run 3D solver (instant, returns full result)
    if (url.pathname === "/api/solve-3d-instant") {
      const tilesetName = url.searchParams.get("tileset") || "Pipes";
      const width = parseInt(url.searchParams.get("width") || "4");
      const height = parseInt(url.searchParams.get("height") || "4");
      const depth = parseInt(url.searchParams.get("depth") || "4");
      const seed = parseInt(url.searchParams.get("seed") || "42");
      const periodic = url.searchParams.get("periodic") === "true";

      const ts = tilesets[tilesetName];
      if (!ts) {
        return Response.json({ error: "Unknown tileset" }, { status: 400 });
      }

      const solver = new WFCSolver3D({
        width,
        height,
        depth,
        periodic,
        weights: ts.weights,
        rules: ts.rules,
        heuristic: "mrv",
      });

      const startTime = performance.now();
      const ok = solver.run(seed, -1, 100);
      const elapsed = performance.now() - startTime;

      return Response.json({
        ok,
        complete: ok,
        elapsed,
        result: ok ? Array.from(solver.result()) : null,
        width,
        height,
        depth,
      });
    }

    // Static files
    let filePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const fullPath = join(here, filePath);

    try {
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        return new Response(file);
      }
    } catch {}

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🌊 WFC 3D Visualizer running at http://localhost:${server.port}`);
console.log(`\nTilesets loaded:`);
for (const [key, ts] of Object.entries(tilesets)) {
  console.log(`  - ${key}: ${ts.tileNames.length} tiles (${ts.tileNames.join(", ")})`);
}
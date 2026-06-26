// 3D WFC Visualization Server
// Usage: bun run viz3d/server.ts
// Open http://localhost:3457

import { WFCSolver3D, type TileRule3D } from "../src/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3457;

// ─── Pipes tileset (connector / "socket" based) ────────────────────
// Each tile is defined by which of its 6 faces have a pipe opening.
// Face/direction order matches the 3D topology: 0=left 1=right 2=up
// 3=down 4=front 5=back.  Adjacency is GENERATED from the sockets by
// one rule: two tiles may sit face-to-face iff their touching faces
// agree — an opening must meet an opening, a wall must meet a wall.
// This guarantees every pipe segment connects to a real neighbour
// (no stubs dying into empty), so the network always reads as connected.
const OPP = [1, 0, 3, 2, 5, 4]; // opposite face of each direction

interface PipeTile {
  name: string;
  open: number[]; // 6 flags; 1 = pipe opening on that face
  weight: number;
  color: number;
}

function faces(...f: number[]): number[] {
  const m = [0, 0, 0, 0, 0, 0];
  for (const i of f) m[i] = 1;
  return m;
}

const PIPE_X_COLOR = 0xff5a6e; // red   — runs along X (left↔right)
const PIPE_Y_COLOR = 0x4ade80; // green — runs along Y (up↔down)
const PIPE_Z_COLOR = 0x49c5ff; // blue  — runs along Z (front↔back)
const EMPTY_COLOR = 0x333355;

// Straights-only socket family. Each pipe tile opens on one axis' two
// opposite faces, so an interior pipe forces the SAME pipe on both ends —
// continuous lines that span the volume edge-to-edge, never a stub dying
// into empty. This family is 100% solvable on this restart-only engine
// (richer caps/elbows/tees need backtracking the engine doesn't have).
function buildPipeTiles(): PipeTile[] {
  return [
    { name: "empty", open: faces(), weight: 1, color: EMPTY_COLOR },
    { name: "pipe-X", open: faces(0, 1), weight: 2, color: PIPE_X_COLOR },
    { name: "pipe-Y", open: faces(2, 3), weight: 2, color: PIPE_Y_COLOR },
    { name: "pipe-Z", open: faces(4, 5), weight: 2, color: PIPE_Z_COLOR },
  ];
}

function buildRulesFromTiles(tiles: PipeTile[]): TileRule3D[] {
  const dirKeys = ["left", "right", "up", "down", "front", "back"] as const;
  return tiles.map((tile, i) => {
    const rule = { forTile: i } as TileRule3D;
    for (let d = 0; d < 6; d++) {
      const allowed: number[] = [];
      for (let j = 0; j < tiles.length; j++) {
        // tile j sits on direction d of tile i; their touching faces are
        // tile i's face d and tile j's face OPP[d] — they must agree.
        if (tiles[j].open[OPP[d]] === tile.open[d]) allowed.push(j);
      }
      rule[dirKeys[d]] = allowed;
    }
    return rule;
  });
}

const PIPE_TILES = buildPipeTiles();
const PIPES_RULES = buildRulesFromTiles(PIPE_TILES);
const PIPES_WEIGHTS = PIPE_TILES.map((t) => t.weight);
const PIPES_COLORS = PIPE_TILES.map((t) => t.color);
const PIPES_NAMES = PIPE_TILES.map((t) => t.name);
const PIPES_SOCKETS = PIPE_TILES.map((t) => t.open);
const PIPES_LEGEND = [
  { name: "empty", color: EMPTY_COLOR },
  { name: "pipe-X (red)", color: PIPE_X_COLOR },
  { name: "pipe-Y (green)", color: PIPE_Y_COLOR },
  { name: "pipe-Z (blue)", color: PIPE_Z_COLOR },
];

interface TilesetConfig {
  name: string;
  rules: TileRule3D[];
  weights: number[];
  colors: number[];
  tileNames: string[];
  sockets: number[][];
  legend: { name: string; color: number }[];
}

const tilesets: Record<string, TilesetConfig> = {
  Pipes: {
    name: "Pipes",
    rules: PIPES_RULES,
    weights: PIPES_WEIGHTS,
    colors: PIPES_COLORS,
    tileNames: PIPES_NAMES,
    sockets: PIPES_SOCKETS,
    legend: PIPES_LEGEND,
  },
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API: Get tileset info
    if (url.pathname === "/api/tilesets") {
      const info: Record<string, { name: string; tiles: string[]; colors: number[]; sockets: number[][]; legend: { name: string; color: number }[] }> = {};
      for (const [key, ts] of Object.entries(tilesets)) {
        info[key] = {
          name: ts.name,
          tiles: ts.tileNames,
          colors: ts.colors,
          sockets: ts.sockets,
          legend: ts.legend,
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
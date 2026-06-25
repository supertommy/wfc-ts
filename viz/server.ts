/**
 * Visualization server - runs the actual WFC solver and streams results.
 * 
 * Usage: bun run viz/server.ts
 * Then open http://localhost:3000
 */

import { SimpleTiledModel, parseTileset, Heuristic, type StepStatus } from "../src-optimized/index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

// Load tilesets
function loadTileset(name: string) {
  const xmlPath = join(projectRoot, "performance-test/tilesets", `${name}.xml`);
  const xml = readFileSync(xmlPath, "utf-8");
  return parseTileset(xml, name);
}

const tilesets = {
  Knots: loadTileset("Knots"),
  Circuit: loadTileset("Circuit"),
  Rooms: loadTileset("Rooms"),
  Summer: loadTileset("Summer"),
};

// Default subsets to match canonical mxgmn behavior
const defaultSubsets: Record<string, string | null> = {
  Knots: "Standard",
  Circuit: "Turnless",
  Rooms: null,
  Summer: null,
};

// Build tile info by creating a model and extracting expanded tilenames
function buildTileInfo(tileset: ReturnType<typeof parseTileset>, subsetName: string | null) {
  const model = new SimpleTiledModel({
    tileset,
    subsetName,
    width: 2,
    height: 2,
    periodic: true,
  });
  
  // Parse expanded tilenames like "corner 0", "corner 1", etc.
  return {
    tiles: model.tilenames.map((name: string) => {
      const parts = name.split(" ");
      const baseName = parts[0];
      const rotation = parseInt(parts[1] || "0", 10);
      return { name: baseName, rotation };
    }),
    T: model.T,
    subset: subsetName,
  };
}

const tileInfo = {
  Knots: buildTileInfo(tilesets.Knots, defaultSubsets.Knots),
  Circuit: buildTileInfo(tilesets.Circuit, defaultSubsets.Circuit),
  Rooms: buildTileInfo(tilesets.Rooms, defaultSubsets.Rooms),
  Summer: buildTileInfo(tilesets.Summer, defaultSubsets.Summer),
};

// Serve static files and API
const server = Bun.serve({
  port: 3456,
  async fetch(req) {
    const url = new URL(req.url);
    
    // API: Get tileset info
    if (url.pathname === "/api/tilesets") {
      return Response.json({
        Knots: tileInfo.Knots,
        Circuit: tileInfo.Circuit,
        Rooms: tileInfo.Rooms,
        Summer: { ...tileInfo.Summer, unique: tilesets.Summer.unique },
      });
    }
    
    // API: Run solver (streaming)
    if (url.pathname === "/api/solve") {
      const tilesetName = url.searchParams.get("tileset") || "Knots";
      const width = parseInt(url.searchParams.get("width") || "24");
      const height = parseInt(url.searchParams.get("height") || "24");
      const seed = parseInt(url.searchParams.get("seed") || "12345");
      const subset = url.searchParams.get("subset");
      const periodic = url.searchParams.get("periodic") !== "false";
      const yieldEvery = parseInt(url.searchParams.get("yieldEvery") || "1");
      
      const tileset = tilesets[tilesetName as keyof typeof tilesets];
      if (!tileset) {
        return Response.json({ error: "Unknown tileset" }, { status: 400 });
      }
      
      // Use default subset if none provided
      const effectiveSubset = subset ?? defaultSubsets[tilesetName] ?? null;
      
      const model = new SimpleTiledModel({
        tileset,
        subsetName: effectiveSubset,
        width,
        height,
        periodic,
        heuristic: Heuristic.MRV,
      });
      
      // Stream results using Server-Sent Events
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const startTime = performance.now();
          
          // Access model internals to get partial state
          // @ts-expect-error - accessing private for viz
          const wave: Uint8Array = model.wave;
          // @ts-expect-error - accessing private for viz
          const T: number = model.T;
          // @ts-expect-error - accessing private for viz  
          const sumsOfOnes: Uint8Array = model.sumsOfOnes;
          const count = width * height;
          
          function getPartialResult(): number[] {
            const result: number[] = [];
            for (let i = 0; i < count; i++) {
              if (sumsOfOnes[i] === 1) {
                // Collapsed - find which tile
                const base = i * T;
                for (let t = 0; t < T; t++) {
                  if (wave[base + t]) {
                    result.push(t);
                    break;
                  }
                }
              } else {
                result.push(-1); // Not yet collapsed
              }
            }
            return result;
          }
          
          try {
            for (const status of model.stepRun(seed, -1, 100, yieldEvery)) {
              const result = status.done && status.ok && status.complete 
                ? Array.from(model.result()) 
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
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
          }
          
          controller.close();
        },
      });
      
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    
    // API: Run canonical mxgmn solver and return PNG
    if (url.pathname === "/api/canonical") {
      const tilesetName = url.searchParams.get("tileset") || "Knots";
      const width = parseInt(url.searchParams.get("width") || "24");
      const height = parseInt(url.searchParams.get("height") || "24");
      const seed = parseInt(url.searchParams.get("seed") || "12345");
      const subset = url.searchParams.get("subset");
      const periodic = url.searchParams.get("periodic") !== "false";
      
      console.log(`[canonical] tileset=${tilesetName} size=${width}x${height} seed=${seed} periodic=${periodic} subset=${subset}`);
      
      // Use default subset if none provided
      const effectiveSubset = subset ?? defaultSubsets[tilesetName] ?? null;
      
      const canonicalDir = join(projectRoot, "../references/WaveFunctionCollapse");
      const samplesPath = join(canonicalDir, "samples.xml");
      const outputDir = join(canonicalDir, "output");
      
      // Create samples.xml for this specific case
      const subsetAttr = effectiveSubset ? `subset="${effectiveSubset}"` : "";
      const samplesXml = `<samples>
  <simpletiled name="${tilesetName}" ${subsetAttr} width="${width}" height="${height}" periodic="${periodic ? "True" : "False"}" seed="${seed}" screenshots="1"/>
</samples>`;
      
      const originalSamples = readFileSync(samplesPath, "utf-8");
      
      try {
        writeFileSync(samplesPath, samplesXml);
        
        // Clean output dir
        if (existsSync(outputDir)) {
          for (const file of readdirSync(outputDir)) {
            unlinkSync(join(outputDir, file));
          }
        } else {
          mkdirSync(outputDir);
        }
        
        // Run canonical
        execSync("dotnet run -c Release", {
          cwd: canonicalDir,
          timeout: 30000,
          stdio: "pipe",
        });
        
        // Find output PNG
        const files = readdirSync(outputDir);
        const pngFile = files.find(f => f.endsWith(".png"));
        
        if (pngFile) {
          const png = readFileSync(join(outputDir, pngFile));
          writeFileSync(samplesPath, originalSamples);
          console.log(`[canonical] Success: ${pngFile} (${png.length} bytes)`);
          return new Response(png, {
            headers: { 
              "Content-Type": "image/png",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        
        writeFileSync(samplesPath, originalSamples);
        console.log(`[canonical] Error: No output generated`);
        return Response.json({ error: "No output generated" }, { status: 500 });
      } catch (e) {
        writeFileSync(samplesPath, originalSamples);
        console.log(`[canonical] Error: ${e}`);
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }
    
    // API: Run solver (instant, returns full result)
    if (url.pathname === "/api/solve-instant") {
      const tilesetName = url.searchParams.get("tileset") || "Knots";
      const width = parseInt(url.searchParams.get("width") || "24");
      const height = parseInt(url.searchParams.get("height") || "24");
      const seed = parseInt(url.searchParams.get("seed") || "12345");
      const subset = url.searchParams.get("subset");
      const periodic = url.searchParams.get("periodic") !== "false";
      
      const tileset = tilesets[tilesetName as keyof typeof tilesets];
      if (!tileset) {
        return Response.json({ error: "Unknown tileset" }, { status: 400 });
      }
      
      // Use default subset if none provided
      const effectiveSubset = subset ?? defaultSubsets[tilesetName] ?? null;
      
      const model = new SimpleTiledModel({
        tileset,
        subsetName: effectiveSubset,
        width,
        height,
        periodic,
        heuristic: Heuristic.MRV,
      });
      
      const startTime = performance.now();
      const complete = model.run(seed, -1, 100);
      const elapsed = performance.now() - startTime;
      
      return Response.json({
        ok: complete,
        complete,
        elapsed,
        result: complete ? Array.from(model.result()) : null,
        width,
        height,
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

console.log(`🌊 WFC Visualizer running at http://localhost:${server.port}`);
console.log(`\nTilesets loaded (with default subsets):`);
console.log(`  - Knots: ${tileInfo.Knots.T} tiles (subset: ${tileInfo.Knots.subset})`);
console.log(`  - Circuit: ${tileInfo.Circuit.T} tiles (subset: ${tileInfo.Circuit.subset})`);
console.log(`  - Rooms: ${tileInfo.Rooms.T} tiles (subset: ${tileInfo.Rooms.subset})`);

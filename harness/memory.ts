// Memory-footprint metric — the gate for the memory-efficiency axis.
//
// Reports the optimized solver's typed-array working-set bytes (via
// Model.footprintBytes(), which sums actual .byteLength so it stays correct as
// the layout changes — e.g. bitpacking the wave, narrowing compatible). Memory-
// axis candidates (bitpacked wave, narrow compatible fields, sparse live-set,
// arena recycling) are judged here: footprint before vs after, with no speed
// regression and VALID+DET preserved.
//
// Trusted: lives in harness/ (optimizers may not edit it). CLI:
//   bun run harness/memory.ts [specName]   (all committed inputs if omitted)

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadInputSpec, tilesetXml } from "./io.js";

const here = dirname(fileURLToPath(import.meta.url));
const optEntry = pathToFileURL(join(here, "..", "src-optimized", "index.ts")).href;

const ALL = [
  "knots-standard-24",
  "knots-standard-48",
  "knots-fabric-24",
  "knots-dense-24",
  "circuit-turnless-34",
  "rooms-30",
];

if (import.meta.main) {
  const [specName] = process.argv.slice(2);
  const names = specName ? [specName] : ALL;
  const mod = await import(optEntry);
  console.log("MEMORY-FOOTPRINT (optimized typed-array working set, construction state)");
  console.log("input                        bytes        KB");
  for (const n of names) {
    const spec = loadInputSpec(n);
    const xml = tilesetXml(spec.tileset);
    const tileset = mod.parseTileset(xml, spec.tileset);
    const model = new mod.SimpleTiledModel({
      tileset,
      subsetName: spec.subset,
      width: spec.width,
      height: spec.height,
      periodic: spec.periodic,
    });
    // init() runs lazily inside run(); force it so arrays are allocated.
    model.run(spec.seed, spec.limit);
    const bytes = model.footprintBytes();
    console.log(`${n.padEnd(28)} ${String(bytes).padStart(10)}  ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
}
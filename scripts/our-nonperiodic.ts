import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseTileset } from "../src-optimized/tileset.js";
import { SimpleTiledModel } from "../src-optimized/simple-tiled-model.js";
const here = dirname(fileURLToPath(import.meta.url));
const xml = (n: string) => readFileSync(join(here, "..", "performance-test", "tilesets", `${n}.xml`), "utf8");
const med = (a: number[]) => { const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
// non-periodic Knots, matching three-wfc's non-periodic runs
const cases: Array<[string,string|null,number]> = [["Knots","Standard",24],["Knots","Standard",48],["Knots","Fabric",24],["Knots","Dense",24]];
for (const [tileset, subset, w] of cases) {
  const ts = parseTileset(xml(tileset), tileset);
  const m = new SimpleTiledModel({ tileset: ts, subsetName: subset, width: w, height: w, periodic: false });
  m.run(1, -1); // warmup
  const times: number[] = [];
  let ok = true;
  for (let i = 0; i < 5; i++) { const t0=performance.now(); ok = m.run(1+i, -1); times.push(performance.now()-t0); }
  console.log(`${tileset} ${subset} ${w}x${w} non-periodic: our=${med(times).toFixed(2)}ms ok=${ok}`);
}

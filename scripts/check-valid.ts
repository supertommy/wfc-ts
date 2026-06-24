import { readFileSync } from "node:fs";
import { SimpleTiledModel, parseTileset } from "../src/index.js";

const xml = readFileSync(new URL("../performance-test/tilesets/Knots.xml", import.meta.url), "utf8");
const ts = parseTileset(xml, "Knots");

// Use the model's OWN propagator to self-check (not the independent validator,
// just a port sanity check). Verify every observed neighbor is allowed.
class Probe extends SimpleTiledModel {
  get propagator_() { return this.propagator; }
  get MX_() { return this.MX; }
  get MY_() { return this.MY; }
}

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

let totalViolations = 0;
const cases: Array<[string, number, boolean]> = [
  ["Standard", 24, true],
  ["Dense", 24, true],
  ["Crossless", 24, false],
  ["C", 24, true],
  ["Fabric", 24, true],
];
for (const [subset, size, periodic] of cases) {
  const m = new Probe({ tileset: ts, subsetName: subset, width: size, height: size, periodic });
  const ok = m.run(7, -1);
  if (!ok || !m.isComplete()) {
    console.log(`${subset}: did NOT complete (ok=${ok}, complete=${m.isComplete()})`);
    continue;
  }
  const obs = m.result();
  const prop = m.propagator_;
  const MX = m.MX_, MY = m.MY_;
  let subViol = 0;
  let checks = 0;
  for (let y = 0; y < MY; y++) {
    for (let x = 0; x < MX; x++) {
      const i = x + y * MX;
      const t1 = obs[i];
      for (let d = 0; d < 4; d++) {
        let x2 = x + DX[d], y2 = y + DY[d];
        if (periodic) {
          x2 = (x2 + MX) % MX;
          y2 = (y2 + MY) % MY;
        } else {
          if (x2 < 0 || y2 < 0 || x2 >= MX || y2 >= MY) continue;
        }
        const t2 = obs[x2 + y2 * MX];
        checks++;
        if (!prop[d][t1].includes(t2)) subViol++;
      }
    }
  }
  totalViolations += subViol;
  console.log(`${subset} (${size}x${size} periodic=${periodic}): ${subViol} violations / ${checks} adjacency checks`);
}
console.log(`\nTotal violations across all subsets: ${totalViolations}`);
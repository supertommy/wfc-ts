// The MATCH gate: optimized output must byte-match the reference output for an
// identical committed input (same seed => same mulberry32 sequence => same
// collapse sequence => identical observed[]). This is the gate that catches a
// propagation reorder that silently changes which cell collapses next, or any
// change that alters the deterministic result.
//
// "Faster is not bit-identical" applies in reverse here: the optimized solver
// IS required to be bit-identical (deterministic), so checksum equality is the
// contract — unlike the collision repo where contact points are certified for
// validity, not matched. WFC has no analogous degree of freedom: the collapse
// sequence fully determines the output.

import { readResultMeta } from "./io.js";

export interface CompareReport {
  pass: boolean;
  name: string;
  okMatch: boolean;
  completeMatch: boolean;
  checksumMatch: boolean;
  refChecksum: string;
  optChecksum: string;
}

export function compareResults(refPath: string, optPath: string): CompareReport {
  const ref = readResultMeta(refPath);
  const opt = readResultMeta(optPath);
  const okMatch = ref.ok === opt.ok;
  const completeMatch = ref.complete === opt.complete;
  const checksumMatch = ref.checksum === opt.checksum && ref.checksum !== "";
  return {
    pass: okMatch && completeMatch && checksumMatch,
    name: opt.name || ref.name,
    okMatch,
    completeMatch,
    checksumMatch,
    refChecksum: ref.checksum,
    optChecksum: opt.checksum,
  };
}

// CLI: compare.ts <refResult> <optResult>
if (import.meta.main) {
  const [refPath, optPath] = process.argv.slice(2);
  if (!refPath || !optPath) {
    console.error("usage: compare.ts <refResult> <optResult>");
    process.exit(2);
  }
  const r = compareResults(refPath, optPath);
  const status = r.pass ? "PASS" : "FAIL";
  console.log(
    `COMPARE ${r.name}: ${status} | ok ${r.okMatch ? "==" : "!="} | complete ${r.completeMatch ? "==" : "!="} | checksum ${r.checksumMatch ? "==" : "!="}`,
  );
  if (!r.checksumMatch) {
    console.log(`  ref checksum:  ${r.refChecksum}`);
    console.log(`  opt checksum:  ${r.optChecksum}`);
  }
  process.exit(r.pass ? 0 : 1);
}
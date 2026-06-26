// Deterministic PRNG contract for wfc-ts.
//
// mxgmn's C# reference uses System.Random(seed). We do NOT replicate C#'s
// subtractive generator — it has subtle .NET-Framework-vs-Core divergences and
// the exact sequence is incidental to the WFC algorithm. Instead we standardize
// on mulberry32: tiny, seedable, and the SAME sequence in both the reference
// (src/) and the optimized solver (src-optimized/). That sameness is what makes
// the match contract sharp: identical seed + input => byte-identical output.
//
// The only interface the algorithm needs is nextDouble() in [0, 1), matching
// the two call sites in mxgmn's Model (entropy noise + weighted collapse pick).

export interface Random {
  /** Returns the next double in [0, 1). Deterministic for a given seed. */
  nextDouble(): number;
}

/**
 * mulberry32 — a 32-bit seedable PRNG. Deterministic across runtimes that
 * implement IEEE-754 double arithmetic and integer-multiply-as-32-bit the same
 * way (V8, JSC, SpiderMonkey all do). Returns a closure matching `Random`.
 */
export function mulberry32(seed: number): Random {
  // We keep the internal state in a closure-local so callers can't perturb it.
  let a = seed >>> 0;

  function nextDouble(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return { nextDouble };
}
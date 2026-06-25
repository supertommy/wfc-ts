// Optimized Model — the WFC observation/propagation core.
// Copyright (C) 2016 Maxim Gumin, MIT. Faithful port for wfc-ts, then optimized
// under the ratchet. This is NOT the reference (src/model.ts); it is the
// optimized solver that the harness measures and gates.
//
// HYPOTHESIS 1 (kept): flatten `wave` and `compatible` to typed arrays (SoA).
//
//   The reference stored `wave: boolean[][]` and `compatible: number[][][]`
//   (arrays-of-arrays-of-arrays). The propagation hot loop — the dominant cost
//   on the larger-T inputs (66-78% on circuit/rooms per the profile) — did
//   `compatible[i2][t2][d]--`, chasing three JS array objects per access: cache-
//   hostile and allocation-heavy. This change flattens both into single typed
//   arrays indexed arithmetically:
//     wave      -> Uint8Array  of length count*T,        wave[i*T + t]
//     compatible-> Int32Array of length count*T*4,      compatible[i*T4 + t*4 + d]
//   Same counts, same decrements, same bans, same selection sequence — so the
//   output is unchanged (valid AND byte-identical to the reference). The win is
//   cache locality + zero object indirection in the inner loop. (Mike Acton
//   DOD: indices over references, SoA over AoS, data layout as first-class.)
//
// HYPOTHESIS 2 (kept): flatten `propagator` to flat CSR typed arrays.
//
//   propagator[d][t1] was a number[][] list of allowed t2. In propagate() hot
//   path and in clear() .length checks we chased two array objects per access.
//   CSR layout: one Int32Array propData (concat all lists, d then t1 order),
//   plus propStart/propLen indexed by (d*T + t1). Build once in ctor (untimed).
//   Same lists + same iteration order over t2 => byte-identical outputs.
//   Targets propagation-bound inputs (circuit/rooms). Pure layout, Tier-1.
//
// HYPOTHESIS 4 (this iteration): heap-based entropy selection (O(log n) extract-min).
//
//   Replace the O(cells) full-grid scan in nextUnobservedNode (83% on knots-48)
//   with a binary min-heap (typed arrays + keyToPos) over unobserved cells.
//   Key = entropies[i] (or sumsOfOnes for MRV); deterministic tie-break by
//   smaller cell index on equal priority. NO noise in selection (PRNG used only
//   in observe's weightedPick). init/clear build heap; ban does decrease-key or
//   remove on collapse. nextUnobserved uses lazy delete for any stale pops.
//   Tier-2 (algorithmic): changes collapse ORDER, so compare* FAIL is EXPECTED
//   and not a regression; gate is only VALID + DET. Ported pattern from
//   references/three-wfc/lib/WFCMinHeap.ts .
//
// HYPOTHESIS 6: reduce heap decrease-key cost on ban path via batching.
//
//   Ban is now #2 cost (26-31%). Every ban did an immediate O(log) update/remove.
//   Especially costly on large-T (circuit T=36, ~40k bans/run). Batch: ban only
//   appends cell to a dirty list (no sift). Flush (coalesced via gen#) runs once
//   before each extract-min: only distinct dirtied cells since last observe pay
//   the sift. Observe (T-1 bans to 1 cell) and per-wave bans now cost O(1) heap
//   ops. Flush before pop keeps selection semantics identical (no mid-batch extract).
//   Tier-2 (same as H4) but in practice preserves collapse order vs pre-H6.
//
// HYPOTHESIS 10: preliminary-action pruning — cache the clear() fixpoint.
//
//   clear() does the full reset + boundary bans + initial propagate fixpoint + heap
//   rebuild on EVERY run(seed). The state after bans+propagate (wave/compat/sums*/entropies/observed)
//   is a deterministic function of (grid+tileset+periodic+ground) — NO seed dependence
//   (mulberry32 created after clear in run()). Cache it once after first clear's work;
//   later clears restore via fast typed-array .set() instead of recomputing bans+prop.
//   (TRIZ P.10: perform the preliminary action in advance.) Heap rebuild left in place
//   (O(cells) cheap relative to the O(C*T + bans) work saved). Speed primary axis; extra
//   memory for the snapshot copy is ACCEPTABLE. Outputs identical to before (same start
//   state for given seed) so compare* status is unchanged. Gate on VALID+DET.
//
// PRNG: mulberry32, same as the reference (deterministic contract).

import { mulberry32, type Random } from "./prng.js";
import { EntropyHeap } from "./entropy-heap.js";

export const enum Heuristic {
  Entropy = 0,
  MRV = 1,
  Scanline = 2,
}

const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];
const OPPOSITE = [2, 3, 0, 1];

export abstract class Model {
  protected MX = 0;
  protected MY = 0;
  protected T = 0;
  protected T4 = 0; // T*4 — compatible-array stride (per cell)
  protected count = 0; // MX*MY — number of cells
  protected N = 1;
  protected periodic = false;
  protected ground = false;

  // Flattened wave: wave[i*T + t] is 1 while variant t is still possible at cell i.
  protected wave: Uint8Array = new Uint8Array(0);
  // Flattened propagator (CSR): propData concatenated lists (d outer, t1 inner),
  // propStart/propLen indexed d*T + t1. Same order as old lists => byte-id.
  protected propData: Int32Array = new Int32Array(0);
  protected propStart: Int32Array = new Int32Array(0);
  protected propLen: Int32Array = new Int32Array(0);
  // Flattened AC-4 support counts: compatible[i*T4 + t*4 + d]. Hits 0 => ban.
  protected compatible: Int32Array = new Int32Array(0);
  protected observed: Int32Array = new Int32Array(0);

  protected stackI: Int32Array = new Int32Array(0);
  protected stackT: Int32Array = new Int32Array(0);
  protected stacksize = 0;
  protected observedSoFar = 0;

  protected weights: Float64Array = new Float64Array(0);
  protected weightLogWeights: Float64Array = new Float64Array(0);
  protected distribution: Float64Array = new Float64Array(0);

  protected sumsOfOnes: Int32Array = new Int32Array(0);
  protected sumsOfWeights: Float64Array = new Float64Array(0);
  protected sumsOfWeightLogWeights: Float64Array = new Float64Array(0);
  protected entropies: Float64Array = new Float64Array(0);

  // H4 heap for O(log n) selection of next cell to observe (Entropy/MRV).
  // Rebuilt in clear(); updated via ban().
  protected entropyHeap: EntropyHeap | null = null;

  // H6: batching for heap updates (coalesce per-cell bans into one decrease-key/remove per phase)
  // Dirty list populated in ban(); flushed (with dedup) in nextUnobservedNode before extract.
  protected dirtyHeapCells: Int32Array = new Int32Array(0);
  protected dirtyCount = 0;
  protected heapUpdateGen: Uint32Array = new Uint32Array(0);
  protected heapGen = 0;

  // H10: cached post-clear fixpoint state (wave + compatible + sums + entropies + observed)
  // after boundary bans + initial propagate (the maximally-pruned start state for this
  // grid+tileset). Restored via .set() in clear(); captured once after first full clear.
  // Deterministic (seed-independent). Heap left to rebuild each clear.
  protected wave0: Uint8Array = new Uint8Array(0);
  protected compatible0: Int32Array = new Int32Array(0);
  protected sumsOfOnes0: Int32Array = new Int32Array(0);
  protected sumsOfWeights0: Float64Array = new Float64Array(0);
  protected sumsOfWeightLogWeights0: Float64Array = new Float64Array(0);
  protected entropies0: Float64Array = new Float64Array(0);
  protected observed0: Int32Array = new Int32Array(0);
  protected hasFixpoint = false;

  protected sumOfWeights = 0;
  protected sumOfWeightLogWeights = 0;
  protected startingEntropy = 0;

  protected heuristic: Heuristic = Heuristic.Entropy;

  protected constructor(width: number, height: number, N: number, periodic: boolean, heuristic: Heuristic) {
    this.MX = width;
    this.MY = height;
    this.N = N;
    this.periodic = periodic;
    this.heuristic = heuristic;
  }

  protected init(): void {
    const count = this.MX * this.MY;
    const T = this.T;
    const T4 = T * 4;
    this.count = count;
    this.T4 = T4;

    // wave: all 1 (everything possible). compatible: filled by clear().
    this.wave = new Uint8Array(count * T); // zeroed; clear() sets the valid cells to 1
    this.compatible = new Int32Array(count * T4);
    this.distribution = new Float64Array(T);
    this.observed = new Int32Array(count);

    this.weightLogWeights = new Float64Array(T);
    this.sumOfWeights = 0;
    this.sumOfWeightLogWeights = 0;
    for (let t = 0; t < T; t++) {
      const w = this.weights[t];
      const wlw = w * Math.log(w);
      this.weightLogWeights[t] = wlw;
      this.sumOfWeights += w;
      this.sumOfWeightLogWeights += wlw;
    }
    this.startingEntropy = Math.log(this.sumOfWeights) - this.sumOfWeightLogWeights / this.sumOfWeights;

    this.sumsOfOnes = new Int32Array(count);
    this.sumsOfWeights = new Float64Array(count);
    this.sumsOfWeightLogWeights = new Float64Array(count);
    this.entropies = new Float64Array(count);

    this.entropyHeap = new EntropyHeap(count);

    const stackCap = count * T;
    this.stackI = new Int32Array(stackCap);
    this.stackT = new Int32Array(stackCap);
    this.stacksize = 0;

    // H6 batch dirty list (reused cap sufficient; distinct dirtied << bans per phase)
    this.dirtyHeapCells = new Int32Array(stackCap);
    this.dirtyCount = 0;
    this.heapUpdateGen = new Uint32Array(count);
    this.heapGen = 0;

    // H10 snapshot buffers (same size as live; populated at end of first clear)
    this.wave0 = new Uint8Array(count * T);
    this.compatible0 = new Int32Array(count * T4);
    this.sumsOfOnes0 = new Int32Array(count);
    this.sumsOfWeights0 = new Float64Array(count);
    this.sumsOfWeightLogWeights0 = new Float64Array(count);
    this.entropies0 = new Float64Array(count);
    this.observed0 = new Int32Array(count);
    this.hasFixpoint = false;
  }

  run(seed: number, limit: number): boolean {
    if (this.count === 0) this.init();
    this.clear();

    const random: Random = mulberry32(seed);
    const limitNeg = limit < 0;

    for (let l = 0; limitNeg || l < limit; l++) {
      const node = this.nextUnobservedNode(random);
      if (node >= 0) {
        this.observe(node, random);
        const success = this.propagate();
        if (!success) return false;
      } else {
        // No unobserved node remains: every cell has collapsed to one variant.
        const { wave, T, observed, count } = this;
        for (let i = 0; i < count; i++) {
          const base = i * T;
          for (let t = 0; t < T; t++) {
            if (wave[base + t]) {
              observed[i] = t;
              break;
            }
          }
        }
        return true;
      }
    }
    return true;
  }

  private nextUnobservedNode(random: Random): number {
    const { heuristic } = this;
    if (heuristic === Heuristic.Scanline) {
      for (let i = this.observedSoFar; i < this.count; i++) {
        if (!this.periodic && (i % this.MX + this.N > this.MX || ((i / this.MX) | 0) + this.N > this.MY)) continue;
        if (this.sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    // H4: O(log n) via heap. Lazy deletion for collapsed/stale entries.
    // Deterministic: no noise; on equal priority, lower cell index wins.
    // (PRNG is no longer consumed here; only in observe weightedPick.)
    // H6: flush batched updates first so the min reflects all bans since prior extract.
    this.flushHeapUpdates();
    const heap = this.entropyHeap;
    if (!heap) return -1;
    const { sumsOfOnes, entropies } = this;
    while (!heap.isEmpty()) {
      const entry = heap.popEntry();
      if (!entry) break;
      const i = entry.key;
      if (sumsOfOnes[i] <= 1) continue;
      const currPrio = heuristic === Heuristic.Entropy ? entropies[i] : sumsOfOnes[i];
      if (entry.entropy !== currPrio) continue; // stale (from prior higher value)
      return i;
    }
    return -1;
  }

  private observe(node: number, random: Random): void {
    const { wave, distribution: dist, weights, T } = this;
    const base = node * T;
    for (let t = 0; t < T; t++) {
      dist[t] = wave[base + t] ? weights[t] : 0;
    }
    const r = weightedPick(dist, random.nextDouble());
    for (let t = 0; t < T; t++) {
      if (wave[base + t] !== (t === r ? 1 : 0)) this.ban(node, t);
    }
  }

  private propagate(): boolean {
    const { propData, propStart, propLen, compatible, stackI, stackT, MX, MY, N, periodic, T4, T } = this;
    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      const x1 = i1 % MX;
      const y1 = (i1 / MX) | 0;

      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX[d];
        let y2 = y1 + DY[d];
        if (!periodic && (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > MY)) continue;

        if (x2 < 0) x2 += MX;
        else if (x2 >= MX) x2 -= MX;
        if (y2 < 0) y2 += MY;
        else if (y2 >= MY) y2 -= MY;

        const i2 = x2 + y2 * MX;
        const key = d * T + t1;
        const start = propStart[key];
        const len = propLen[key];
        const base2 = i2 * T4;

        for (let l = 0; l < len; l++) {
          const t2 = propData[start + l];
          const cidx = base2 + t2 * 4 + d;
          if (--compatible[cidx] === 0) this.ban(i2, t2);
        }
      }
    }
    return this.sumsOfOnes[0] > 0;
  }

  protected ban(i: number, t: number): void {
    const base = i * this.T;
    this.wave[base + t] = 0;

    const cbase = i * this.T4 + t * 4;
    this.compatible[cbase] = 0;
    this.compatible[cbase + 1] = 0;
    this.compatible[cbase + 2] = 0;
    this.compatible[cbase + 3] = 0;
    this.stackI[this.stacksize] = i;
    this.stackT[this.stacksize] = t;
    this.stacksize++;

    this.sumsOfOnes[i] -= 1;
    this.sumsOfWeights[i] -= this.weights[t];
    this.sumsOfWeightLogWeights[i] -= this.weightLogWeights[t];

    const sum = this.sumsOfWeights[i];
    this.entropies[i] = Math.log(sum) - this.sumsOfWeightLogWeights[i] / sum;

    // H6: mark cell dirty for *batched* heap update (coalesces multiple bans to same cell
    // into a single decrease-key/remove). No per-ban sift cost. Flush applies before next extract.
    // (See flushHeapUpdates + nextUnobservedNode.)
    const h = this.entropyHeap;
    if (h) {
      this.dirtyHeapCells[this.dirtyCount++] = i;
    }
  }

  /**
   * H6: flush all dirtied cells to the heap with coalesced update/remove.
   * Called before extract-min so that selection sees up-to-date priorities.
   * Dedups via heapGen so a cell banned N times since last flush pays only 1 sift.
   */
  private flushHeapUpdates(): void {
    const h = this.entropyHeap;
    if (!h || this.dirtyCount === 0) return;

    this.heapGen = (this.heapGen + 1) | 0;
    if (this.heapGen === 0) {
      this.heapGen = 1;
      this.heapUpdateGen.fill(0);
    }
    const g = this.heapGen;
    const gens = this.heapUpdateGen;
    const { sumsOfOnes, entropies, heuristic } = this;

    for (let k = 0; k < this.dirtyCount; k++) {
      const i = this.dirtyHeapCells[k];
      if (gens[i] === g) continue; // coalesced
      gens[i] = g;

      if (sumsOfOnes[i] <= 1) {
        h.remove(i);
      } else {
        const prio = (heuristic === Heuristic.Entropy ? entropies[i] : sumsOfOnes[i]);
        if (!h.update(i, prio)) {
          h.push(i, prio);
        }
      }
    }
    this.dirtyCount = 0;
  }

  protected clear(): void {
    const { wave, compatible, propStart, propLen, weights, T, T4, count } = this;

    if (this.hasFixpoint) {
      // H10: restore the cached post-clear fixpoint via fast typed-array copy.
      // Same starting state as after first clear's bans+prop => identical behavior.
      this.wave.set(this.wave0);
      this.compatible.set(this.compatible0);
      this.sumsOfOnes.set(this.sumsOfOnes0);
      this.sumsOfWeights.set(this.sumsOfWeights0);
      this.sumsOfWeightLogWeights.set(this.sumsOfWeightLogWeights0);
      this.entropies.set(this.entropies0);
      this.observed.set(this.observed0);
      this.observedSoFar = 0;
      this.stacksize = 0;
      // heap rebuild + dirty reset fall through below (always executed)
    } else {
      for (let i = 0; i < count; i++) {
        const wbase = i * T;
        const cbase = i * T4;
        for (let t = 0; t < T; t++) {
          wave[wbase + t] = 1;
          // support count = how many patterns the opposite-direction neighbor
          // lists as compatible with t (i.e. patterns that can sit on the d side).
          const ct = cbase + t * 4;
          compatible[ct] = propLen[OPPOSITE[0] * T + t];
          compatible[ct + 1] = propLen[OPPOSITE[1] * T + t];
          compatible[ct + 2] = propLen[OPPOSITE[2] * T + t];
          compatible[ct + 3] = propLen[OPPOSITE[3] * T + t];
        }

        this.sumsOfOnes[i] = weights.length;
        this.sumsOfWeights[i] = this.sumOfWeights;
        this.sumsOfWeightLogWeights[i] = this.sumOfWeightLogWeights;
        this.entropies[i] = this.startingEntropy;
        this.observed[i] = -1;
      }
      this.observedSoFar = 0;

      // Ban patterns with no compatible neighbor in some direction at the
      // boundary (when not periodic). Mirrors mxgmn's Clear no-neighbor bans.
      const { MX, MY, N, periodic } = this;
      for (let y = 0; y < MY; y++) {
        for (let x = 0; x < MX; x++) {
          if (!periodic && (x + N > MX || y + N > MY)) continue;

          const i = x + y * MX;
          const wbase = i * T;
          for (let t = 0; t < T; t++) {
            const noRight = (periodic || x < MX - N) && propLen[2 * T + t] === 0;
            const noTop = (periodic || y > 0) && propLen[3 * T + t] === 0;
            const noLeft = (periodic || x > 0) && propLen[0 * T + t] === 0;
            const noBottom = (periodic || y < MY - N) && propLen[1 * T + t] === 0;

            if (noRight || noTop || noLeft || noBottom) this.ban(i, t);
          }
        }
      }

      if (this.ground) {
        for (let x = 0; x < MX; x++) {
          const bottom = x + (MY - 1) * MX;
          const wbot = bottom * T;
          for (let t = 0; t < T - 1; t++) if (this.wave[wbot + t]) this.ban(bottom, t);
          for (let y = 0; y < MY - 1; y++) {
            const i = x + y * MX;
            if (this.wave[i * T + (T - 1)]) this.ban(i, T - 1);
          }
        }
      }

      if (this.stacksize > 0) this.propagate();

      // H10: capture the post-fixpoint state (after all bans + propagate).
      // This is the pruned starting point for any run of this model.
      this.wave0.set(this.wave);
      this.compatible0.set(this.compatible);
      this.sumsOfOnes0.set(this.sumsOfOnes);
      this.sumsOfWeights0.set(this.sumsOfWeights);
      this.sumsOfWeightLogWeights0.set(this.sumsOfWeightLogWeights);
      this.entropies0.set(this.entropies);
      this.observed0.set(this.observed);
      this.hasFixpoint = true;
    }

    // H4: after restore-or-compute of the fixpoint, (re)build the heap
    // containing exactly the cells eligible for selection (pass the N-boundary
    // filter) that still have sumsOfOnes > 1. Uses current entropies (or counts).
    // H6: reset batching state after rebuild.
    // H10: heap rebuild kept (cheap O(cells)); the expensive fill+ban+prop is now elided on reuse.
    const h = this.entropyHeap;
    if (h) {
      h.clear();
      const { MX, MY, N, periodic, sumsOfOnes, entropies, heuristic } = this;
      for (let i = 0; i < this.count; i++) {
        if (!periodic && (i % MX + N > MX || ((i / MX) | 0) + N > MY)) continue;
        if (sumsOfOnes[i] > 1) {
          const prio = heuristic === Heuristic.Entropy ? entropies[i] : sumsOfOnes[i];
          h.push(i, prio);
        }
      }
    }
    this.dirtyCount = 0;
    if (this.heapUpdateGen.length) this.heapUpdateGen.fill(0);
    this.heapGen = 0;
  }

  result(): Int32Array {
    return this.observed;
  }

  /**
   * Total bytes of the typed-array working set the solver allocates (wave,
   * compatible, propagator CSR, stacks, sums, heap, batch buffers). Read-only,
   * self-maintaining (sums actual .byteLength) so it stays correct as the data
   * layout changes (e.g. bitpacking). The memory-axis gate (harness/memory.ts)
   * uses this to judge memory-efficiency candidates. Excludes the tileset/weights
   * definition (shared, untimed) and the observed[] output buffer (count*4, fixed).
   */
  footprintBytes(): number {
    let bytes = 0;
    bytes += this.wave.byteLength;
    bytes += this.compatible.byteLength;
    bytes += this.propData.byteLength;
    bytes += this.propStart.byteLength;
    bytes += this.propLen.byteLength;
    bytes += this.stackI.byteLength;
    bytes += this.stackT.byteLength;
    bytes += this.dirtyHeapCells.byteLength;
    bytes += this.heapUpdateGen.byteLength;
    bytes += this.distribution.byteLength;
    bytes += this.weightLogWeights.byteLength;
    bytes += this.sumsOfOnes.byteLength;
    bytes += this.sumsOfWeights.byteLength;
    bytes += this.sumsOfWeightLogWeights.byteLength;
    bytes += this.entropies.byteLength;
    bytes += this.observed.byteLength;
    // H10: include snapshot copy (wave/compat/sums/ent/obs) so memory measurement reflects real delta
    bytes += this.wave0.byteLength;
    bytes += this.compatible0.byteLength;
    bytes += this.sumsOfOnes0.byteLength;
    bytes += this.sumsOfWeights0.byteLength;
    bytes += this.sumsOfWeightLogWeights0.byteLength;
    bytes += this.entropies0.byteLength;
    bytes += this.observed0.byteLength;
    if (this.entropyHeap) bytes += this.entropyHeap.footprintBytes();
    return bytes;
  }

  isComplete(): boolean {
    const { sumsOfOnes, count } = this;
    for (let i = 0; i < count; i++) {
      if (sumsOfOnes[i] !== 1) return false;
    }
    return true;
  }
}

/**
 * Weighted pick over a distribution: returns the index i where the running sum
 * of `values` first reaches r * total. Direct port of mxgmn's Helper.Random.
 */
export function weightedPick(values: Float64Array | number[], r: number): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const threshold = r * sum;

  let partialSum = 0;
  for (let i = 0; i < values.length; i++) {
    partialSum += values[i];
    if (partialSum >= threshold) return i;
  }
  return 0;
}
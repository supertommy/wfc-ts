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
//   CSR layout: one (now auto-narrowed H26: Uint8/16/32) propData (concat all lists, d then t1 order),
//   plus propStart/propLen indexed by (d*T + t1). Build once in ctor (untimed).
//   Same lists + same iteration order over t2 => byte-identical outputs.
//   Targets propagation-bound inputs (circuit/rooms). Pure layout, Tier-1.
//   H26 narrows propData (inner read) + propLen for 4x cache on the read in decrement loop.
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
// HYPOTHESIS 12: restart-with-derived-seeds on contradiction (no undo stack).
//
//   Hard inputs contradict on some seeds (knots-dense-24: 5% pre-H12). With sub-ms
//   solves (H10 made clear() a cheap .set()), N restarts are cheap vs backtracking
//   (no undo stack, memory-free). On contradiction restart with deterministically-
//   derived seed for k>=1. Attempt 0 ALWAYS uses the passed `seed` directly (no
//   derivation) so committed prove-harness seeds (first-try complete) are identical
//   to pre-H12 => DET and compare* status unchanged. deriveRestartSeed(base,k) is
//   pure (32-bit mulberry-style mix) => run(seed,limit,budget) is deterministic
//   under the extended contract. Default budget=100 (sensible, >=1) so success-rate
//   callers get restarts; speed callers on committed seeds unaffected. Success axis
//   (target >=99% dense); speed must not regress (speed ranks above success).
//   Tier-2; gate VALID+DET (re-runs with same default budget must match).
//
// HYPOTHESIS 23 (this iteration): compatible Int32→narrow (Uint8 for T<256) — cache-speed win on the propagation wall.
//
//   The `--compatible[cidx]; if (===0) ban` decrement loop is the 60-66% cost on
//   circuit/rooms (the wall). H5/H8/H15 attacked algorithmically and REVERTED.
//   H23 attacks via CACHE: counts ≤T; our tilesets T<256 → fits in Uint8 exactly.
//   4× smaller compatible (+ its H10 snapshot) → 4× less cache pressure on hot loop
//   → fewer misses → faster. AUTO-SELECT: max(propLen) <256?Uint8:<65536?Uint16:Int32.
//   Store ctor+bpe. Underflow safe: ban zeros slots; post-ban decrs ≤T<256 never
//   wrap 0→255... back to 0. Tier-1 (identical counts → byte-id outputs).
//   footprintBytes sums .byteLength → auto reports the win.
//
// H26 (prior): apply identical cache-narrow to propData (READ in inner t2=propData[start+l] loop),
//   propLen, (optionally propStart). No underflow arithmetic on ids (pure reads); auto by T.
// H27 (prior): narrow propagation stack (stackT by T, stackI/dirty by count) + dirty list.
//   ~3× smaller stack family (Uint8+2×Uint16 vs 3×Int32). Memory win primary; pop in propagate
//   gets marginal cache benefit (one read/iter). Stack empty at H10 snapshot. Tier-1 (ids same).
// H28 (this): narrow sumsOfOnes/sumsOfOnes0 (MRV counts ≤T<256→Uint8). Completes
//   ideation-2 set (H23/26/27/28). Heap prio reads (not prop inner); tiny mem win if no-reg. Tier-1.
//
// H31 (this): precomputed neighbor table (Int32Array(count*4)) — speed win on propagate outer loop (85%+ wall).
//   The outer loop (per pop, per dir) computes i2 via x2/y2 + N-OOB test + wrap + mul (~8-10 ops).
//   Build neighbors[i*4+d] = i2 or -1 ONCE in init(); use `const i2=neighbors[i1*4+d]; if(i2<0)continue;`.
//   Exact semantics (N-test etc); Tier-1; mem +16B/count accepted (speed>mem). Clear untouched (~1%).
//
// PRNG: mulberry32, same as the reference (deterministic contract).

import { mulberry32, type Random } from "./prng.js";
import { EntropyHeap } from "./entropy-heap.js";

export const enum Heuristic {
  Entropy = 0,
  MRV = 1,
  Scanline = 2,
}

/**
 * Progress / result status yielded by stepRun().
 * - While running (done:false): emitted every `yieldEvery` observes; includes the
 *   just-observed cell and current resolved count. Callers (e.g. visualizers) can
 *   inspect solver state (wave, sumsOfOnes, etc.) between yields.
 * - At end (done:true): `ok` is the same boolean run() would return; `complete` is
 *   true only if the grid fully collapsed (no limit/budget abort).
 *
 * Cancellation:
 * - Natural: stop calling .next() / break from for-of / call gen.return().
 * - AbortSignal (optional, portable): checked at yield points; no DOM/Node dep
 *   in core (AbortSignal is web standard, present in Node + browsers).
 *
 * Example (step every observe, browser-friendly):
 *   const gen = model.stepRun(seed, -1, 100, 1, signal);
 *   for (const st of gen) {
 *     if (st.done) { if (st.ok) renderFinal(model.result()); break; }
 *     // partial viz: read model.sumsOfOnes / wave / etc. here
 *     await new Promise(r => requestAnimationFrame(r)); // caller schedules
 *   }
 * run() is unchanged (drains internally with huge yieldEvery to keep fast path hot).
 */
export interface StepStatus {
  done: boolean;
  /** Cell index just observed (only on done:false yields from an observe step). */
  observedCell?: number;
  attempt: number;
  cellsResolved: number;
  /** Only present on done:true yields. */
  ok?: boolean;
  complete?: boolean;
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
  // H26: auto-narrowed (propData by max id T<256→Uint8; propLen by len≤T→Uint8; propStart offsets
  // may Uint16 for totals<65536 on our grids). propData READ in propagate inner loop.
  // prop* built once in subclass ctor (tileset-const); H10 snapshots do not touch them.
  protected propData: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  protected propStart: Uint16Array | Int32Array = new Int32Array(0);
  protected propLen: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  // Flattened AC-4 support counts: compatible[i*T4 + t*4 + d]. Hits 0 => ban.
  // H23: auto-narrowed (Uint8/16/Int32 chosen in init by maxPropLen); --/===0 identical.
  protected compatible: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  protected observed: Int32Array = new Int32Array(0);

  // H31: precomputed neighbor table. neighbors[i*4 + d] = i2 (wrapped) or -1 (non-periodic OOB).
  // Built once in init after MX/MY/N/periodic/count known; grid+periodic dependent so constant
  // across runs (never part of H10 clear fixpoint snapshot). Replaces per-iter wrap arithmetic
  // in propagate's outer loop (the 85%+ wall on circuit/rooms). Int32 -1 sentinel for simplicity
  // and generality (correct even if count>=65536). Tier-1; mem growth accepted.
  protected neighbors: Int32Array = new Int32Array(0);

  // H27: auto-narrowed (stackT by T<256→Uint8; stackI+dirty by count<65536→Uint16).
  // Pushed on ban, popped in propagate inner (cache win marginal; memory main). Tier-1.
  protected stackI: Uint16Array | Int32Array = new Int32Array(0);
  protected stackT: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  protected stacksize = 0;
  protected observedSoFar = 0;

  protected weights: Float64Array = new Float64Array(0);
  protected weightLogWeights: Float64Array = new Float64Array(0);
  protected distribution: Float64Array = new Float64Array(0);

  // H28: auto-narrowed (by T<256→Uint8 exact) like H23 compatible / H26 prop / H27 stack.
  // MRV key (H22). Monotonic decr T	o0; never underflows below 0 (ban only on live).
  protected sumsOfOnes: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  protected sumsOfWeights: Float64Array = new Float64Array(0);
  protected sumsOfWeightLogWeights: Float64Array = new Float64Array(0);
  protected entropies: Float64Array = new Float64Array(0);

  // H4 heap for O(log n) selection of next cell to observe (Entropy/MRV).
  // Rebuilt in clear(); updated via ban().
  protected entropyHeap: EntropyHeap | null = null;

  // H6: batching for heap updates (coalesce per-cell bans into one decrease-key/remove per phase)
  // Dirty list populated in ban(); flushed (with dedup) in nextUnobservedNode before extract.
  protected dirtyHeapCells: Uint16Array | Int32Array = new Int32Array(0);
  protected dirtyCount = 0;
  protected heapUpdateGen: Uint32Array = new Uint32Array(0);
  protected heapGen = 0;

  // H23: chosen narrow ctor + bytes-per-element for compatible (and compatible0).
  // Stored so we can new the matching type for snapshots and report if needed.
  protected CompatibleCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  protected compatibleBpe = 4;

  // H26: chosen narrow ctors for propData (ids <T), propLen (lens ≤T), propStart (offsets <total).
  // Stored for symmetry with H23 + potential future use (e.g. reports). prop* created in
  // subclass ctor using these; never recreated in init() or H10 (tileset-constant, not snapshotted).
  protected PropDataCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  protected PropLenCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  protected PropStartCtor: Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;

  // H27: chosen narrow ctors for stackT (pattern ids ≤T), stackI (cell ids ≤count),
  // dirtyHeapCells (same as stackI). Mirror H23/H26 auto-select in init(). Stored for
  // symmetry + reports. Allocated in init() (cap=count*T els); .byteLength auto-shrinks fp.
  // Stack drained (size=0) at H10 clear fixpoint snapshot → no content-snap impact.
  protected StackTCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  protected StackICtor: Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;
  protected DirtyHeapCellsCtor: Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;

  // H28: chosen narrow ctor for sumsOfOnes (live counts ≤T) + sumsOfOnes0 snapshot.
  // Mirror H23/H26/H27: T<256 → Uint8Array (exact for knots/circuit/rooms); else Uint16/Int32.
  // Stored for alloc in init() + reports. .byteLength auto for fp. Tier-1 (completes
  // ideation-2 narrowing set). Read as heap prio (H22 MRV); decr in ban; <=1 checks;
  // .set() restore/capture. Heap itself keeps Float64 prios.
  protected SumsOfOnesCtor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor = Int32Array;

  // H10: cached post-clear fixpoint state (wave + compatible + sums + entropies + observed)
  // after boundary bans + initial propagate (the maximally-pruned start state for this
  // grid+tileset). Restored via .set() in clear(); captured once after first full clear.
  // Deterministic (seed-independent). Heap left to rebuild each clear.
  protected wave0: Uint8Array = new Uint8Array(0);
  // H23: same auto-narrowed type as the live compatible (chosen at init).
  protected compatible0: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
  // H28: same auto-narrowed type as live sumsOfOnes (chosen at init by T).
  protected sumsOfOnes0: Uint8Array | Uint16Array | Int32Array = new Int32Array(0);
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

    // H23: auto-select narrowest safe integer array type for compatible counts.
    // maxPropLen = longest propagator list (≤ T). <256 → Uint8 (our tilesets),
    // <65536 → Uint16, else Int32. Post-ban underflow-wrap is safe: #post-ban
    // decrs to a 0-slot ≤ T <256 → never reaches 0 again (unlike Int32 going neg).
    // This shrinks the hot decrement array 4× → less cache pressure on prop wall.
    // (H26: propLen itself auto-narrowed at build by same T<256 rule; v read as number.)
    {
      let maxPropLen = 0;
      for (let i = 0; i < this.propLen.length; i++) {
        const v = this.propLen[i];
        if (v > maxPropLen) maxPropLen = v;
      }
      if (maxPropLen < 256) {
        this.CompatibleCtor = Uint8Array;
        this.compatibleBpe = 1;
      } else if (maxPropLen < 65536) {
        this.CompatibleCtor = Uint16Array;
        this.compatibleBpe = 2;
      } else {
        this.CompatibleCtor = Int32Array;
        this.compatibleBpe = 4;
      }
    }

    // H27: auto-select narrowest for stackT (by T), stackI + dirtyHeapCells (by count).
    // T<256 → Uint8 for stackT (exact); count<65536 → Uint16 for I/dirty (our grids).
    // Mirrors H23/H26. No arith on stored ids → safe. Affects live only (H10 stacksize=0).
    {
      this.StackTCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
      this.StackICtor = count < 65536 ? Uint16Array : Int32Array;
      this.DirtyHeapCellsCtor = count < 65536 ? Uint16Array : Int32Array;
    }

    // H28: auto-select narrowest for sumsOfOnes (live option counts ≤T) + sumsOfOnes0.
    // T<256 → Uint8Array (exact, all committed tilesets); <65536→Uint16 else Int32.
    // Mirrors H23/H26/H27 exactly. Monotonic decr never <0. Affects live + H10 snapshot.
    // Read for heap prio in nextUnobs/flush; decr in ban; init= T; .set() copies; <=1 tests.
    // Tiny array (~count*1B); marginal read cost (heap not prop inner); free mem if no-reg.
    {
      this.SumsOfOnesCtor = T < 256 ? Uint8Array : T < 65536 ? Uint16Array : Int32Array;
    }

    // H31: build neighbor table ONCE (after count/MX/MY/N/periodic known).
    // Replicates the *exact* current i2 computation used in propagate (incl. the N-based
    // out-of-bounds test for !periodic before wrapping). Sentinel -1 for invalid dirs.
    this.neighbors = new Int32Array(count * 4);
    {
      const { MX, MY, N, periodic } = this;
      for (let i = 0; i < count; i++) {
        const x1 = i % MX;
        const y1 = (i / MX) | 0;
        for (let d = 0; d < 4; d++) {
          let x2 = x1 + DX[d];
          let y2 = y1 + DY[d];
          let nei: number;
          if (!periodic && (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > MY)) {
            nei = -1;
          } else {
            if (x2 < 0) x2 += MX;
            else if (x2 >= MX) x2 -= MX;
            if (y2 < 0) y2 += MY;
            else if (y2 >= MY) y2 -= MY;
            nei = x2 + y2 * MX;
          }
          this.neighbors[i * 4 + d] = nei;
        }
      }
    }

    // wave: all 1 (everything possible). compatible: filled by clear().
    this.wave = new Uint8Array(count * T); // zeroed; clear() sets the valid cells to 1
    this.compatible = new this.CompatibleCtor(count * T4);
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

    this.sumsOfOnes = new this.SumsOfOnesCtor(count);
    this.sumsOfWeights = new Float64Array(count);
    this.sumsOfWeightLogWeights = new Float64Array(count);
    this.entropies = new Float64Array(count);

    this.entropyHeap = new EntropyHeap(count);

    const stackCap = count * T;
    this.stackI = new this.StackICtor(stackCap);
    this.stackT = new this.StackTCtor(stackCap);
    this.stacksize = 0;

    // H6 batch dirty list (reused cap sufficient; distinct dirtied << bans per phase)
    this.dirtyHeapCells = new this.DirtyHeapCellsCtor(stackCap);
    this.dirtyCount = 0;
    this.heapUpdateGen = new Uint32Array(count);
    this.heapGen = 0;

    // H10 snapshot buffers (same size as live; populated at end of first clear)
    this.wave0 = new Uint8Array(count * T);
    this.compatible0 = new this.CompatibleCtor(count * T4);
    this.sumsOfOnes0 = new this.SumsOfOnesCtor(count);
    this.sumsOfWeights0 = new Float64Array(count);
    this.sumsOfWeightLogWeights0 = new Float64Array(count);
    this.entropies0 = new Float64Array(count);
    this.observed0 = new Int32Array(count);
    this.hasFixpoint = false;
  }

  run(seed: number, limit: number, restartBudget = 100): boolean {
    if (this.count === 0) this.init();

    for (let attempt = 0; attempt <= restartBudget; attempt++) {
      this.clear();
      const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
      const random: Random = mulberry32(s);
      const limitNeg = limit < 0;

      let contradicted = false;
      for (let l = 0; limitNeg || l < limit; l++) {
        const node = this.nextUnobservedNode(random);
        if (node >= 0) {
          this.observe(node, random);
          const success = this.propagate();
          if (!success) {
            contradicted = true;
            break;
          }
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
      if (!contradicted) {
        // Limit reached without contradiction (preserve original behavior).
        return true;
      }
      // contradicted: clear + retry with derived seed (if attempts remain)
    }
    return false;
  }

  /**
   * Generator form of the run loop (H16): yields a StepStatus every `yieldEvery`
   * observes so callers can step/visualize/schedule without blocking (e.g. rAF chunks
   * in browser). The loop body is intentionally duplicated from run() so the
   * synchronous fast path (used by harness, measure-speedup, success-rate) has
   * zero generator or yield-check overhead and remains bit-identical in perf.
   *
   * For any (seed, limit, restartBudget), driving stepRun to completion produces
   * IDENTICAL collapse sequence and final observed[] as run() (hence same VALID+DET).
   *
   * Cancellation: break / return() / or pass AbortSignal (checked at each yield point).
   * Portable (AbortSignal is standard, no scheduler or DOM APIs in the solver).
   *
   * run() is untouched (see above).
   */
  *stepRun(
    seed: number,
    limit: number,
    restartBudget = 100,
    yieldEvery = 1,
    signal: AbortSignal | null = null
  ): Generator<StepStatus> {
    if (this.count === 0) this.init();

    let totalObserves = 0;
    for (let attempt = 0; attempt <= restartBudget; attempt++) {
      this.clear();
      const s = attempt === 0 ? seed : deriveRestartSeed(seed, attempt);
      const random: Random = mulberry32(s);
      const limitNeg = limit < 0;

      let contradicted = false;
      for (let l = 0; limitNeg || l < limit; l++) {
        const node = this.nextUnobservedNode(random);
        if (node >= 0) {
          this.observe(node, random);
          const success = this.propagate();
          totalObserves++;

          const cellsResolved = this.countResolved();

          if (signal && signal.aborted) {
            yield { done: true, ok: false, complete: false, attempt, cellsResolved, observedCell: node };
            return;
          }

          if (yieldEvery > 0 && (totalObserves % yieldEvery === 0)) {
            yield { done: false, observedCell: node, attempt, cellsResolved };
          }

          if (!success) {
            contradicted = true;
            break;
          }
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
          const cellsResolved = this.count;
          yield { done: true, ok: true, complete: true, attempt, cellsResolved };
          return;
        }
      }
      if (!contradicted) {
        // Limit reached without contradiction (preserve original behavior).
        const cellsResolved = this.countResolved();
        const complete = this.isComplete();
        yield { done: true, ok: true, complete, attempt, cellsResolved };
        return;
      }
      // contradicted: clear + retry with derived seed (if attempts remain)
      if (signal && signal.aborted) {
        yield { done: true, ok: false, complete: false, attempt, cellsResolved: this.countResolved() };
        return;
      }
    }
    yield { done: true, ok: false, complete: false, attempt: restartBudget, cellsResolved: this.countResolved() };
  }

  /**
   * O(count) scan for progress reporting in the steppable path (H16).
   * Only called on yield points (visualizer cadence or when yieldEvery is small),
   * never in the run() hot path.
   */
  protected countResolved(): number {
    let c = 0;
    const sums = this.sumsOfOnes;
    for (let i = 0; i < this.count; i++) if (sums[i] <= 1) c++;
    return c;
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
    const { propData, propStart, propLen, compatible, stackI, stackT, neighbors, T4, T } = this;
    while (this.stacksize > 0) {
      this.stacksize--;
      const i1 = stackI[this.stacksize];
      const t1 = stackT[this.stacksize];

      for (let d = 0; d < 4; d++) {
        const i2 = neighbors[i1 * 4 + d];
        if (i2 < 0) continue;

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
    // H22: sumsOfWeights / sumsOfWeightLogWeights / entropies (the Math.log(plogp) recompute)
    // are ONLY needed for Heuristic.Entropy selection. Under default MRV we use sumsOfOnes
    // for the heap priority; guard to eliminate the per-ban log cost entirely (was ~8-12%
    // of ban in H8 subprof). sumsOfOnes and the H6 dirty-mark MUST always run (MRV uses them).
    // weights[]/weightLogWeights[] stay allocated (observe() builds dist from wave+weights).
    if (this.heuristic === Heuristic.Entropy) {
      this.sumsOfWeights[i] -= this.weights[t];
      this.sumsOfWeightLogWeights[i] -= this.weightLogWeights[t];

      const sum = this.sumsOfWeights[i];
      this.entropies[i] = Math.log(sum) - this.sumsOfWeightLogWeights[i] / sum;
    }

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
   * H27: stack* + dirty now narrower via ctors; .byteLength auto-reflects the shrink.
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
    bytes += this.neighbors.byteLength; // H31
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

/**
 * deriveRestartSeed (H12) — pure, deterministic 32-bit mixer.
 *
 * Same (baseSeed, k) ALWAYS produces the same output. Used for restart attempts
 * k >= 1 so that the restart sequence is reproducible: run(s, L, B) twice yields
 * identical sequence of attempts and thus identical final output (DET holds for
 * the (seed, budget) contract). We use a finalizer-style mix (inspired by
 * splitmix32 / murmur finalizer, using constants also present in mulberry32)
 * to scramble base ^ (k * golden) into a well-distributed u32 seed.
 *
 * Attempt 0 is deliberately the raw `seed` (no call to this) — this preserves
 * exact pre-H12 behavior for any first-try success, so committed harness seeds
 * and speed measurements are unchanged.
 *
 * Not exported; internal to the restart logic in run().
 */
function deriveRestartSeed(baseSeed: number, k: number): number {
  let z = ((baseSeed >>> 0) ^ ((k * 0x9e3779b9) >>> 0)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x85ebca6b) >>> 0;
  z = (z ^ (z >>> 13)) >>> 0;
  z = Math.imul(z, 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return z;
}

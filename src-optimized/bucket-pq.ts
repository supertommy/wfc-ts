// bucket-pq.ts — bucket (Dial's) priority queue for small-integer MRV keys (sumsOfOnes in 1..T).
// O(1) amortized extract-min + update/remove via buckets[1..T] holding doubly-linked cell lists.
// Deterministic tie-break: popMin returns the *lowest cell index* among cells in the min bucket.
// Matches EntropyHeap's composite (prio, cellIndex) behavior exactly when prio==sumsOfOnes.
// Only used for Heuristic.MRV (the default per H22). Entropy heuristic keeps using EntropyHeap.
// Tier-2 overall (from H4) but selection-identical to heap-MRV => byte-id outputs vs post-H31.

export class BucketPQ {
  private readonly bucketHead: Int32Array; // head cell for each bucket 0..maxPrio; -1 = empty
  private readonly cellNext: Int32Array;
  private readonly cellPrev: Int32Array;
  private readonly cellBucket: Int32Array; // which bucket this cell is in, or -1 if not queued
  private minBucket: number;
  private readonly maxPrio: number;

  constructor(maxCount: number, maxPrio: number) {
    this.maxPrio = maxPrio;
    this.bucketHead = new Int32Array(maxPrio + 1).fill(-1);
    this.cellNext = new Int32Array(maxCount).fill(-1);
    this.cellPrev = new Int32Array(maxCount).fill(-1);
    this.cellBucket = new Int32Array(maxCount).fill(-1);
    this.minBucket = maxPrio + 1;
  }

  isEmpty(): boolean {
    this.advanceMin();
    return this.minBucket > this.maxPrio;
  }

  /**
   * Remove and return the min cell index (lowest i among those with current min sumsOfOnes).
   * null if no live cells remain.
   */
  popMin(): number | null {
    this.advanceMin();
    if (this.minBucket > this.maxPrio) return null;

    const b = this.minBucket;
    // scan the (short) list for the smallest cell index to match heap tie-break
    let minCell = -1;
    let cur = this.bucketHead[b];
    while (cur !== -1) {
      if (minCell < 0 || cur < minCell) minCell = cur;
      cur = this.cellNext[cur];
    }
    if (minCell < 0) {
      this.bucketHead[b] = -1;
      this.minBucket++;
      return null;
    }

    this.unlink(minCell);
    return minCell;
  }

  /**
   * Move cell to the bucket corresponding to its current prio (sumsOfOnes value),
   * or remove it if prio <=1. Called from coalesced flush for H6-style batching.
   */
  updateCell(i: number, prio: number): void {
    const oldB = this.cellBucket[i];
    if (prio <= 1 || prio > this.maxPrio) {
      if (oldB !== -1) this.unlink(i);
      return;
    }
    const newB = prio | 0;
    if (oldB === newB) return;
    if (oldB !== -1) this.unlink(i);
    this.link(i, newB);
  }

  clear(): void {
    this.bucketHead.fill(-1);
    this.cellNext.fill(-1);
    this.cellPrev.fill(-1);
    this.cellBucket.fill(-1);
    this.minBucket = this.maxPrio + 1;
  }

  /** Bytes of the four typed arrays backing the bucket structure. */
  footprintBytes(): number {
    return (
      this.bucketHead.byteLength +
      this.cellNext.byteLength +
      this.cellPrev.byteLength +
      this.cellBucket.byteLength
    );
  }

  private advanceMin(): void {
    while (this.minBucket <= this.maxPrio && this.bucketHead[this.minBucket] === -1) {
      this.minBucket++;
    }
  }

  private link(i: number, b: number): void {
    const head = this.bucketHead[b];
    this.cellNext[i] = head;
    this.cellPrev[i] = -1;
    if (head !== -1) {
      this.cellPrev[head] = i;
    }
    this.bucketHead[b] = i;
    this.cellBucket[i] = b;
    if (b < this.minBucket) {
      this.minBucket = b;
    }
  }

  private unlink(i: number): void {
    const b = this.cellBucket[i];
    if (b === -1) return;

    const p = this.cellPrev[i];
    const n = this.cellNext[i];
    if (p !== -1) {
      this.cellNext[p] = n;
    } else {
      this.bucketHead[b] = n;
    }
    if (n !== -1) {
      this.cellPrev[n] = p;
    }
    this.cellNext[i] = -1;
    this.cellPrev[i] = -1;
    this.cellBucket[i] = -1;
    // minBucket advanced lazily on next isEmpty/pop
  }
}

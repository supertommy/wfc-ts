// entropy-heap.ts — binary min-heap over typed arrays for O(log n) cell selection by entropy (or MRV count).
// Ported from references/three-wfc/lib/WFCMinHeap.ts , adapted for:
// - Float64Array priorities (to match our entropies)
// - deterministic tie-break: on equal priority, smaller cell index wins (no PRNG noise)
// - popEntry() to support lazy stale-entry discard in nextUnobservedNode
//
// Used only for Heuristic.Entropy (and MRV); Scanline stays linear.
// This is the H4 change: replaces O(cells) scan with heap. Tier-2 (sequence changes).

const ROOT_INDEX = 1;

export class EntropyHeap {
  private readonly keys: Uint32Array;
  private readonly entropy: Float64Array;
  private readonly keyToPos: Int32Array;

  private count: number;

  /**
   * Creates a new min-heap. Keys are cell indices [0, maxCount-1].
   * @param maxCount maximum number of distinct keys.
   */
  constructor(maxCount: number) {
    this.count = 0;
    this.keys = new Uint32Array(maxCount + ROOT_INDEX);
    this.entropy = new Float64Array(maxCount + ROOT_INDEX);
    this.keyToPos = new Int32Array(maxCount).fill(-1);
  }

  get size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Current priority for key, or +Inf if not present.
   */
  read(key: number): number {
    const pos = this.keyToPos[key];
    return pos !== -1 ? this.entropy[pos] : Number.POSITIVE_INFINITY;
  }

  /**
   * Insert new key with priority. Caller ensures not already present (or use put).
   */
  push(key: number, priority: number): void {
    const newPos = this.count + ROOT_INDEX;
    this.keys[newPos] = key;
    this.entropy[newPos] = priority;
    this.keyToPos[key] = newPos;
    this.count++;
    this.bubbleUp(newPos);
  }

  /**
   * Insert or update.
   */
  put(key: number, priority: number): void {
    if (!this.update(key, priority)) this.push(key, priority);
  }

  /**
   * Update priority of existing key. Returns true if present (and moved).
   */
  update(key: number, newPriority: number): boolean {
    const pos = this.keyToPos[key];
    if (pos === -1) return false;

    this.entropy[pos] = newPriority;

    const parentIndex = pos >>> 1;
    if (pos > ROOT_INDEX && this.lessThan(pos, parentIndex)) {
      this.bubbleUp(pos);
    } else {
      this.bubbleDown(pos);
    }
    return true;
  }

  /**
   * Remove and return min key. null if empty.
   */
  pop(): number | null {
    if (!this.count) {
      return null;
    }

    const minKey = this.keys[ROOT_INDEX];
    this.keyToPos[minKey] = -1;

    if (this.count > 1) {
      const lastPos = this.count + ROOT_INDEX - 1;
      const lastKey = this.keys[lastPos];

      this.keys[ROOT_INDEX] = lastKey;
      this.entropy[ROOT_INDEX] = this.entropy[lastPos];
      this.keyToPos[lastKey] = ROOT_INDEX;

      this.count--;

      this.bubbleDown(ROOT_INDEX);
    } else {
      this.count--;
    }

    return minKey;
  }

  /**
   * Pop the min entry (key + its stored priority at time of pop).
   * Used for lazy stale detection in WFC nextUnobservedNode.
   */
  popEntry(): { key: number; entropy: number } | null {
    if (!this.count) {
      return null;
    }

    const minKey = this.keys[ROOT_INDEX];
    const minEnt = this.entropy[ROOT_INDEX];
    this.keyToPos[minKey] = -1;

    if (this.count > 1) {
      const lastPos = this.count + ROOT_INDEX - 1;
      const lastKey = this.keys[lastPos];

      this.keys[ROOT_INDEX] = lastKey;
      this.entropy[ROOT_INDEX] = this.entropy[lastPos];
      this.keyToPos[lastKey] = ROOT_INDEX;

      this.count--;

      this.bubbleDown(ROOT_INDEX);
    } else {
      this.count--;
    }

    return { key: minKey, entropy: minEnt };
  }

  peek(): number | false {
    return this.count !== 0 && this.entropy[ROOT_INDEX];
  }

  peekKey(): number | false {
    return this.count !== 0 && this.keys[ROOT_INDEX];
  }

  remove(key: number): boolean {
    const pos = this.keyToPos[key];
    if (pos === -1) {
      return false;
    }

    this.keyToPos[key] = -1;

    const lastPos = this.count + ROOT_INDEX - 1;

    if (pos === lastPos) {
      this.count--;
    } else if (this.count > 1) {
      const lastKey = this.keys[lastPos];
      const lastEntropy = this.entropy[lastPos];

      this.keys[pos] = lastKey;
      this.entropy[pos] = lastEntropy;
      this.keyToPos[lastKey] = pos;

      this.count--;

      const parentIndex = pos >>> 1;
      if (pos > ROOT_INDEX && this.lessThan(pos, parentIndex)) {
        this.bubbleUp(pos);
      } else {
        this.bubbleDown(pos);
      }
    } else {
      this.count--;
    }

    return true;
  }

  clear(): void {
    this.count = 0;
    this.keyToPos.fill(-1);
  }

  /** Bytes of the heap's typed arrays (keys + entropy + keyToPos). */
  footprintBytes(): number {
    return this.keys.byteLength + this.entropy.byteLength + this.keyToPos.byteLength;
  }

  /** True if entry at index a should come before entry at b (min-heap). */
  private lessThan(a: number, b: number): boolean {
    const pa = this.entropy[a];
    const pb = this.entropy[b];
    if (pa !== pb) return pa < pb;
    // deterministic tie-break: lower cell index wins
    return this.keys[a] < this.keys[b];
  }

  private swap(i: number, j: number): void {
    const keys = this.keys;
    const entropy = this.entropy;
    const keyToPos = this.keyToPos;

    const key_i = keys[i];
    const key_j = keys[j];
    const entropy_i = entropy[i];
    const entropy_j = entropy[j];

    keys[i] = key_j;
    keys[j] = key_i;
    entropy[i] = entropy_j;
    entropy[j] = entropy_i;

    keyToPos[key_i] = j;
    keyToPos[key_j] = i;
  }

  private bubbleUp(index: number): void {
    while (index > ROOT_INDEX) {
      const parentIndex = index >>> 1;
      if (!this.lessThan(index, parentIndex)) {
        break;
      }
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const heapSize = this.count + ROOT_INDEX;

    while (true) {
      const leftChildIdx = index << 1;
      const rightChildIdx = leftChildIdx + 1;
      let swapCandidateIdx = -1;

      if (leftChildIdx < heapSize && this.lessThan(leftChildIdx, index)) {
        swapCandidateIdx = leftChildIdx;
      }

      if (rightChildIdx < heapSize) {
        const comparisonIdx = swapCandidateIdx === -1 ? index : swapCandidateIdx;
        if (this.lessThan(rightChildIdx, comparisonIdx)) {
          swapCandidateIdx = rightChildIdx;
        }
      }

      if (swapCandidateIdx === -1) {
        break;
      }

      this.swap(index, swapCandidateIdx);
      index = swapCandidateIdx;
    }
  }
}

/// <reference types="@webgpu/types" />

// GPU propagation backend (Stage 1).
// Ports the PROVEN fused parallel-AC-4 kernel + diameter-dispatch amortized-1-readback
// loop from scripts/webgpu-prototype-v2.ts into a clean, typed, reusable module.
//
// - Constructor allocates GPU buffers + pipeline ONCE for a (tileset+grid+periodic) problem.
// - propagate() uploads per-run wave/compatible state + seeds worklist, runs the fixed
//   number of dispatches with ping-pong worklists, does ONE final readback, returns
//   updated wave + compatible (as Uint8Arrays to match CPU narrow layout) + ok flag.
// - Kernel and dispatch logic are bitwise mirrors of the v2 prototype (atomicSub prev==1
//   CAS-claim + zero-4-compats + append). See CPU Model.propagate + ban for semantics.
// - diameter = max(MX,MY) when periodic; MX+MY (safe manhattan bound) when not.
// - The module is additive/opt-in: not imported by src-optimized/index.ts.
// - Strict TS, plain WebGPU + JS, no debug code in the committed module.
//
// Correctness is enforced by the sibling gate script (not by this module).

const FUSED_WGSL = `
@group(0) @binding(0) var<storage, read_write> wave: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> compatible: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> curBanned: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> nextBanned: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> propData: array<u32>;
@group(0) @binding(5) var<storage, read> propStart: array<u32>;
@group(0) @binding(6) var<storage, read> propLen: array<u32>;
@group(0) @binding(7) var<storage, read> neighbors: array<i32>;
@group(0) @binding(8) var<uniform> params: vec4<u32>; // [T, T4, count, 0]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  let num: u32 = atomicLoad(&curBanned[0]);
  if (idx >= num) { return; }
  let i1: u32 = atomicLoad(&curBanned[1u + idx * 2u]);
  let t1: u32 = atomicLoad(&curBanned[1u + idx * 2u + 1u]);
  let T: u32 = params[0];
  let T4: u32 = params[1];
  for (var d: u32 = 0u; d < 4u; d = d + 1u) {
    let i2i: i32 = neighbors[i1 * 4u + d];
    if (i2i < 0) { continue; }
    let i2: u32 = u32(i2i);
    let key: u32 = d * T + t1;
    let start: u32 = propStart[key];
    let len: u32 = propLen[key];
    let base2: u32 = i2 * T4;
    for (var l: u32 = 0u; l < len; l = l + 1u) {
      let t2: u32 = propData[start + l];
      let cidx: u32 = base2 + t2 * 4u + d;
      let prev: i32 = atomicSub(&compatible[cidx], 1i);
      if (prev == 1i) {
        let waddr: u32 = i2 * T + t2;
        if (atomicLoad(&wave[waddr]) == 1u) {
          let res = atomicCompareExchangeWeak(&wave[waddr], 1u, 0u);
          if (res.old_value == 1u) {
            let cbase: u32 = i2 * T4 + t2 * 4u;
            atomicStore(&compatible[cbase + 0u], 0i);
            atomicStore(&compatible[cbase + 1u], 0i);
            atomicStore(&compatible[cbase + 2u], 0i);
            atomicStore(&compatible[cbase + 3u], 0i);
            let pos: u32 = atomicAdd(&nextBanned[0], 1u);
            atomicStore(&nextBanned[1u + pos * 2u], i2);
            atomicStore(&nextBanned[1u + pos * 2u + 1u], t2);
          }
        }
      }
    }
  }
}
`;

/**
 * Static problem data (tileset+grid dependent, constant across runs).
 */
export interface GpuPropagatorData {
  /** Number of patterns (variants). */
  readonly T: number;
  /** T*4 stride for compatible. */
  readonly T4: number;
  /** Number of cells (MX*MY). */
  readonly count: number;
  readonly MX: number;
  readonly MY: number;
  readonly periodic: boolean;
  /** CSR propagator data (concatenated; d outer, t1 inner). Narrow type ok. */
  readonly propData: Uint8Array | Uint16Array | Int32Array;
  /** Start offsets into propData, indexed [d*T + t1]. */
  readonly propStart: Uint16Array | Int32Array;
  /** Lengths of each list, indexed [d*T + t1]. */
  readonly propLen: Uint8Array | Uint16Array | Int32Array;
  /** Precomputed neighbor table: neighbors[i*4 + d] = i2 or -1. */
  readonly neighbors: Int32Array;
}

/**
 * Reusable GPU backend implementing the fused parallel AC-4 propagation.
 *
 * Buffers and pipeline are allocated once in the constructor and reused for
 * every propagate() call on this tileset/grid/periodic configuration.
 * Wave and compatible are per-run state (uploaded each call).
 *
 * The implementation ports the exact WGSL kernel and diameter-dispatch loop
 * from the proven v2 prototype. It matches CPU propagate() indexing, strides,
 * ban rule (prev==1 on atomicSub means the direction support just hit zero),
 * and worklist ping-pong. One final readback after all dispatches.
 *
 * ok mirrors the CPU return value (sumsOfOnes[0] > 0 after prop), which is
 * "does cell 0 still have any options?" (see Model.propagate for exact contract).
 */
export class GpuPropagator {
  private readonly device: GPUDevice;
  private readonly T: number;
  private readonly T4: number;
  private readonly count: number;
  private readonly MX: number;
  private readonly MY: number;
  private readonly periodic: boolean;
  private readonly diameter: number;

  private readonly pipeline: GPUComputePipeline;

  // Static (read-only) buffers
  private readonly propDataBuf: GPUBuffer;
  private readonly propStartBuf: GPUBuffer;
  private readonly propLenBuf: GPUBuffer;
  private readonly neighborsBuf: GPUBuffer;
  private readonly paramsBuf: GPUBuffer;

  // Per-run state buffers (written each propagate)
  private readonly waveBuf: GPUBuffer;
  private readonly compatBuf: GPUBuffer;

  // Ping-pong worklists (storage for atomic counts + (i,t) pairs)
  private readonly workA: GPUBuffer;
  private readonly workB: GPUBuffer;

  // Readback buffers (mapped only at final step)
  private readonly waveReadback: GPUBuffer;
  private readonly compatReadback: GPUBuffer;
  private readonly countReadback: GPUBuffer;

  private readonly workBufSize: number;
  private readonly maxWorkgroups: number;

  constructor(device: GPUDevice, data: GpuPropagatorData) {
    this.device = device;
    this.T = data.T;
    this.T4 = data.T4;
    this.count = data.count;
    this.MX = data.MX;
    this.MY = data.MY;
    this.periodic = data.periodic;
    this.diameter = data.periodic ? Math.max(data.MX, data.MY) : (data.MX + data.MY);

    const maxBans = data.count * data.T;
    this.workBufSize = (1 + 2 * maxBans) * 4;
    const waveByteSize = data.count * data.T * 4;
    const compatByteSize = data.count * data.T4 * 4;

    this.maxWorkgroups = Math.ceil((data.count * data.T) / 64);

    // Normalize host arrays to GPU-friendly u32/i32 (copies; originals untouched)
    const propDataU32 = new Uint32Array(data.propData.length);
    for (let i = 0; i < data.propData.length; i++) propDataU32[i] = data.propData[i] >>> 0;

    const propStartU32 = new Uint32Array(data.propStart.length);
    for (let i = 0; i < data.propStart.length; i++) propStartU32[i] = data.propStart[i] >>> 0;

    const propLenU32 = new Uint32Array(data.propLen.length);
    for (let i = 0; i < data.propLen.length; i++) propLenU32[i] = data.propLen[i] >>> 0;

    const neighborsI32 = new Int32Array(data.neighbors);

    const paramsU32 = new Uint32Array([data.T >>> 0, data.T4 >>> 0, data.count >>> 0, 0]);

    // Static buffers (created once, uploaded once)
    this.propDataBuf = device.createBuffer({
      size: propDataU32.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint32Array(this.propDataBuf.getMappedRange()).set(propDataU32);
    this.propDataBuf.unmap();

    this.propStartBuf = device.createBuffer({
      size: propStartU32.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint32Array(this.propStartBuf.getMappedRange()).set(propStartU32);
    this.propStartBuf.unmap();

    this.propLenBuf = device.createBuffer({
      size: propLenU32.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint32Array(this.propLenBuf.getMappedRange()).set(propLenU32);
    this.propLenBuf.unmap();

    this.neighborsBuf = device.createBuffer({
      size: neighborsI32.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Int32Array(this.neighborsBuf.getMappedRange()).set(neighborsI32);
    this.neighborsBuf.unmap();

    this.paramsBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    });
    new Uint32Array(this.paramsBuf.getMappedRange()).set(paramsU32);
    this.paramsBuf.unmap();

    // Stateful buffers (written per call)
    this.waveBuf = device.createBuffer({
      size: waveByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.compatBuf = device.createBuffer({
      size: compatByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    this.workA = device.createBuffer({
      size: this.workBufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.workB = device.createBuffer({
      size: this.workBufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    this.waveReadback = device.createBuffer({
      size: waveByteSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.compatReadback = device.createBuffer({
      size: compatByteSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.countReadback = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Pipeline (created once)
    const shaderModule = device.createShaderModule({ code: FUSED_WGSL });
    this.pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: shaderModule, entryPoint: "main" },
    });
  }

  /**
   * Execute the fused parallel AC-4 propagation from a post-observe (or trigger-ban)
   * state to fixpoint.
   *
   * - Uploads the caller's wave + compatible (Uint8 narrow arrays from the CPU model).
   * - Compatible is widened to i32 on GPU only for atomic ops (converted back on return).
   * - Seeds the worklist from initialNewlyBanned (the "newly banned" that observe/ban pushed).
   * - Dispatches the kernel exactly `diameter` times using ping-pong worklists (no
   *   intermediate readbacks).
   * - One final readback of wave + compatible + trailing work count.
   * - Returns copies as Uint8Arrays (matching CPU layout post H23/H26) + ok flag.
   *
   * The ban rule, indexing (T4, d*T+t1, i*T4 + t*4 + d, i*4 + d), and zeroing exactly
   * match the CPU path in src-optimized/model.ts:propagate + ban.
   */
  async propagate(
    wave: Uint8Array,
    compatible: Uint8Array,
    initialNewlyBanned: Array<[number, number]>
  ): Promise<{ wave: Uint8Array; compatible: Uint8Array; ok: boolean }> {
    const { device, T, T4, count, waveBuf, compatBuf, workA, workB, paramsBuf } = this;
    if (wave.length !== count * T) {
      throw new Error(`wave length mismatch: got ${wave.length}, expected ${count * T}`);
    }
    if (compatible.length !== count * T4) {
      throw new Error(`compatible length mismatch: got ${compatible.length}, expected ${count * T4}`);
    }

    // Prepare upload data (wave 0/1 as u32, compat as i32 for atomics)
    const waveU32 = new Uint32Array(count * T);
    for (let i = 0; i < wave.length; i++) waveU32[i] = wave[i] ? 1 : 0;

    const compatI32 = new Int32Array(count * T4);
    for (let i = 0; i < compatible.length; i++) compatI32[i] = compatible[i] | 0;

    device.queue.writeBuffer(waveBuf, 0, waveU32);
    device.queue.writeBuffer(compatBuf, 0, compatI32);

    // Seed initial worklist
    const nInit = initialNewlyBanned.length;
    const initData = new Uint32Array(1 + 2 * nInit);
    initData[0] = nInit >>> 0;
    for (let k = 0; k < nInit; k++) {
      initData[1 + k * 2] = initialNewlyBanned[k][0] >>> 0;
      initData[1 + k * 2 + 1] = initialNewlyBanned[k][1] >>> 0;
    }

    let curBuf = workA;
    let nxtBuf = workB;
    device.queue.writeBuffer(curBuf, 0, initData);

    const maxWgs = this.maxWorkgroups;
    const diam = this.diameter;

    // Diameter dispatches, ping-pong, no per-iter host sync
    for (let it = 0; it < diam; it++) {
      device.queue.writeBuffer(nxtBuf, 0, new Uint32Array([0]));

      const enc = device.createCommandEncoder();
      const bind = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: waveBuf } },
          { binding: 1, resource: { buffer: compatBuf } },
          { binding: 2, resource: { buffer: curBuf } },
          { binding: 3, resource: { buffer: nxtBuf } },
          { binding: 4, resource: { buffer: this.propDataBuf } },
          { binding: 5, resource: { buffer: this.propStartBuf } },
          { binding: 6, resource: { buffer: this.propLenBuf } },
          { binding: 7, resource: { buffer: this.neighborsBuf } },
          { binding: 8, resource: { buffer: paramsBuf } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(maxWgs);
      pass.end();
      device.queue.submit([enc.finish()]);

      const tmp = curBuf;
      curBuf = nxtBuf;
      nxtBuf = tmp;
    }

    // ONE final readback
    const encFinal = device.createCommandEncoder();
    encFinal.copyBufferToBuffer(waveBuf, 0, this.waveReadback, 0, waveBuf.size);
    encFinal.copyBufferToBuffer(compatBuf, 0, this.compatReadback, 0, compatBuf.size);
    encFinal.copyBufferToBuffer(curBuf, 0, this.countReadback, 0, 4);
    device.queue.submit([encFinal.finish()]);

    await this.waveReadback.mapAsync(GPUMapMode.READ);
    const gpuWaveU32 = new Uint32Array(this.waveReadback.getMappedRange()).slice(0);
    this.waveReadback.unmap();

    await this.compatReadback.mapAsync(GPUMapMode.READ);
    const gpuCompatI32 = new Int32Array(this.compatReadback.getMappedRange()).slice(0);
    this.compatReadback.unmap();

    await this.countReadback.mapAsync(GPUMapMode.READ);
    // finalWorkCount not exposed in the API (used only for diagnostics in prototype)
    this.countReadback.unmap();

    // Convert back to Uint8 (narrow) to match CPU post-H23 representation
    const outWave = new Uint8Array(count * T);
    for (let k = 0; k < outWave.length; k++) outWave[k] = gpuWaveU32[k] ? 1 : 0;

    const outCompat = new Uint8Array(count * T4);
    for (let k = 0; k < outCompat.length; k++) {
      // Values are non-negative after correct run (decr from positive, explicit 0 on ban)
      outCompat[k] = gpuCompatI32[k] | 0;
    }

    // ok mirrors CPU: return sumsOfOnes[0] > 0  (cell 0 still has options)
    // Equivalent to popcount of wave[0..T) > 0
    let cell0Options = 0;
    for (let t = 0; t < T; t++) {
      if (outWave[t] === 1) {
        cell0Options++;
        break;
      }
    }
    const ok = cell0Options > 0;

    return { wave: outWave, compatible: outCompat, ok };
  }
}

# Harness Baseline — iteration-0 evidence the measurement pipeline is sound

This document records the proof that the test/comparison/measurement scaffold is
**trusted before it is used to judge anything**. It was built and run against an
**identity copy** (`src-optimized/` == `src/`, byte-for-byte) before any
optimization existed. If the harness did not report ~1.0× speedup and 0
mismatches against an identity copy, the pipeline itself would be broken and
judging optimizations against it would be meaningless.

This mirrors the `HARNESS-BASELINE.md` discipline from
[macton/differentiable-collisions-optc](https://github.com/macton/differentiable-collisions-optc):
the measurement pipeline is proven against an identity copy (≈1.0×, 0 deviation)
*before* it judges any optimization.

## The four pieces

| Piece | Role | Independence |
|-------|------|--------------|
| `harness/run.ts` | Runs a solver (reference or optimized) on a committed input, times `run()` (construction excluded), writes a result file. | Treats ref/opt symmetrically via a `SolverKind`. |
| `harness/compare.ts` | **Informational**: reports whether the optimized output byte-matches the reference (identical ok/complete/sha256). True for layout-only changes, false for algorithmic ones. Not a gate. | Shows whether an optimization also reproduces the reference's exact tiling — useful signal, never blocking. |
| `harness/validate.ts` | **Validity gate**: independently re-derives adjacency from the tileset and checks the output tiling respects every constraint + has no contradiction + completes. | Shares NO solver code — only the tileset parser. Validates the *output*, not the solver's internal state. |
| `harness/measure-speedup.ts` | **Timing**: median-of-N individual `run()` calls after one warmup; reports ref median, opt median, ratio. | Construction excluded (build-stage precompute, per the collision repo's policy). |

## Match contract

We do not match the implementation's intermediate results — only the correct
outputs. The optimized solver may compute differently (even use a different
algorithm) as long as the output meets the contract:

- **valid + complete** — the output is a valid tiling: every adjacency
  constraint satisfied, no contradiction, every cell collapsed (`validate.ts`,
  the independent validator that shares no solver code).
- **deterministic** — same seed → same output, every run (run twice, sha256 of
  the `observed[]` array must match). Catches flakiness and makes the benchmark
  reproducible.

The reference's role: it is the validator's correctness anchor (at iteration 0,
the reference's output is valid, which proves the validator is sound) and the
speedup baseline we measure against. It is **not** the tiling the optimized must
reproduce — a valid WFC tiling is not unique, and the optimized is free to choose
a different (valid) one via a faster algorithm.

`compare.ts` (byte-match to reference) is **informational**, not a gate: it
reports whether an optimization *also* reproduces the reference's exact tiling
(true for layout-only changes, false for algorithmic changes like a heap). Worth
knowing, never blocking. This mirrors the collision repo: the optimized uses a
different algorithm held to an output contract, not identical intermediates.

## Committed inputs (never edited)

Six inputs spanning tilesets, subsets, sizes, and periodicity. Each input's
checksum is recorded below as an integrity anchor — a quietly-edited committed
input would change its reference checksum, which the harness detects.

| Input | Tileset | Subset | Size | Periodic | Seed |
|-------|---------|--------|------|----------|------|
| knots-standard-24 | Knots | Standard | 24×24 | yes | 1 |
| knots-standard-48 | Knots | Standard | 48×48 | yes | 7 |
| knots-fabric-24 | Knots | Fabric | 24×24 | yes | 3 |
| knots-dense-24 | Knots | Dense | 24×24 | yes | 0 |
| circuit-turnless-34 | Circuit | Turnless | 34×34 | yes | 1 |
| rooms-30 | Rooms | (full) | 30×30 | no | 1 |

## Identity-baseline result

Run: `bun run harness/prove-harness.ts` against `src-optimized/` == `src/`.

| name | compare | valid | deterministic | speedup | ref ms | opt ms | violations |
|------|---------|-------|---------------|---------|--------|--------|------------|
| knots-standard-24 | PASS | VALID | DET | 1.00x | 1.12 | 1.12 | 0 |
| knots-standard-48 | PASS | VALID | DET | 0.96x | 10.82 | 11.23 | 0 |
| knots-fabric-24 | PASS | VALID | DET | 0.79x | 0.55 | 0.69 | 0 |
| knots-dense-24 | PASS | VALID | DET | 0.86x | 0.78 | 0.91 | 0 |
| circuit-turnless-34 | PASS | VALID | DET | 0.93x | 7.63 | 8.18 | 0 |
| rooms-30 | PASS | VALID | DET | 0.96x | 3.75 | 3.92 | 0 |

**FINAL: PASS — harness proven against identity copy.**

Every gate that carries signal (compare / valid / deterministic) passes on every
input. The speedup ratios cluster around 1.0× as expected for an identity copy.
The deviations (0.79×–1.00×) are sub-millisecond measurement noise on the small
inputs — not a systematic bias. This is the honest caveat from the collision
repo applied here too: these are wall-clock medians on one machine; treat them as
the right order of magnitude, not three significant figures.

**Implication for Phase 3:** the sub-millisecond inputs (knots-fabric-24,
knots-dense-24 at <1 ms) carry too little signal to measure speedup against. The
meaningful benchmark inputs are **knots-standard-48 (~11 ms)** and
**circuit-turnless-34 (~8 ms)** — real work above the noise floor. The
optimization target and the per-hypothesis measurements will weight toward these.

## Reference output checksums (committed-input integrity anchor)

The sha256 of each committed input's reference `observed[]` output. Phase 3's
proof harness verifies these are unchanged, so a committed input cannot be
quietly edited to flatter a result.

```
knots-standard-24: 887e51eacd35f3c39d9738e98f8d6052a6c6faeecaf168f7a3443ca0baa82623
knots-standard-48: 3b506c56a4b06ae1083bba80725a537fcd02091a7bf0e4ce8b0fa89c053a755e
knots-fabric-24:   93b372dd8feeb3d6759d6d8d3d0e09f9e0f828cf728e56ce469d8f0822385ae5
knots-dense-24:    706b048b2ab85c12adc055f200ca3ac26d727d9652d6c7dfd755fbbc86e4de61
circuit-turnless-34: 3fe92333f66573538217a23405066c4674eee904cbae79c6915479619a514509
rooms-30:          470fb3d41885f6d3f702bac388c52d6624c64725344016baa3b5a780b4dba60e
```

These are the sha256 of each committed input's reference `observed[]` output.
Phase 3's proof harness verifies they are unchanged, so a committed input
cannot be quietly edited to flatter a result. (Regenerate via
`bun run harness/prove-harness.ts`.)
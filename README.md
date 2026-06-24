# wfc-ts

Wave Function Collapse (simple tiled model) in TypeScript, optimized via the
**Mike Acton ratchet technique** — a measured, evidence-grounded optimization
method where every kept change is committed, every claim is checked by a proof
harness the model cannot talk its way around, and progress ratchets forward
without ever drifting backward.

This is an open-source project with two equally important goals:

1. **A real, optimized WFC solver** you can use in web projects.
2. **A reproducible case study** of driving an LLM at an optimization problem
   the way Mike Acton's `differentiable-collisions-optc` and `pep-copt` repos
   do — the method is inspectable, not a story you take on faith.

## Status

| Phase | What | Status |
|-------|------|--------|
| 0 | Scaffold (Bun + TS strict, vitest, mulberry32 PRNG, committed tilesets) | ✅ done |
| 1 | Reference — faithful TS port of mxgmn's `SimpleTiledModel` | ✅ done, verified |
| 2 | Harness — `compare` + independent `validate` + `measure-speedup`, proven vs identity copy | ⏳ next |
| 3 | Optimize — ratchet loop (profile → gate → measure → keep/revert → commit) | ⏳ |
| 4 | Generalize (alt seeds) + visualizer + external benchmark comparison | ⏳ |

The reference (`src/`) is a faithful port of Maxim Gumin's
[WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) simple
tiled model — the observation/propagation core (AC-4 constraint propagation)
and the tile-symmetry + propagator construction. The one deliberate divergence:
we use **mulberry32** as a deterministic PRNG (instead of C#'s `System.Random`),
standardized across the reference and the optimized solver so that identical
seed + input yields byte-identical output. That sameness is the correctness gate.

## Run it

```bash
bun install
bun test            # reference correctness suite
bun run typecheck   # tsc --noEmit, strict
```

## The match contract

WFC's collapse is random, so "identical output" is the wrong gate *unless* we
make it deterministic. We do: a seedable PRNG (mulberry32) means the optimized
solver must produce **byte-identical output** to the reference for identical
seed + input. Two gates, mirroring the collision repo's split:

- **`compare`** — optimized output byte-matches reference output (the sharp
  gate that catches a propagation reorder that silently changes which cell
  collapses next).
- **`validate`** — an independent constraint validator (shares no code with
  either solver): every adjacency satisfied, no contradiction, valid tiling.

## Layout

```
src/                      reference — faithful mxgmn port (the correctness anchor)
src-optimized/            starts as a verbatim copy of src/, optimized in place (Phase 3)
test/                     correctness suite (runs against the reference; later both)
performance-test/         committed inputs (tilesets + fixed seeds) — never edited
performance-test-optimized/  compare.ts, validate.ts, measure-speedup.ts (Phase 2)
benchmarks/external/       vendored kchapelier + blazinwfc + lite-wfc, with adapters (Phase 4)
viz/                       small web visualizer (Phase 4)
prompts/                   the four ratchet instruction docs (the method, reproducible)
docs/                      learning guide + optimization walkthrough (Phase 4)
OPTIMIZATION-LOG.md        per-hypothesis measured record (Phase 3)
```

## Lineage

This project stands on the shoulders of:

- **Maxim Gumin** — [WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse), the original. MIT.
- **Mathieu Fehr & Nathanael Courant** — [fast-wfc](https://github.com/math-fehr/fast-wfc), the ~10× C++ port whose techniques inform our optimization candidates. MIT.
- **Mike Acton** — the [data-oriented-design](https://github.com/macton/nagent/blob/main/context/data-oriented-design.md) operating rules and the [ratchet](https://github.com/macton/differentiable-collisions-optc) methodology this project applies.

## License

MIT. See [LICENSE](LICENSE).
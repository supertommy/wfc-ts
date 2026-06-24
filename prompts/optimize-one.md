# WFC-TS Ratchet Optimization — One Iteration

You are doing **exactly one iteration** of the Mike Acton ratchet optimization
loop on wfc-ts (a TypeScript Wave Function Collapse *simple tiled model*
solver). Read this whole document, then execute one iteration and return a
summary. You do NOT have prior session memory — everything you need is in files.

## What this project is

- **Reference** — `src/`: a faithful TypeScript port of mxgmn's WaveFunctionCollapse
  simple tiled model. The correctness anchor and the speedup baseline. **Never edit `src/`.**
- **Optimized** — `src-optimized/`: the solver being optimized. **Edit only `src-optimized/`.**
- **Harness** — `harness/`: the proof scaffold. **Never edit `harness/` or `test/`.**
- **Committed inputs** — `performance-test/inputs/*.json`: fixed, never edit.
- **Log** — `OPTIMIZATION-LOG.md`: append your iteration here.
- **Plan + candidate list** — `src-optimized/README.md`: the ranked candidates and
  their status (TODO / KEPT / REVERTED / REJECTED). Update the status after your
  iteration.
- **Profile tool** — `scripts/profile.ts`: per-phase instrumentation of the
  reference, to find where cycles go.

## Match contract (the gate)

The optimized solver must produce a **valid + complete** tiling and be
**deterministic** (same seed → same output, every run). It does **NOT** need to
byte-match the reference — a valid WFC tiling is not unique, and the optimized is
free to use a faster algorithm that produces a different (valid) tiling.

`bun run harness/prove-harness.ts` enforces this and prints a fixed report:
- **VALID** — the independent validator (`harness/validate.ts`, shares no solver
  code) confirms every adjacency is satisfied, no contradiction, completes.
  REQUIRED.
- **DET** — deterministic: re-running the optimized yields an identical checksum.
  REQUIRED.
- **compare*** — byte-match to the reference. INFORMATIONAL only (true for
  layout-only changes, false for algorithmic ones like a heap). Never blocks a keep.

## Methodology — Mike Acton data-oriented design

State the cost on the real platform (here: a JS engine, its GC, and typed-array
throughput). Remove work before doing it faster. Batch-first. SoA over AoS.
Indices over references. Common case straight-line. Exploit constraints. Simplicity
is removing work (fewer states, fewer branches, fewer special cases). Complexity
requires evidence. Never assert an unmeasured performance result.

## Your iteration — exactly these steps

1. **Ground yourself.** Run `bun run harness/prove-harness.ts` and read its real
   output. This is your starting truth — not your memory.
2. **Pick the next candidate.** Read the candidate list in `src-optimized/README.md`
   and pick the highest-Amdahl-payoff untried candidate: *fraction of measured
   runtime it touches × expected speedup on that fraction*. Not the safest — the
   highest payoff. If the current approach has stalled (filing stopped paying),
   re-profile with `bun run scripts/profile.ts` and reconsider the *machine*, not
   just keep filing. Do **not** do throwaway work (a change a planned later change
   would discard — say so and skip it). Note which gate each candidate uses:
   - Tier-1 (layout-only, algorithm unchanged) → byte-identical to reference
     (compare* will read PASS, but that's informational).
   - Tier-2 (algorithmic, changes the collapse sequence) → gated on VALID+DET
     only; compare* will read FAIL and that is expected and fine.
3. **Implement** that ONE change in `src-optimized/` only.
4. **Gate**, in order. A failure at any gate = fix it, or REVERT before measuring:
   - `bun run typecheck` — must be clean.
   - `bun run harness/prove-harness.ts` — VALID and DET must hold.
5. **Measure** — the median-of-5 speedup on the three meaningful inputs
   (knots-standard-48, circuit-turnless-34, rooms-30) is in the prove-harness
   output. (Sub-ms inputs pass gates but don't headline.)
6. **Keep or revert:**
   - **KEEP** if gates pass AND (measurably faster on at least one meaningful
     input with no regression on the others, OR a pure simplification, OR an
     enabling transform with a NAMED follow-on you will attempt next). On keep:
     `git add -A && git commit -m "Hypothesis N: <one-line>"` immediately.
   - **REVERT** (`git checkout -- src-optimized/`) if it regressed or broke a gate.
7. **Log.** Append to `OPTIMIZATION-LOG.md`:
   - `## Hypothesis N — <title> [KEPT|REVERTED]`
   - Hypothesis (one sentence), Change (what you did, which files),
     Measurement (a table: input | ref ms | opt ms | speedup | valid | det),
     Decision + reason, Cost (rough wall-clock + that you ran the harness).
8. **Update the candidate list** in `src-optimized/README.md` (mark this
   candidate KEPT/REVERTED/REJECTED with the one-line result; add any new
   candidate the measurement revealed).
9. **Return a summary**: candidate tried, kept/reverted, before→after speedup
   on the 3 meaningful inputs, gate status, and the next candidate to try.

## Hard rules

- **Never fabricate a measurement.** Run the harness; report its real output.
- **One change per iteration.** Never stack two changes in one measurement — each
  must be attributable.
- **Never delete or weaken a gate or test** to make something pass.
- **Never edit `src/`, `harness/`, `test/`, or `performance-test/inputs/`.**
- **Every kept gain is committed before you return.** The working tree never holds
  an uncommitted kept win (so a later revert can't destroy it).
- If you're unsure whether a change is correct, gate it — the harness is the
  arbiter, not your judgment. If VALID or DET fails and you can't fix it in one
  attempt, revert and log it as REVERTED with the reason.

## Exit criteria (for the orchestrating loop, not you)

The loop stops when the speedup target (recorded in `src-optimized/README.md`)
is reached on all meaningful inputs with gates passing, OR every candidate is
marked KEPT/REVERTED/REJECTED. You just do one iteration; the orchestrator
decides stop/continue.
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
   re-profile and reconsider the *machine*, not just keep filing. Note:
   `scripts/profile.ts` instruments the *reference* and is stale post-H4 (the scan
   it shows is gone). To find the OPTIMIZED's current bottleneck, instrument
   `src-optimized/model.ts` with per-phase timers (heap extract / observe /
   propagate / ban+heap-update) or use `bun --cpu-profile` on
   `harness/run.ts optimized <input>`. Do **not** do throwaway work (a change a planned later change
   would discard — say so and skip it). Note which gate each candidate uses:
   - Tier-1 (layout-only, algorithm unchanged) → byte-identical to reference
     (compare* will read PASS, but that's informational).
   - Tier-2 (algorithmic, changes the collapse sequence) → gated on VALID+DET
     only; compare* will read FAIL and that is expected and fine.
3. **Implement** that ONE change in `src-optimized/` only.
4. **Gate**, in order. A failure at any gate = fix it, or REVERT before measuring:
   - `bun run typecheck` — must be clean.
   - `bun run harness/prove-harness.ts` — VALID and DET must hold (or, for
     success-rate candidates that change the run contract, the new deterministic
     contract: same (seed, budget) → same output — verify by re-running).
5. **Measure by axis.** Pick the metric that matches the candidate's target axis
   (priority SPEED > success-rate > memory):
   - SPEED (primary): `bun run harness/measure-speedup.ts <input> 5` (median-of-5)
     on knots-standard-48, circuit-turnless-34, rooms-30.
   - SUCCESS: `bun run harness/success-rate.ts <input> [N=100]` — completion
     rate over N seeds, ref vs opt. Use the hard input(s) (knots-dense-24).
   - MEMORY: `bun run harness/memory.ts [input]` — optimized footprint bytes.
6. **Keep or revert (priority speed > success > memory):**
   - SPEED candidate: **KEEP** if VALID+DET AND measurably faster (above noise)
     on the target input(s) AND knots-48 does not regress. **Memory growth is
     ACCEPTABLE — do NOT reject a speed win for using more memory.**
   - SUCCESS candidate: **KEEP** if completion rate rises on the hard input(s)
     AND speed does not regress meaningfully (speed outranks success: don't
     tank speed for success). New-contract determinism must hold.
   - MEMORY candidate: **KEEP** only if footprint down AND NO speed regression
     (memory is lowest priority; a memory win that costs speed is REVERTED).
   - On keep: `git add -A && git commit -m "Hypothesis N: <one-line>"` immediately.
   - **REVERT** (`git checkout -- src-optimized/`) if it regressed or broke a gate.

**Round 3 hard constraints (apply to every change):** plain JS/TS only — NO WASM,
no native addons. WebGPU allowed only as an OPTIONAL path with a portable plain-
JS fallback that stays working in Node AND browser. Solver core stays Node+
browser-portable (no Node-only APIs in the hot path). Typed arrays/ArrayBuffers
encouraged. Workers only if isomorphic Node+browser (default single-threaded).
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

The loop stops when the Round 3 target (recorded in `src-optimized/README.md`)
is met on all axes with gates passing, OR every candidate is
marked KEPT/REVERTED/REJECTED AND a fresh ideation pass yields no new high-
payoff candidate. Filing-stall is NOT a stop — it triggers the STALL→IDEATE
branch (below); only ideation-yields-nothing stops the loop.

## STALL→IDEATE (when filing stalls or a wall is confirmed)

When the candidate list is exhausted of same-algorithm filings, OR a re-profile
confirms a dominant cost that micro-filing can't touch (an algorithmic wall),
DO NOT declare exhaustion. Instead run a creative-ideation pass to mint frame-
breaking candidates, and continue the loop:
- **TRIZ** (Altshuller) when the barrier is a parameter conflict (speed vs
  memory vs success-rate): state the contradiction, translate inventive
  principles to concrete WFC mechanisms, compare to the Ideal Final Result.
- **First-principles** when accumulated assumptions of the algorithm itself
  need questioning (e.g. AC-4 propagation, greedy selection, no-backtracking).
- **Biomimicry** when a natural analog fits (crystal nucleation, quantum
  measurement, morphogenesis).
Add the resulting mechanisms as new TODO rows in `src-optimized/README.md`
(tagged with principle + axis + tier + mechanism + honest tradeoff), then pick
the highest-priority one and continue iterating. The real stop is when an
ideation pass itself yields no high-payoff candidate — not when filing stalls.
You just do one iteration; the orchestrator decides stop/continue.
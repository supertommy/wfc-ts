import { useEffect, useMemo, useState } from "react";

interface TraceStep {
  title: string;
  action: string;
  state: string[];
  stack: string[];
  note: string;
  tone: "choose" | "propagate" | "contradict" | "restore" | "solve";
}

const steps: TraceStep[] = [
  {
    title: "1. Choose a tile",
    action: "Cell A picks a corner that opens right and down.",
    state: ["A: corner", "B: ?", "C: ?", "D: ?"],
    stack: ["checkpoint A: try corner, alternatives left"],
    note: "Backtracking starts by saving the wave, compatibility counts, entropy state, PRNG state, and the remaining choices for this decision.",
    tone: "choose",
  },
  {
    title: "2. Propagate",
    action: "A's sockets force B and C to keep matching openings.",
    state: ["A: corner", "B: must open left", "C: must open up", "D: ?"],
    stack: ["checkpoint A: try corner, alternatives left"],
    note: "Propagation is still the same AC-4 loop. The propagation stack pushes consequences. It is not the decision stack.",
    tone: "propagate",
  },
  {
    title: "3. Hit a contradiction",
    action: "D has no tile that satisfies both incoming sockets.",
    state: ["A: corner", "B: forced", "C: forced", "D: none"],
    stack: ["checkpoint A: try corner, alternatives left"],
    note: "Restart-only search throws away the whole attempt here. Backtracking asks whether the last decision still has another tile to try.",
    tone: "contradict",
  },
  {
    title: "4. Restore the checkpoint",
    action: "The solver rewinds to before A was chosen.",
    state: ["A: ?", "B: ?", "C: ?", "D: ?"],
    stack: ["checkpoint A: try straight next"],
    note: "Restore is a snapshot copy. That is why the feature is opt-in: it buys stronger search with extra memory movement.",
    tone: "restore",
  },
  {
    title: "5. Try the next tile",
    action: "A picks a straight pipe. Propagation leaves D with a valid tile.",
    state: ["A: straight", "B: straight", "C: empty", "D: elbow"],
    stack: [],
    note: "The failed choice is not retried. The next alternative gets a clean wave and a deterministic PRNG state.",
    tone: "solve",
  },
];

const toneClass: Record<TraceStep["tone"], string> = {
  choose: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100",
  propagate: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100",
  contradict: "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-100",
  restore: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100",
  solve: "border-violet-300 bg-violet-50 text-violet-950 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100",
};

export default function BacktrackingTrace() {
  const [index, setIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const step = steps[index];
  const progress = useMemo(() => `${index + 1} / ${steps.length}`, [index]);
  const canPrev = hydrated && index > 0;
  const canNext = hydrated && index < steps.length - 1;

  return (
    <section className="not-prose breakout rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-950 dark:shadow-black/20" aria-label="Interactive backtracking trace">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Interactive proof</p>
          <h3 className="mt-1 text-2xl font-bold text-slate-950 dark:text-slate-50">Walk a contradiction back</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">Step through a tiny pipe fixture. Watch the decision stack save alternatives while propagation does the local cleanup.</p>
        </div>
        <div className="rounded-full border border-slate-200 px-3 py-1 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200" aria-live="polite">
          Step {progress}
        </div>
      </div>

      <div className={`mt-5 rounded-2xl border p-4 ${toneClass[step.tone]}`}>
        <h4 className="text-lg font-bold">{step.title}</h4>
        <p className="mt-1 text-sm leading-6">{step.action}</p>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_0.85fr]">
        <div className="grid grid-cols-2 gap-3" aria-label="2 by 2 wave state">
          {step.state.map((cell, cellIndex) => (
            <div key={cellIndex} className="min-h-24 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">Cell {String.fromCharCode(65 + cellIndex)}</div>
              <div className="mt-3 text-lg font-bold text-slate-900 dark:text-slate-50">{cell.split(": ")[1]}</div>
            </div>
          ))}
        </div>

        <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900" aria-label="Decision stack">
          <h4 className="font-bold text-slate-950 dark:text-slate-50">Decision stack</h4>
          {step.stack.length ? (
            <ul className="mt-3 space-y-2">
              {step.stack.map((item) => (
                <li key={item} className="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm dark:bg-slate-950 dark:text-slate-200">{item}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">Empty. The fixture solved without another restore.</p>
          )}
          <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">{step.note}</p>
        </aside>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setIndex(0)}
          disabled={!hydrated || index === 0}
          className="cursor-pointer rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => setIndex((n) => Math.max(0, n - 1))}
          disabled={!canPrev}
          className="cursor-pointer rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setIndex((n) => Math.min(steps.length - 1, n + 1))}
          disabled={!canNext}
          className="cursor-pointer rounded-full bg-slate-950 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 transition hover:-translate-y-0.5 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
        >
          Next
        </button>
        {!hydrated && <span className="text-sm text-slate-500">Loading controls...</span>}
      </div>
    </section>
  );
}

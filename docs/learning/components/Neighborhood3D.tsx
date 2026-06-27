import { useEffect, useMemo, useState } from "react";

const directions = [
  { name: "left", axis: "-X", index: 0, vector: "x - 1", position: "left-2 top-1/2 -translate-y-1/2" },
  { name: "right", axis: "+X", index: 1, vector: "x + 1", position: "right-2 top-1/2 -translate-y-1/2" },
  { name: "up", axis: "+Y", index: 2, vector: "y + 1", position: "left-1/2 top-2 -translate-x-1/2" },
  { name: "down", axis: "-Y", index: 3, vector: "y - 1", position: "left-1/2 bottom-2 -translate-x-1/2" },
  { name: "front", axis: "-Z", index: 4, vector: "z - 1", position: "left-1/4 bottom-8" },
  { name: "back", axis: "+Z", index: 5, vector: "z + 1", position: "right-1/4 top-8" },
] as const;

export default function Neighborhood3D() {
  const [active, setActive] = useState(1);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  const dir = directions[active];
  const formula = useMemo(() => {
    if (dir.name === "left") return "x - 1, y, z";
    if (dir.name === "right") return "x + 1, y, z";
    if (dir.name === "up") return "x, y + 1, z";
    if (dir.name === "down") return "x, y - 1, z";
    if (dir.name === "front") return "x, y, z - 1";
    return "x, y, z + 1";
  }, [dir.name]);

  return (
    <section className="not-prose breakout rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-950 dark:shadow-black/20" aria-label="Interactive 3D neighborhood explorer">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Interactive neighborhood</p>
          <h3 className="mt-1 text-2xl font-bold text-slate-950 dark:text-slate-50">One voxel, six questions</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">Pick a direction. The highlighted neighbor is the cell whose tile id must appear in that rule field.</p>
        </div>
        <div className="rounded-full border border-slate-200 px-3 py-1 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200" aria-live="polite">
          {dir.name} · {dir.axis}
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_0.9fr]">
        <div className="relative min-h-80 rounded-3xl border border-slate-200 bg-[radial-gradient(circle_at_50%_40%,rgba(14,165,233,0.12),transparent_45%),linear-gradient(135deg,rgba(15,23,42,0.04),rgba(148,163,184,0.08))] p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="absolute left-1/2 top-1/2 z-10 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-slate-300 bg-slate-950 text-sm font-bold text-white shadow-2xl shadow-slate-900/30 dark:border-slate-600 dark:bg-slate-100 dark:text-slate-950">
            cell
            <br />
            x,y,z
          </div>

          {directions.map((d, i) => {
            const selected = i === active;
            return (
              <button
                key={d.name}
                type="button"
                onClick={() => setActive(i)}
                className={`absolute ${d.position} cursor-pointer rounded-2xl border px-4 py-3 text-left text-sm font-semibold shadow-sm transition hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 active:translate-y-0 ${
                  selected
                    ? "border-sky-400 bg-sky-100 text-sky-950 shadow-sky-200/60 dark:border-sky-500 dark:bg-sky-950 dark:text-sky-100"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-900"
                }`}
                aria-pressed={selected}
              >
                {d.name}
                <span className="block text-xs font-medium opacity-70">{d.axis}</span>
              </button>
            );
          })}
        </div>

        <aside className="rounded-3xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900">
          <h4 className="text-lg font-bold text-slate-950 dark:text-slate-50">Rule field</h4>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            If the center cell has tile <code>{"T"}</code>, then <code>{`rule.${dir.name}`}</code> lists which tiles may appear at <code>({formula})</code>.
          </p>
          <div className="mt-4 rounded-2xl bg-white p-4 font-mono text-sm text-slate-800 shadow-sm dark:bg-slate-950 dark:text-slate-100">
            {`{ forTile: T, ${dir.name}: [/* allowed tiles */] }`}
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Direction index <strong>{dir.index}</strong> is useful for validators and generated rules. In app code, use the named fields.
          </p>
          {!hydrated && <p className="mt-3 text-sm text-slate-500">Loading controls...</p>}
        </aside>
      </div>
    </section>
  );
}

# Phase 4c: OSS Polish Checklist

Status: **IN PROGRESS**

## Items

- [x] **Generalization check** — verify alt seeds, larger grids (64x64, 128x128) pass VALID+DET ✓ 27/27 pass
- [x] **Web visualizer** — `viz/` directory, uses H16 stepRun generator, simple HTML+JS demo ✓
- [x] **Learning guide** — `docs/` with WFC concepts, architecture walkthrough, optimization history ✓
- [x] **Prompts docs** — `prompts/optimize-one.md` is comprehensive (full ratchet methodology) ✓
- [x] **README polish** — final README.md with badges, install, usage, benchmarks, API ✓
- [x] **External benchmark refresh** — rerun with final solver, update RESULTS.md ✓ 2.55–19.57x faster than all competitors
- [ ] **OSS packaging** — package.json metadata, LICENSE check, .npmignore, publish prep

## Order

1. Generalization check first (confirm nothing broke at scale)
2. External benchmark refresh (get final numbers)
3. README polish (the first thing people see)
4. Learning guide + prompts docs (educational value)
5. Web visualizer (demo/showcase)
6. OSS packaging (final publish prep)

## Notes

- H16 stepRun already works and is tested
- Current speed: ~0.98ms knots-48, ~2.29ms circuit-34, ~1.05ms rooms-30
- External: 1.20–9.96x faster than all comparable implementations

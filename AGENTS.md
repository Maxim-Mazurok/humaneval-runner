# Agent Guide

This is a local LLM evaluation workbench for OpenAI-compatible chat completion
endpoints. It ships built-in benchmarks (HumanEval, BBEH Mini/Full) and treats
optional benchmark packs under `packs/` as a first-class extension point:
public benchmarks, private datasets, and bespoke evaluations all plug in the
same way, may live in their own repositories, and carry their own datasets —
see `packs/README.md`. The README is the source of truth for setup, runtime
workflow, and artifact details.

## Project Map

- `src/` contains the React/Vite UI.
- `scripts/eval-server.mjs` starts the local benchmark API server.
- `scripts/server/runtime.mjs` contains the benchmark server runtime.
- `scripts/server/benchmarks/` contains per-benchmark modules (data loading,
  prompts, answer/code extraction, scoring) behind a shared interface, plus
  `packs.mjs`, the loader for optional benchmark packs.
- `packs/` holds optional benchmark packs; a pack's contents are owned by the
  pack, not this repository.
- `tests/e2e/` contains Playwright coverage.
- `src/*.test.ts*` contains Vitest unit and integration coverage.
- `benchmark-runs/`, `.cache/`, `dist/`, `test-results/`, and
  `.playwright-mcp/` are generated or local-only directories.

## Common Commands

Use `rtk` when running shell commands in this repo.

- `rtk npm run dev` starts the Vite UI.
- `rtk npm run dev:bench` starts the benchmark API server.
- `rtk npm test` runs the Vitest suite.
- `rtk npm run test:e2e` runs Playwright tests.
- `rtk npm run build` type-checks and builds the app.

## Working Notes

- Keep benchmark artifacts and cached HumanEval data out of commits unless a
  task explicitly asks for them.
- Treat prompts, model outputs, endpoint details, and reasoning traces as
  potentially sensitive. Benchmark pack datasets may be sensitive too — never
  commit them or run artifacts derived from them into this repository.
- Prefer updating README-level documentation for user-facing workflow changes.
- Keep implementation guidance here high-level so it does not drift from the
  code.

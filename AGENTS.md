# Agent Guide

This is a local HumanEval benchmark workbench for OpenAI-compatible chat
completion endpoints. The README is the source of truth for setup, runtime
workflow, and artifact details.

## Project Map

- `src/` contains the React/Vite UI.
- `scripts/humaneval-server.mjs` contains the local benchmark API server.
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
  potentially sensitive.
- Prefer updating README-level documentation for user-facing workflow changes.
- Keep implementation guidance here high-level so it does not drift from the
  code.

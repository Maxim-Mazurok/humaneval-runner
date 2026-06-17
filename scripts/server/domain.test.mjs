// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunArtifacts } from "./artifacts.mjs";
import {
  buildPromptMessages,
  compactResult,
  extractCode,
  extractTextFromDelta,
  normalizeBaseUrl,
  normalizeParallelTasks,
  normalizePassCount,
  parseTestNumbers,
  runSummary
} from "./domain.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

function runFixture(overrides = {}) {
  return {
    id: "run-1",
    dir: null,
    status: "completed",
    model: "demo-model",
    baseUrl: "http://localhost:8000/v1",
    createdAt: "2026-06-16T00:00:00.000Z",
    startedAt: "2026-06-16T00:00:00.000Z",
    finishedAt: "2026-06-16T00:00:01.000Z",
    total: 1,
    completed: 1,
    passed: 1,
    failed: 0,
    currentTaskId: null,
    activeTaskIds: [],
    selectedIndices: [0],
    parallelTasks: 1,
    passCount: 1,
    publicConfig: { maxTokens: 2048, testNumbers: "0" },
    results: [{
      taskId: "HumanEval/0",
      index: 0,
      entryPoint: "foo",
      passed: true,
      tests: [{ source: "assert foo(1) == 1", passed: true }],
      prompt: "def foo(x): pass",
      test: "assert foo(1) == 1",
      rawOutput: "```python\ndef foo(x): return x\n```",
      thinkingOutput: "private",
      extractedCode: "def foo(x): return x",
      generationMs: 100
    }],
    ...overrides
  };
}

describe("server domain helpers", () => {
  it("parses explicit test numbers, ranges, task ids, duplicates, and empty input", () => {
    expect(parseTestNumbers("", 10)).toEqual([]);
    expect(parseTestNumbers("0, 2 4-6 HumanEval/8 2", 10)).toEqual([0, 2, 4, 5, 6, 8]);
    expect(parseTestNumbers("5-3", 10)).toEqual([3, 4, 5]);
    expect(parseTestNumbers([3, "2", 3], 10)).toEqual([2, 3]);
    expect(() => parseTestNumbers("11", 10)).toThrow("Invalid test number");
  });

  it("normalizes base URLs and run bounds", () => {
    expect(normalizeBaseUrl(" http://localhost:8000/v1/ ")).toBe("http://localhost:8000/v1");
    expect(normalizeBaseUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(() => normalizeBaseUrl("")).toThrow("Base URL is required");
    expect(normalizeParallelTasks(99)).toBe(64);
    expect(normalizeParallelTasks(0)).toBe(1);
    expect(normalizePassCount(101)).toBe(100);
    expect(normalizePassCount(0)).toBe(1);
  });

  it("builds prompt messages, extracts streamed deltas, and extracts code", () => {
    const problem = { prompt: "def foo(x):\n    pass" };

    expect(buildPromptMessages(problem, " system ", "Solve:\n%problem_code%")).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "Solve:\ndef foo(x):\n    pass" }
    ]);
    expect(extractTextFromDelta({ reasoning: "think", content: "code", refusal: "no" })).toEqual([
      { channel: "thinking", text: "think" },
      { channel: "output", text: "code" },
      { channel: "refusal", text: "no" }
    ]);
    expect(extractCode("```python\ndef foo(x):\n    return x\n```", problem.prompt)).toBe("def foo(x):\n    return x");
    expect(extractCode("    return x", problem.prompt)).toBe(`${problem.prompt}return x`);
  });

  it("summarizes runs without leaking bulky result fields into compact events", () => {
    const run = runFixture();
    const summary = runSummary(run);
    const compact = compactResult(run.results[0]);

    expect(summary).toMatchObject({
      id: "run-1",
      liveScore: 1,
      finalScore: 1,
      assertionsPassed: 1,
      assertionsTotal: 1,
      assertionScore: 1,
      config: { baseUrl: "http://localhost:8000/v1", model: "demo-model", maxTokens: 2048 }
    });
    expect(runSummary(run, { includeResults: false }).results).toEqual([]);
    expect(compact.rawOutput).toBeUndefined();
    expect(compact.extractedCode).toBeUndefined();
    expect(compact.tests).toHaveLength(1);
  });

  it("writes run and result artifacts with public run state", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "humaneval-artifacts-"));
    tempDirs.push(dir);
    const run = runFixture();

    await writeRunArtifacts(run, dir);

    const runJson = JSON.parse(await fs.readFile(join(run.dir, "run.json"), "utf8"));
    const resultsJson = JSON.parse(await fs.readFile(join(run.dir, "results.json"), "utf8"));
    expect(runJson).toMatchObject({ id: "run-1", results: [], config: { testNumbers: "0" } });
    expect(resultsJson).toHaveLength(1);
    expect(resultsJson[0].rawOutput).toContain("```python");
  });
});

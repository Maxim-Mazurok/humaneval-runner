// @vitest-environment node
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bbehDataRevision } from "./benchmarks/bbehDataCorrections.mjs";
import { createRuntimeServer } from "./runtime.mjs";

const problems = [
  {
    task_id: "HumanEval/0",
    prompt: "def add_one(x):\n    \"\"\"Add one.\"\"\"\n",
    entry_point: "add_one",
    canonical_solution: "    return x + 1\n",
    test: "def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(2) == 3\n"
  },
  {
    task_id: "HumanEval/1",
    prompt: "def double(x):\n    \"\"\"Double.\"\"\"\n",
    entry_point: "double",
    canonical_solution: "    return x * 2\n",
    test: "def check(candidate):\n    assert candidate(2) == 4\n"
  },
  {
    task_id: "HumanEval/2",
    prompt: "def negate(x):\n    \"\"\"Negate.\"\"\"\n",
    entry_point: "negate",
    canonical_solution: "    return -x\n",
    test: "def check(candidate):\n    assert candidate(2) == -2\n"
  }
];

const goodSolutions = {
  add_one: "def add_one(x):\n    return x + 1",
  double: "def double(x):\n    return x * 2",
  negate: "def negate(x):\n    return -x"
};

let cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => {})));
  cleanups = [];
});

async function makeRootDir() {
  const rootDir = await fs.mkdtemp(join(tmpdir(), "he-runtime-"));
  cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(join(rootDir, ".cache"), { recursive: true });
  await fs.writeFile(
    join(rootDir, ".cache", "HumanEval.jsonl"),
    problems.map((problem) => JSON.stringify(problem)).join("\n")
  );
  return rootDir;
}

function sseFrames(res, texts, { entryPoint }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `thinking about ${entryPoint}` } }] })}\n\n`);
  for (const text of texts) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 7 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function entryPointFromRequest(body) {
  const userMessage = body.messages.find((message) => message.role === "user")?.content || "";
  const match = userMessage.match(/def (\w+)\(/);
  return match ? match[1] : null;
}

function goodModelHandler(req, res, body) {
  const entryPoint = entryPointFromRequest(body);
  const code = goodSolutions[entryPoint] || "pass";
  sseFrames(res, ["```python\n", `${code}\n`, "```"], { entryPoint });
}

function loopingModelHandler(req, res) {
  const repeatedCycle = [
    "Reconsider every available choice and compare each stated condition before selecting the final answer",
    "the first condition supports one option while the second condition rules that same option out",
    "therefore the unresolved comparison begins again from the start"
  ].join(". ");
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (let repetitionIndex = 0; repetitionIndex < 5; repetitionIndex += 1) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${repeatedCycle}. ` } }] })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function loopingThenGoodModelHandler(req, res, body) {
  const repeatedCycle = [
    "Reconsider every available choice and compare each stated condition before selecting the final answer",
    "the first condition supports one option while the second condition rules that same option out",
    "therefore the unresolved comparison begins again from the start"
  ].join(". ");
  const entryPoint = entryPointFromRequest(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (let repetitionIndex = 0; repetitionIndex < 5; repetitionIndex += 1) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${repeatedCycle}. ` } }] })}\n\n`);
  }
  for (const text of ["```python\n", `${goodSolutions[entryPoint]}\n`, "```"]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// Serves an OpenAI-compatible /chat/completions endpoint. `handlers` are
// consumed one per request; the last handler repeats for later requests.
async function startModelServer(handlers) {
  let requestCount = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, headers: req.headers, body });
    const handler = handlers[Math.min(requestCount, handlers.length - 1)];
    requestCount += 1;
    await handler(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

async function startRuntime(rootDir) {
  const app = createRuntimeServer({ rootDir, port: 0 });
  await app.loadPersistedRuns();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => app.server.close(resolve)));
  return { app, apiUrl: `http://127.0.0.1:${app.server.address().port}` };
}

async function createRun(apiUrl, modelBaseUrl, overrides = {}) {
  const response = await fetch(`${apiUrl}/api/humaneval/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: modelBaseUrl,
      model: "test-model",
      maxTokens: 512,
      timeoutSeconds: 10,
      ...overrides
    })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "createRun failed");
  return json;
}

async function waitForStatus(apiUrl, runId, statuses, timeout = 20_000) {
  let detail;
  await vi.waitFor(async () => {
    detail = await fetch(`${apiUrl}/api/humaneval/runs/${runId}`).then((response) => response.json());
    expect(statuses).toContain(detail.status);
  }, { timeout, interval: 50 });
  return detail;
}

describe("runtime server", () => {
  it("rejects a non-positive adaptive starting penalty", async () => {
    const rootDir = await makeRootDir();
    const { apiUrl } = await startRuntime(rootDir);

    const response = await fetch(`${apiUrl}/api/humaneval/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://model.test/v1",
        model: "test-model",
        adaptiveRepetitionPenalty: true,
        repetitionPenalty: 0
      })
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Starting repetition penalty must be greater than zero."
    });
  });

  it("stops loops and adapts repetition penalties across tasks", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([loopingModelHandler, goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      parallelTasks: 8,
      testNumbers: "0-1"
    });
    expect(created.config).toMatchObject({
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      parallelTasks: 1,
      loopDetectionConfig: { version: "4", repetitionCount: 5 }
    });

    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail.results[0]).toMatchObject({
      taskId: "HumanEval/0",
      passed: false,
      looping: true,
      repetitionPenalty: 0.5,
      finishReason: "loop",
      loopDetection: { channel: "thinking", repetitions: 5 }
    });
    expect(detail.results[1]).toMatchObject({
      taskId: "HumanEval/1",
      passed: true,
      repetitionPenalty: 0.55
    });
    expect(model.requests.map((request) => request.body.repetition_penalty)).toEqual([0.5, 0.55]);

    const penaltyEvents = detail.events.filter((event) => event.type === "repetition-penalty-updated");
    expect(penaltyEvents.map((event) => event.data.nextRepetitionPenalty)).toEqual([0.55, 0.52]);
    expect(detail.events.some((event) => event.type === "loop-detected")).toBe(true);
  });

  it("does not stop loops when adaptive repetition penalties are disabled", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([loopingThenGoodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: false,
      testNumbers: "0"
    });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);

    expect(detail.results[0]).toMatchObject({
      taskId: "HumanEval/0",
      passed: true,
      finishReason: "stop"
    });
    expect(detail.results[0].looping).toBeUndefined();
    expect(detail.results[0].loopDetection).toBeUndefined();
    expect(detail.events.some((event) => event.type === "loop-detected")).toBe(false);
  });

  it("completes a full run: scores, events, artifacts, task logs, SSE replay", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const problemsResponse = await fetch(`${apiUrl}/api/humaneval/problems`).then((response) => response.json());
    expect(problemsResponse.total).toBe(3);
    expect(problemsResponse.problems[0]).toEqual({ taskId: "HumanEval/0", entryPoint: "add_one" });

    const created = await createRun(apiUrl, model.baseUrl, {
      apiKey: "sk-secret",
      testNumbers: "0-1",
      extraBody: { repetition_penalty: 0 }
    });
    expect(["queued", "running"]).toContain(created.status);
    expect(created.total).toBe(2);

    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      assertionsPassed: 3,
      assertionsTotal: 3
    });
    expect(detail.results.map((result) => result.taskId)).toEqual(["HumanEval/0", "HumanEval/1"]);
    expect(detail.results[0]).toMatchObject({
      attemptId: "HumanEval/0::pass-1",
      passed: true,
      entryPoint: "add_one",
      extractedCode: goodSolutions.add_one,
      thinkingOutput: "thinking about add_one",
      finishReason: "stop",
      usage: { completion_tokens: 7 }
    });
    expect(detail.results[0].tests).toHaveLength(2);
    expect(detail.results[0].instructionPrompt).toContain("SYSTEM:");

    const eventTypes = detail.events.map((event) => event.type);
    for (const expected of ["run-started", "task-started", "prompt", "token", "code-extracted", "task-finished", "done"]) {
      expect(eventTypes).toContain(expected);
    }

    // Model requests carry auth + streaming options.
    expect(model.requests[0].url).toBe("/v1/chat/completions");
    expect(model.requests[0].headers.authorization).toBe("Bearer sk-secret");
    expect(model.requests[0].body).toMatchObject({ model: "test-model", stream: true });
    expect(model.requests[0].body).not.toHaveProperty("repetition_penalty");

    // API key never appears in the summary or persisted artifacts.
    expect(JSON.stringify(detail)).not.toContain("sk-secret");

    const runsList = await fetch(`${apiUrl}/api/humaneval/runs`).then((response) => response.json());
    expect(runsList.runs.map((run) => run.id)).toContain(created.id);

    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    expect(runDirs).toHaveLength(1);
    const runDir = join(rootDir, "benchmark-runs", runDirs[0]);
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8"));
      expect(runJson.status).toBe("completed");
    });
    const resultsJson = JSON.parse(await fs.readFile(join(runDir, "results.json"), "utf8"));
    expect(resultsJson).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8")))).not.toContain("sk-secret");
    const taskLogs = (await fs.readFile(join(runDir, "task-logs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const logChannels = new Set(taskLogs.map((entry) => entry.channel));
    for (const channel of ["prompt", "model-output", "thinking-output", "extracted-code"]) {
      expect(logChannels).toContain(channel);
    }

    // SSE endpoint replays past events for late subscribers.
    const sseResponse = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}/events`);
    const reader = sseResponse.body.getReader();
    let sseText = "";
    while (!sseText.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(sseText).toContain("event: run-started");
    expect(sseText).toContain("event: task-finished");
  });

  it("records failing assertions when the model returns wrong code", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res, body) => sseFrames(res, ["```python\ndef add_one(x):\n    return x + 2\n```"], { entryPoint: entryPointFromRequest(body) })
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 0, failed: 1, finalScore: 0 });
    const [result] = detail.results;
    expect(result.passed).toBe(false);
    expect(result.tests.length).toBeGreaterThan(0);
    expect(result.tests.some((test) => !test.passed)).toBe(true);
    const failing = result.tests.find((test) => !test.passed);
    expect(failing).toMatchObject({ operator: "==" });
    expect(failing.actual).toBeDefined();
    expect(failing.expected).toBeDefined();
  });

  it("records a modelError result when the model endpoint fails, and the run continues", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      },
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0-1" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 2, passed: 1, failed: 1 });
    const failed = detail.results.find((result) => result.taskId === "HumanEval/0");
    expect(failed.modelError).toContain("HTTP 500");
    expect(failed.passed).toBe(false);
    const succeeded = detail.results.find((result) => result.taskId === "HumanEval/1");
    expect(succeeded.passed).toBe(true);
  });

  it("runs multiple passes with parallel workers and distinct attempt ids", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0-2", passCount: 2, parallelTasks: 2 });
    expect(created.total).toBe(6);
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 6, passed: 6, failed: 0, finalScore: 1 });
    const attemptIds = detail.results.map((result) => result.attemptId).sort();
    expect(attemptIds).toEqual([
      "HumanEval/0::pass-1",
      "HumanEval/0::pass-2",
      "HumanEval/1::pass-1",
      "HumanEval/1::pass-2",
      "HumanEval/2::pass-1",
      "HumanEval/2::pass-2"
    ]);
  });

  it("marks timed-out executions as failures with a timeout error", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res, body) => sseFrames(res, ["```python\ndef add_one(x):\n    while True:\n        pass\n```"], { entryPoint: entryPointFromRequest(body) })
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0", timeoutSeconds: 1 });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    const [result] = detail.results;
    expect(result.passed).toBe(false);
    expect(result.timeout).toBe(true);
    expect(result.error).toContain("timed out");
  }, 15_000);

  it("cancels a running run, then resumes it to completion", async () => {
    const rootDir = await makeRootDir();
    let hangingResponses = [];
    const model = await startModelServer([
      loopingModelHandler,
      (req, res) => {
        // Second request: stream one token, then hang until the client aborts.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        hangingResponses.push(res);
        req.on("close", () => res.end());
      },
      goodModelHandler,
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      testNumbers: "0-2"
    });
    await vi.waitFor(() => {
      expect(hangingResponses.length).toBe(1);
    });

    const cancelled = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}/cancel`, { method: "POST" }).then((response) => response.json());
    expect(cancelled.status === "cancelled" || cancelled.status === "running").toBe(true);
    const afterCancel = await waitForStatus(apiUrl, created.id, ["cancelled"]);
    expect(afterCancel).toMatchObject({ completed: 1, failed: 1 });
    expect(afterCancel.results[0]).toMatchObject({ looping: true, repetitionPenalty: 0.5 });

    const resumed = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}/resume`, { method: "POST" }).then((response) => response.json());
    expect(resumed.status).toBe("queued");
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 3, passed: 2, failed: 1 });
    expect(model.requests.map((request) => request.body.repetition_penalty)).toEqual([
      0.5,
      0.55,
      0.55,
      0.52
    ]);
  }, 15_000);

  it("deletes a run and removes its artifacts from disk", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await waitForStatus(apiUrl, created.id, ["completed"]);

    const deleted = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}`, { method: "DELETE" }).then((response) => response.json());
    expect(deleted).toEqual({ ok: true });
    const missing = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}`);
    expect(missing.status).toBe(404);
    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    expect(runDirs).toHaveLength(0);
  });

  it("runs a bbeh-mini benchmark end to end with fuzzy answer scoring", async () => {
    const rootDir = await makeRootDir();
    await fs.mkdir(join(rootDir, ".cache", "bbeh"), { recursive: true });
    await fs.writeFile(join(rootDir, ".cache", "bbeh", "mini.json"), JSON.stringify({
      examples: [
        { input: "Is water wet? Reply Yes or No.", target: "Yes", subtask: "causal_understanding" },
        { input: "What is 3 + 4?", target: "7", subtask: "time_arithmetic" }
      ],
      canary: "test"
    }));
    const model = await startModelServer([
      (req, res, body) => {
        const question = body.messages.find((message) => message.role === "user")?.content || "";
        const answer = question.includes("water") ? "The answer is: yes." : "The answer is: 8.";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "pondering" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `I thought about it. ${answer}` } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const benchmarksResponse = await fetch(`${apiUrl}/api/benchmarks`).then((response) => response.json());
    expect(benchmarksResponse.benchmarks.map((benchmark) => benchmark.id)).toEqual([
      "humaneval",
      "bbeh-mini",
      "bbeh-mini-official",
      "bbeh-full",
      "bbeh-full-official"
    ]);
    expect(benchmarksResponse.benchmarks.find((benchmark) => benchmark.id === "bbeh-mini").dataRevision).toBe(bbehDataRevision);

    const problemsResponse = await fetch(`${apiUrl}/api/benchmarks/bbeh-mini/problems`).then((response) => response.json());
    expect(problemsResponse).toMatchObject({ benchmark: "bbeh-mini", total: 2 });
    expect(problemsResponse.problems[0]).toEqual({ taskId: "bbeh_mini/0", subtask: "mini" });

    const created = await createRun(apiUrl, model.baseUrl, { benchmark: "bbeh-mini" });
    expect(created.benchmark).toBe("bbeh-mini");
    expect(created.benchmarkDataRevision).toBe(bbehDataRevision);
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({
      completed: 2,
      passed: 1,
      failed: 1,
      assertionsPassed: 1,
      assertionsTotal: 2
    });
    const correct = detail.results.find((result) => result.taskId === "bbeh_mini/0");
    expect(correct).toMatchObject({
      passed: true,
      subtask: "mini",
      extractedCode: "yes",
      expectedAnswer: "Yes",
      thinkingOutput: "pondering"
    });
    expect(correct.test).toBe("Expected answer: Yes");
    const wrong = detail.results.find((result) => result.taskId === "bbeh_mini/1");
    expect(wrong).toMatchObject({ passed: false, extractedCode: "8", expectedAnswer: "7" });
    expect(wrong.tests[0]).toMatchObject({ passed: false, actual: "8", expected: "7" });
    expect(detail.config).toMatchObject({ benchmark: "bbeh-mini" });
    expect(detail.benchmarkDataRevision).toBe(bbehDataRevision);
    // BBEH default prompts flow through when the client does not override them.
    expect(correct.instructionPrompt).toContain("The answer is: <answer>");
    expect(correct.instructionPrompt).toContain("Is water wet?");

    const runDirectories = await fs.readdir(join(rootDir, "benchmark-runs"));
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(rootDir, "benchmark-runs", runDirectories[0], "run.json"), "utf8"));
      expect(runJson.benchmarkDataRevision).toBe(bbehDataRevision);
    });
  });

  it("rejects resuming a BBEH run created with an older data revision", async () => {
    const rootDir = await makeRootDir();
    await fs.mkdir(join(rootDir, ".cache", "bbeh"), { recursive: true });
    await fs.writeFile(join(rootDir, ".cache", "bbeh", "mini.json"), JSON.stringify({
      examples: [{ input: "Is water wet?", target: "Yes" }]
    }));
    const hangingResponses = [];
    const model = await startModelServer([
      (request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        hangingResponses.push(response);
        request.on("close", () => response.end());
      }
    ]);
    const { app, apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { benchmark: "bbeh-mini" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    await fetch(`${apiUrl}/api/humaneval/runs/${created.id}/cancel`, { method: "POST" });
    await waitForStatus(apiUrl, created.id, ["cancelled"]);

    app.runs.get(created.id).benchmarkDataRevision = null;
    const historicalRun = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}`).then((response) => response.json());
    expect(historicalRun.status).toBe("cancelled");

    const resumeResponse = await fetch(`${apiUrl}/api/humaneval/runs/${created.id}/resume`, { method: "POST" });
    expect(resumeResponse.status).toBe(500);
    await expect(resumeResponse.json()).resolves.toEqual({
      error: `Run uses benchmark data revision "unversioned", but the current revision is "${bbehDataRevision}". Start a new run instead.`
    });
  });

  it("reloads persisted runs after a restart with results and config intact", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const first = await startRuntime(rootDir);

    const created = await createRun(first.apiUrl, model.baseUrl, { testNumbers: "0-1", maxTokens: 999 });
    await waitForStatus(first.apiUrl, created.id, ["completed"]);
    // Artifact writes are fire-and-forget; wait for the persisted status.
    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(rootDir, "benchmark-runs", runDirs[0], "run.json"), "utf8"));
      expect(runJson.status).toBe("completed");
    });

    const second = await startRuntime(rootDir);
    const reloaded = await fetch(`${second.apiUrl}/api/humaneval/runs/${created.id}`).then((response) => response.json());
    expect(reloaded).toMatchObject({
      id: created.id,
      status: "completed",
      completed: 2,
      passed: 2,
      model: "test-model"
    });
    expect(reloaded.config).toMatchObject({ maxTokens: 999, testNumbers: "0-1" });
    expect(reloaded.results).toHaveLength(2);
    expect(reloaded.results[0].extractedCode).toBe(goodSolutions.add_one);
  });
});

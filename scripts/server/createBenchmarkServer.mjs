import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeRunArtifacts } from "./artifacts.mjs";
import {
  buildPromptMessages,
  compactResult,
  extractCode,
  normalizeBaseUrl,
  normalizeParallelTasks,
  normalizePassCount,
  parseTestNumbers,
  redactApiKey,
  runSummary
} from "./domain.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function readModelText(response) {
  const body = await response.text();
  if (!body.includes("data:")) return body;
  let output = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = JSON.parse(payload);
    output += parsed.choices?.[0]?.delta?.content ?? "";
  }
  return output;
}

export function createBenchmarkServer({
  problems,
  runsDir,
  fetchImpl = fetch,
  executeTests = async () => ({ passed: true, tests: [] }),
  now = () => new Date()
}) {
  const runs = new Map();

  function appendEvent(run, type, data = {}) {
    run.eventSeq += 1;
    const event = { id: run.eventSeq, type, at: now().toISOString(), data };
    run.events.push(event);
    for (const client of run.clients) {
      client.write(`id: ${event.id}\n`);
      client.write(`event: ${type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    return event;
  }

  async function runBenchmark(run) {
    run.status = "running";
    run.startedAt = now().toISOString();
    const selectedIndices = run.selectedIndices.length
      ? run.selectedIndices
      : Array.from({ length: Math.max(0, run.plannedTaskCount) }, (_, offset) => run.startIndex + offset);
    run.selectedIndices = selectedIndices;
    run.total = selectedIndices.length * run.passCount;
    appendEvent(run, "run-started", { summary: runSummary(run, { includeResults: false }) });
    for (let passNumber = 1; passNumber <= run.passCount; passNumber += 1) {
      for (const index of selectedIndices) {
        const problem = problems[index];
        const attemptId = `${problem.task_id}::pass-${passNumber}`;
        appendEvent(run, "task-started", {
          taskId: problem.task_id,
          attemptId,
          passNumber,
          passTotal: run.passCount,
          index,
          entryPoint: problem.entry_point,
          prompt: problem.prompt,
          test: problem.test,
          summary: runSummary(run, { includeResults: false })
        });
        const messages = buildPromptMessages(problem, run.systemPrompt, run.promptTemplate);
        appendEvent(run, "prompt", { taskId: problem.task_id, attemptId, passNumber, index, messages });
        const modelResponse = await fetchImpl(`${run.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: run.model, messages, stream: true, temperature: run.temperature, max_tokens: run.maxTokens })
        });
        const rawOutput = await readModelText(modelResponse);
        const extractedCode = extractCode(rawOutput, problem.prompt);
        const testResult = await executeTests(problem, extractedCode, run.timeoutSeconds);
        const result = {
          taskId: problem.task_id,
          attemptId,
          passNumber,
          passTotal: run.passCount,
          index,
          entryPoint: problem.entry_point,
          passed: Boolean(testResult.passed),
          tests: testResult.tests || [],
          prompt: problem.prompt,
          test: problem.test,
          rawOutput,
          extractedCode,
          error: testResult.error || null,
          traceback: testResult.traceback || null
        };
        run.results.push(result);
        run.completed += 1;
        if (result.passed) run.passed += 1;
        else run.failed += 1;
        appendEvent(run, "task-finished", { result: compactResult(result), summary: runSummary(run, { includeResults: false }) });
        await writeRunArtifacts(run, runsDir);
      }
    }
    run.status = "completed";
    run.finishedAt = now().toISOString();
    appendEvent(run, "done", { summary: runSummary(run, { includeResults: false }) });
    await writeRunArtifacts(run, runsDir);
  }

  async function createRun(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const selectedIndices = parseTestNumbers(config.testNumbers, problems.length);
    const sampleLimit = Number(config.sampleLimit ?? 0);
    const startIndex = Number(config.startIndex ?? 0);
    const plannedTaskCount = selectedIndices.length || (sampleLimit > 0 ? sampleLimit : problems.length - startIndex);
    const id = `test-${runs.size + 1}`;
    const run = {
      id,
      dir: join(runsDir, id),
      status: "queued",
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      model: String(config.model || "").trim(),
      baseUrl,
      temperature: Number(config.temperature ?? 0),
      maxTokens: Number(config.maxTokens ?? 2048),
      timeoutSeconds: Number(config.timeoutSeconds ?? 15),
      parallelTasks: normalizeParallelTasks(config.parallelTasks),
      passCount: normalizePassCount(config.passCount),
      sampleLimit,
      startIndex,
      plannedTaskCount,
      selectedIndices,
      systemPrompt: String(config.systemPrompt ?? ""),
      promptTemplate: String(config.promptTemplate ?? ""),
      publicConfig: { baseUrl, model: String(config.model || "").trim(), apiKey: redactApiKey(config.apiKey), testNumbers: String(config.testNumbers || "") },
      total: plannedTaskCount,
      completed: 0,
      passed: 0,
      failed: 0,
      currentTaskId: null,
      activeTaskIds: [],
      results: [],
      events: [],
      eventSeq: 0,
      clients: new Set()
    };
    if (!run.model) throw new Error("Model name is required.");
    await mkdir(run.dir, { recursive: true });
    await writeFile(join(run.dir, "task-logs.jsonl"), "");
    runs.set(id, run);
    queueMicrotask(() => runBenchmark(run));
    return run;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return sendJson(res, 200, {});
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/api/humaneval/runs") {
        return sendJson(res, 200, { runs: [...runs.values()].map((run) => runSummary(run, { includeResults: false })) });
      }
      if (req.method === "POST" && url.pathname === "/api/humaneval/runs") {
        const run = await createRun(await readJsonBody(req));
        return sendJson(res, 201, runSummary(run));
      }
      const runMatch = url.pathname.match(/^\/api\/humaneval\/runs\/([^/]+)(?:\/events)?$/);
      if (runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) return sendJson(res, 404, { error: "Run not found" });
        if (url.pathname.endsWith("/events")) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
          for (const event of run.events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          run.clients.add(res);
          req.on("close", () => run.clients.delete(res));
          return;
        }
        return sendJson(res, 200, { ...runSummary(run), events: run.events });
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { server, runs };
}

#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  buildPromptMessages,
  compactResult,
  defaultPromptTemplate,
  defaultSystemPrompt,
  discardResumeArtifacts,
  extractCode,
  extractTextFromDelta,
  normalizeBaseUrl,
  normalizeParallelTasks,
  normalizePassCount,
  parseTestNumbers,
  persistedRunState,
  redactApiKey,
  resultAttemptId,
  runDirName,
  runtimeConfigFromPersistedRun,
  runSummary,
  syncRunCountsFromResults
} from "./domain.mjs";
import { fetchModelResponseWithRetry, throwIfRetryableModelOutput } from "./modelRetry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "../..");
const cacheDir = join(rootDir, ".cache");
const runsDir = join(rootDir, "benchmark-runs");
const humanEvalPath = join(cacheDir, "HumanEval.jsonl");
const humanEvalUrl = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz";
const port = Number(process.env.HUMANEVAL_PORT || 8787);
const runs = new Map();
const taskLogWriteQueues = new Map();
const maxReplayEvents = 5000;
const performanceLogEnabled = process.env.HUMANEVAL_PERFORMANCE_LOG === "1";

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function logPerformance(fields) {
  if (!performanceLogEnabled) return;
  console.log(`[PERF] ${JSON.stringify({ at: new Date().toISOString(), ...fields })}`);
}

function runPerformanceMetrics(run) {
  if (!performanceLogEnabled) return null;
  run.performanceMetrics ??= {
    totalEventCount: 0,
    totalEventBytes: 0,
    eventTypes: {}
  };
  return run.performanceMetrics;
}

function sendJson(res, status, payload, performanceFields = {}) {
  const serializationStartedAt = performance.now();
  const serializedPayload = JSON.stringify(payload);
  const serializationMilliseconds = performance.now() - serializationStartedAt;
  const responseBytes = byteLength(serializedPayload);
  logPerformance({
    type: "json-response",
    status,
    responseBytes,
    serializationMilliseconds: Number(serializationMilliseconds.toFixed(3)),
    ...performanceFields
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(responseBytes),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(serializedPayload);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function ensureHumanEvalData() {
  try {
    await fs.access(humanEvalPath);
  } catch {
    await fs.mkdir(cacheDir, { recursive: true });
    const response = await fetch(humanEvalUrl);
    if (!response.ok) {
      throw new Error(`Failed to download HumanEval data: HTTP ${response.status}`);
    }
    const compressed = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(humanEvalPath, gunzipSync(compressed));
  }

  const raw = await fs.readFile(humanEvalPath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function ensureRunDir(run) {
  if (!run.dir) run.dir = join(runsDir, runDirName(run));
  return run.dir;
}

async function writeRunArtifacts(run) {
  if (run.deleted) return;
  ensureRunDir(run);
  await fs.mkdir(run.dir, { recursive: true });
  await Promise.all([
    fs.writeFile(join(run.dir, "run.json"), JSON.stringify(persistedRunState(run), null, 2)),
    fs.writeFile(join(run.dir, "results.json"), JSON.stringify(run.results, null, 2))
  ]);
}

function persistRunArtifacts(run) {
  if (run.deleted) return;
  writeRunArtifacts(run).catch((error) => {
    console.error(`Failed to persist run ${run.id}:`, error);
  });
}

async function appendTaskLogLine(run, entry) {
  if (run.deleted) return;
  ensureRunDir(run);
  const previous = taskLogWriteQueues.get(run.id) || Promise.resolve();
  const next = previous.then(async () => {
    if (run.deleted) return;
    await fs.mkdir(run.dir, { recursive: true });
    await fs.appendFile(join(run.dir, "task-logs.jsonl"), `${JSON.stringify(entry)}\n`);
  });
  taskLogWriteQueues.set(run.id, next.catch(() => {}));
  await next;
}

async function appendTaskLogs(run, result) {
  const base = {
    at: new Date().toISOString(),
    taskId: result.taskId,
    attemptId: result.attemptId,
    passNumber: result.passNumber,
    passTotal: result.passTotal,
    index: result.index,
    entryPoint: result.entryPoint,
    passed: result.passed
  };
  const entries = [
    { ...base, channel: "prompt", text: result.instructionPrompt || "" },
    { ...base, channel: "model-output", text: result.rawOutput || "" },
    { ...base, channel: "thinking-output", text: result.thinkingOutput || "" },
    { ...base, channel: "extracted-code", text: result.extractedCode || "" },
    { ...base, channel: "harness", text: result.traceback || result.error || result.harnessStderr || result.harnessStdout || "" }
  ];
  await Promise.all(entries.filter((entry) => entry.text).map((entry) => appendTaskLogLine(run, entry)));
}

function appendEvent(run, type, data = {}) {
  if (run.deleted) return;
  run.eventSeq = (run.eventSeq || 0) + 1;
  const event = {
    id: run.eventSeq,
    type,
    at: new Date().toISOString(),
    data
  };
  const serializedEvent = JSON.stringify(event);
  const eventBytes = byteLength(serializedEvent);
  const performanceMetrics = runPerformanceMetrics(run);
  if (performanceMetrics) {
    performanceMetrics.totalEventCount += 1;
    performanceMetrics.totalEventBytes += eventBytes;
    const eventTypeMetrics = performanceMetrics.eventTypes[type] || { count: 0, bytes: 0 };
    performanceMetrics.eventTypes[type] = {
      count: eventTypeMetrics.count + 1,
      bytes: eventTypeMetrics.bytes + eventBytes
    };
  }
  run.events.push(event);
  if (run.events.length > maxReplayEvents) run.events.splice(0, run.events.length - maxReplayEvents);
  if (type !== "token" && type !== "raw" && type !== "raw-delta") persistRunArtifacts(run);
  for (const res of run.clients) {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${serializedEvent}\n\n`);
  }
}

function logTerminalRunPerformance(run, status) {
  const performanceMetrics = runPerformanceMetrics(run);
  if (!performanceMetrics) return;
  const largestEventType = Object.entries(performanceMetrics.eventTypes)
    .sort(([, left], [, right]) => right.bytes - left.bytes)[0];
  logPerformance({
    type: "run-terminal",
    runId: run.id,
    status,
    totalEventCount: performanceMetrics.totalEventCount,
    totalEventBytes: performanceMetrics.totalEventBytes,
    replayEventCount: run.events.length,
    resultCount: run.results.length,
    largestEventType: largestEventType ? largestEventType[0] : null,
    largestEventTypeBytes: largestEventType ? largestEventType[1].bytes : 0,
    tokenEventCount: performanceMetrics.eventTypes.token?.count || 0,
    tokenEventBytes: performanceMetrics.eventTypes.token?.bytes || 0,
    memoryRssBytes: process.memoryUsage().rss,
    memoryHeapUsedBytes: process.memoryUsage().heapUsed
  });
}

async function readModelResponse(response, run, problem, index, context, started) {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model request failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let thinking = "";
  let transcript = "";
  let raw = "";
  let usage = null;
  let finishReason = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        raw += `${payload}\n`;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          appendEvent(run, "raw", { taskId: problem.task_id, index, ...context, text: payload });
          continue;
        }
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta ?? {};
        const parts = extractTextFromDelta(delta);
        for (const part of parts) {
          transcript += part.text;
          if (part.channel === "output") output += part.text;
          if (part.channel === "thinking") thinking += part.text;
          appendEvent(run, "token", { taskId: problem.task_id, index, ...context, ...part });
        }
        if (!parts.length && Object.keys(delta).length) {
          appendEvent(run, "raw-delta", { taskId: problem.task_id, index, ...context, delta });
        }
      }
    }
  }
  throwIfRetryableModelOutput(thinking, output);
  return { output, thinking, transcript, raw, usage, finishReason, elapsedMs: Date.now() - started };
}

async function callModel(run, problem, index, context = {}) {
  const controller = new AbortController();
  run.abortControllers ??= new Set();
  run.abortControllers.add(controller);
  run.abortController = controller;
  const messages = buildPromptMessages(problem, run.systemPrompt, run.promptTemplate);
  const body = {
    model: run.model,
    messages,
    stream: true,
    temperature: run.temperature,
    max_tokens: run.maxTokens,
    stream_options: { include_usage: true }
  };
  if (run.extraBody && Object.keys(run.extraBody).length) Object.assign(body, run.extraBody);

  appendEvent(run, "prompt", { taskId: problem.task_id, index, ...context, messages, request: { ...body, messages } });
  const started = Date.now();
  try {
    return await fetchModelResponseWithRetry({
      fetchImplementation: fetch,
      requestUrl: `${run.baseUrl}/chat/completions`,
      requestOptions: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(run.apiKey ? { authorization: `Bearer ${run.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      },
      signal: controller.signal,
      shouldStop: () => run.cancelled,
      processResponse: (response) => readModelResponse(response, run, problem, index, context, started),
      onRetry: ({ attemptNumber, errorMessage, retryDelayMilliseconds }) => {
        appendEvent(run, "model-retry", { taskId: problem.task_id, index, ...context, attemptNumber, error: errorMessage, retryDelayMilliseconds });
      }
    });
  } finally {
    run.abortControllers?.delete(controller);
    if (run.abortController === controller) run.abortController = null;
  }
}

function pythonHarness(userCode, testCode, entryPoint) {
  return `
import ast, contextlib, io, json, os, sys, tempfile, traceback
os.environ["OMP_NUM_THREADS"] = "1"
USER_CODE = ${JSON.stringify(userCode)}
TEST_CODE = ${JSON.stringify(testCode)}
ENTRY_POINT = ${JSON.stringify(entryPoint)}
records = []

def __he_safe_repr(value):
    try:
        return repr(value)
    except BaseException as exc:
        return f"<repr failed: {exc}>"

def __he_record(source, passed, error=None, traceback_text=None, actual=None, expected=None, operator=None):
    record = {"source": source, "passed": bool(passed), "error": error, "traceback": traceback_text}
    if actual is not None:
        record["actual"] = actual
    if expected is not None:
        record["expected"] = expected
    if operator is not None:
        record["operator"] = operator
    records.append(record)

def __he_compare(left, right, operator):
    if operator == "==":
        return left == right
    if operator == "!=":
        return left != right
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    if operator == "is":
        return left is right
    if operator == "is not":
        return left is not right
    if operator == "in":
        return left in right
    if operator == "not in":
        return left not in right
    return bool(left)

def __he_record_comparison(source, left, right, operator):
    passed = __he_compare(left, right, operator)
    __he_record(source, passed, actual=__he_safe_repr(left), expected=__he_safe_repr(right), operator=operator)

def __he_record_truthy(source, value):
    __he_record(source, bool(value), actual=__he_safe_repr(value), expected="truthy")

class InstrumentAsserts(ast.NodeTransformer):
    _op_names = {
        ast.Eq: "==",
        ast.NotEq: "!=",
        ast.Lt: "<",
        ast.LtE: "<=",
        ast.Gt: ">",
        ast.GtE: ">=",
        ast.Is: "is",
        ast.IsNot: "is not",
        ast.In: "in",
        ast.NotIn: "not in",
    }

    def visit_Assert(self, node):
        source = ast.get_source_segment(TEST_CODE, node) or "assert ..."
        failed_call = ast.Expr(value=ast.Call(func=ast.Name(id="__he_record", ctx=ast.Load()), args=[ast.Constant(source), ast.Constant(False), ast.Call(func=ast.Name(id="str", ctx=ast.Load()), args=[ast.Name(id="__he_exc", ctx=ast.Load())], keywords=[]), ast.Call(func=ast.Attribute(value=ast.Name(id="traceback", ctx=ast.Load()), attr="format_exc", ctx=ast.Load()), args=[], keywords=[])], keywords=[]))

        if isinstance(node.test, ast.Compare) and len(node.test.ops) == 1 and len(node.test.comparators) == 1:
            operator = self._op_names.get(type(node.test.ops[0]), type(node.test.ops[0]).__name__)
            record_call = ast.Expr(value=ast.Call(
                func=ast.Name(id="__he_record_comparison", ctx=ast.Load()),
                args=[
                    ast.Constant(source),
                    node.test.left,
                    node.test.comparators[0],
                    ast.Constant(operator),
                ],
                keywords=[],
            ))
            return ast.Try(body=[record_call], handlers=[ast.ExceptHandler(type=ast.Name(id="BaseException", ctx=ast.Load()), name="__he_exc", body=[failed_call])], orelse=[], finalbody=[])

        record_call = ast.Expr(value=ast.Call(
            func=ast.Name(id="__he_record_truthy", ctx=ast.Load()),
            args=[ast.Constant(source), node.test],
            keywords=[],
        ))
        return ast.Try(body=[record_call], handlers=[ast.ExceptHandler(type=ast.Name(id="BaseException", ctx=ast.Load()), name="__he_exc", body=[failed_call])], orelse=[], finalbody=[])

def reliability_guard():
    import builtins, shutil, subprocess
    builtins.exit = None
    builtins.quit = None
    os.kill = None
    os.system = None
    os.remove = None
    os.removedirs = None
    os.rmdir = None
    os.rename = None
    os.renames = None
    os.truncate = None
    os.replace = None
    os.unlink = None
    shutil.rmtree = None
    shutil.move = None
    subprocess.Popen = None

try:
    reliability_guard()
    ns = {
        "__he_record": __he_record,
        "__he_record_comparison": __he_record_comparison,
        "__he_record_truthy": __he_record_truthy,
        "traceback": traceback,
    }
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(USER_CODE, ns)
        tree = ast.parse(TEST_CODE)
        tree = InstrumentAsserts().visit(tree)
        ast.fix_missing_locations(tree)
        exec(compile(tree, "<humaneval-tests>", "exec"), ns)
        candidate = ns[ENTRY_POINT]
        ns["check"](candidate)
    failed = [record for record in records if not record["passed"]]
    print(json.dumps({
        "passed": len(failed) == 0,
        "tests": records,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "error": None
    }))
except BaseException as exc:
    print(json.dumps({
        "passed": False,
        "tests": records,
        "stdout": locals().get("stdout").getvalue() if "stdout" in locals() else "",
        "stderr": locals().get("stderr").getvalue() if "stderr" in locals() else "",
        "error": str(exc),
        "traceback": traceback.format_exc()
    }))
`;
}

async function executeTests(problem, code, timeoutSeconds) {
  const directory = await fs.mkdtemp(join(tmpdir(), "humaneval-"));
  const scriptPath = join(directory, "run.py");
  await fs.writeFile(scriptPath, pythonHarness(code, problem.test, problem.entry_point), "utf8");
  return await new Promise((resolve) => {
    const child = spawn("python3", [scriptPath], {
      cwd: directory,
      env: { PATH: process.env.PATH || "/usr/bin:/usr/local/bin", LANG: "en_US.UTF-8", HOME: directory }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async () => {
      clearTimeout(timeout);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
      try {
        const parsed = lastLine ? JSON.parse(lastLine) : {};
        resolve({ ...parsed, harnessStdout: stdout, harnessStderr: stderr });
      } catch {
        if (timedOut) {
          resolve({ passed: false, tests: [], stdout, stderr, error: "Execution timed out", timeout: true, harnessStdout: stdout, harnessStderr: stderr });
          return;
        }
        resolve({ passed: false, tests: [], stdout, stderr, error: "Harness returned non-JSON output", harnessStdout: stdout, harnessStderr: stderr });
      }
    });
  });
}

async function runHumanEval(run) {
  if (run.deleted || run.cancelled) return;
  run.status = "running";
  run.startedAt = run.startedAt || new Date().toISOString();
  run.finishedAt = null;
  ensureRunDir(run);
  try {
    const allProblems = await ensureHumanEvalData();
    const selectedIndices = run.selectedIndices?.length
      ? run.selectedIndices
      : (() => {
          const start = Math.max(0, run.startIndex);
          const end = run.sampleLimit > 0 ? Math.min(allProblems.length, start + run.sampleLimit) : allProblems.length;
          return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
        })();
    run.selectedIndices = selectedIndices;
    const problems = selectedIndices.map((index) => allProblems[index]);
    const passCount = normalizePassCount(run.passCount);
    run.passCount = passCount;
    run.total = problems.length * passCount;
    syncRunCountsFromResults(run);
    run.activeTaskIds = [];
    const completedAttemptIds = new Set(run.results.map(resultAttemptId).filter(Boolean));
    appendEvent(run, "run-started", {
      summary: runSummary(run, { includeResults: false }),
      datasetSize: allProblems.length,
      passCount
    });

    async function finishTask(result) {
      run.activeTaskIds = (run.activeTaskIds || []).filter((taskId) => taskId !== result.taskId);
      run.currentTaskId = run.activeTaskIds[run.activeTaskIds.length - 1] || null;
      run.results.push(result);
      await appendTaskLogs(run, result);
      run.completed += 1;
      if (result.passed) run.passed += 1;
      else run.failed += 1;
      appendEvent(run, "task-finished", { result: compactResult(result), summary: runSummary(run, { includeResults: false }) });
    }

    async function runTask({ problem, index, ordinal, passNumber, passOrdinal, passTotal, attemptId }) {
      if (run.cancelled) throw new Error("Run cancelled.");
      run.activeTaskIds = [...new Set([...(run.activeTaskIds || []), problem.task_id])];
      run.currentTaskId = problem.task_id;
      const context = {
        attemptId,
        passNumber,
        passTotal,
        passOrdinal
      };
      appendEvent(run, "task-started", {
        taskId: problem.task_id,
        index,
        ...context,
        ordinal,
        total: run.total,
        passTaskTotal: problems.length,
        entryPoint: problem.entry_point,
        prompt: problem.prompt,
        test: problem.test,
        summary: runSummary(run, { includeResults: false })
      });
      try {
        let generation;
        try {
          generation = await callModel(run, problem, index, context);
        } catch (error) {
          if (run.cancelled) throw error;
          const result = {
            taskId: problem.task_id,
            attemptId,
            passNumber,
            passTotal,
            index,
            entryPoint: problem.entry_point,
            passed: false,
            modelError: error instanceof Error ? error.message : String(error),
            tests: [],
            instructionPrompt: buildPromptMessages(problem, run.systemPrompt, run.promptTemplate).map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
            prompt: problem.prompt,
            test: problem.test,
            rawOutput: "",
            extractedCode: ""
          };
          await finishTask(result);
          return;
        }
        const extractedCode = extractCode(generation.output, problem.prompt);
        appendEvent(run, "code-extracted", { taskId: problem.task_id, index, ...context, code: extractedCode });
        const testResult = await executeTests(problem, extractedCode, run.timeoutSeconds);
        const result = {
          taskId: problem.task_id,
          attemptId,
          passNumber,
          passTotal,
          index,
          entryPoint: problem.entry_point,
          passed: Boolean(testResult.passed),
          tests: testResult.tests || [],
          stdout: testResult.stdout || "",
          stderr: testResult.stderr || "",
          harnessStdout: testResult.harnessStdout || "",
          harnessStderr: testResult.harnessStderr || "",
          error: testResult.error || null,
          traceback: testResult.traceback || null,
          timeout: Boolean(testResult.timeout),
          instructionPrompt: buildPromptMessages(problem, run.systemPrompt, run.promptTemplate).map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
          prompt: problem.prompt,
          test: problem.test,
          rawOutput: generation.output,
          thinkingOutput: generation.thinking,
          rawTranscript: generation.transcript,
          rawSse: generation.raw,
          extractedCode,
          usage: generation.usage,
          finishReason: generation.finishReason,
          generationMs: generation.elapsedMs
        };
        await finishTask(result);
      } finally {
        run.activeTaskIds = (run.activeTaskIds || []).filter((taskId) => taskId !== problem.task_id);
        run.currentTaskId = run.activeTaskIds[run.activeTaskIds.length - 1] || null;
      }
    }

    async function runWorker(tasks, getNextTaskIndex) {
      while (true) {
        if (run.cancelled) throw new Error("Run cancelled.");
        const taskIndex = getNextTaskIndex();
        if (taskIndex >= tasks.length) return;
        await runTask(tasks[taskIndex]);
      }
    }

    for (let passNumber = 1; passNumber <= passCount; passNumber += 1) {
      if (run.cancelled) throw new Error("Run cancelled.");
      const tasks = problems.map((problem, i) => {
        const passOrdinal = i + 1;
        return {
          problem,
          index: selectedIndices[i],
          ordinal: (passNumber - 1) * problems.length + passOrdinal,
          passOrdinal,
          passNumber,
          passTotal: passCount,
          attemptId: `${problem.task_id}::pass-${passNumber}`
        };
      });
      const remainingTasks = tasks.filter((task) => !completedAttemptIds.has(task.attemptId));
      if (!remainingTasks.length) continue;
      const workerCount = Math.min(run.parallelTasks || 1, remainingTasks.length || 1);
      let nextTask = 0;
      const getNextTaskIndex = () => {
        const taskIndex = nextTask;
        nextTask += 1;
        return taskIndex;
      };
      await Promise.all(Array.from({ length: workerCount }, () => runWorker(remainingTasks, getNextTaskIndex)));
    }
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    run.activeTaskIds = [];
    run.currentTaskId = null;
    appendEvent(run, "done", { summary: runSummary(run, { includeResults: false }) });
    logTerminalRunPerformance(run, run.status);
    persistRunArtifacts(run);
  } catch (error) {
    run.status = run.cancelled ? "cancelled" : "error";
    run.finishedAt = new Date().toISOString();
    run.activeTaskIds = [];
    run.currentTaskId = null;
    appendEvent(run, "error", { message: error instanceof Error ? error.message : String(error), summary: runSummary(run, { includeResults: false }) });
    logTerminalRunPerformance(run, run.status);
    persistRunArtifacts(run);
  }
}

async function createRun(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const allProblems = await ensureHumanEvalData();
  const selectedIndices = parseTestNumbers(config.testNumbers, allProblems.length);
  const parallelTasks = normalizeParallelTasks(config.parallelTasks);
  const passCount = normalizePassCount(config.passCount);
  const plannedTaskCount = selectedIndices.length || (() => {
    const start = Math.max(0, Number(config.startIndex ?? 0));
    const sampleLimit = Number(config.sampleLimit ?? 0);
    const end = sampleLimit > 0 ? Math.min(allProblems.length, start + sampleLimit) : allProblems.length;
    return Math.max(0, end - start);
  })();
  const id = `he-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const run = {
    id,
    dir: null,
    status: "queued",
    createdAt,
    startedAt: null,
    finishedAt: null,
    model: String(config.model || "").trim(),
    baseUrl,
    apiKey: String(config.apiKey || "").trim(),
    temperature: Number(config.temperature ?? 0),
    maxTokens: Number(config.maxTokens ?? 2048),
    timeoutSeconds: Number(config.timeoutSeconds ?? 15),
    parallelTasks,
    passCount,
    sampleLimit: Number(config.sampleLimit ?? 0),
    startIndex: Number(config.startIndex ?? 0),
    selectedIndices,
    systemPrompt: String(config.systemPrompt ?? defaultSystemPrompt),
    promptTemplate: String(config.promptTemplate ?? defaultPromptTemplate),
    extraBody: config.extraBody && typeof config.extraBody === "object" ? config.extraBody : {},
    publicConfig: {
      baseUrl,
      model: String(config.model || "").trim(),
      temperature: Number(config.temperature ?? 0),
      maxTokens: Number(config.maxTokens ?? 2048),
      timeoutSeconds: Number(config.timeoutSeconds ?? 15),
      parallelTasks,
      passCount,
      apiKey: redactApiKey(config.apiKey),
      sampleLimit: Number(config.sampleLimit ?? 0),
      startIndex: Number(config.startIndex ?? 0),
      testNumbers: String(config.testNumbers || ""),
      systemPrompt: String(config.systemPrompt ?? defaultSystemPrompt),
      promptTemplate: String(config.promptTemplate ?? defaultPromptTemplate),
      extraBody: config.extraBody && typeof config.extraBody === "object" ? config.extraBody : {}
    },
    total: plannedTaskCount * passCount,
    completed: 0,
    passed: 0,
    failed: 0,
    currentTaskId: null,
    activeTaskIds: [],
    results: [],
    events: [],
    eventSeq: 0,
    clients: new Set(),
    cancelled: false,
    abortController: null,
    abortControllers: new Set()
  };
  if (!run.model) throw new Error("Model name is required.");
  runs.set(id, run);
  queueMicrotask(() => runHumanEval(run));
  return run;
}

function runCanResume(run) {
  if (run.deleted) return false;
  if (run.status === "running" || run.status === "queued") return false;
  if (run.status === "completed") return false;
  return run.completed < run.total;
}

function resumeRun(run) {
  syncRunCountsFromResults(run);
  if (!runCanResume(run)) {
    throw new Error("Run cannot be resumed.");
  }
  run.cancelled = false;
  run.status = "queued";
  run.finishedAt = null;
  run.activeTaskIds = [];
  run.currentTaskId = null;
  run.abortController = null;
  run.abortControllers = new Set();
  discardResumeArtifacts(run);
  queueMicrotask(() => runHumanEval(run));
  return run;
}

async function loadPersistedRuns() {
  await fs.mkdir(runsDir, { recursive: true });
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);
    try {
      const raw = await fs.readFile(join(dir, "run.json"), "utf8");
      const persisted = JSON.parse(raw);
      const resultsRaw = await fs.readFile(join(dir, "results.json"), "utf8").catch(() => "[]");
      const results = JSON.parse(resultsRaw);
      const persistedRuntimeConfig = runtimeConfigFromPersistedRun(persisted);
      const run = {
        ...persisted,
        ...persistedRuntimeConfig,
        dir,
        activeTaskIds: [],
        events: [],
        eventSeq: 0,
        results: Array.isArray(results) ? results : [],
        clients: new Set(),
        cancelled: persisted.status === "cancelled",
        abortController: null,
        abortControllers: new Set()
      };
      syncRunCountsFromResults(run);
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        run.finishedAt = run.finishedAt || new Date().toISOString();
      }
      runs.set(run.id, run);
    } catch (error) {
      console.error(`Failed to load persisted run from ${dir}:`, error);
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 200, {});
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/humaneval/problems") {
      const problems = await ensureHumanEvalData();
      return sendJson(res, 200, { total: problems.length, problems: problems.map((p) => ({ taskId: p.task_id, entryPoint: p.entry_point })) });
    }
    if (req.method === "GET" && url.pathname === "/api/humaneval/runs") {
      const summaries = [...runs.values()]
        .map((run) => runSummary(run, { includeResults: false }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return sendJson(res, 200, { runs: summaries }, { endpoint: "list-runs", runCount: summaries.length });
    }
    if (req.method === "POST" && url.pathname === "/api/humaneval/runs") {
      const body = await readJsonBody(req);
      const run = await createRun(body);
      return sendJson(res, 201, runSummary(run), { endpoint: "create-run", runId: run.id, resultCount: run.results.length });
    }
    const runMatch = url.pathname.match(/^\/api\/humaneval\/runs\/([^/]+)(?:\/(events|cancel|resume))?$/);
    if (runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) return sendJson(res, 404, { error: "Run not found" });
      if (req.method === "DELETE" && !runMatch[2]) {
        run.deleted = true;
        run.cancelled = true;
        for (const controller of run.abortControllers || []) controller.abort();
        run.abortController?.abort();
        for (const client of run.clients) client.end();
        run.clients.clear();
        runs.delete(run.id);
        taskLogWriteQueues.delete(run.id);
        if (run.dir) await fs.rm(run.dir, { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && !runMatch[2]) {
        return sendJson(res, 200, { ...runSummary(run), events: run.events }, {
          endpoint: "get-run",
          runId: run.id,
          resultCount: run.results.length,
          eventCount: run.events.length
        });
      }
      if (req.method === "POST" && runMatch[2] === "cancel") {
        run.cancelled = true;
        if (run.status === "queued") {
          run.status = "cancelled";
          run.finishedAt = new Date().toISOString();
          appendEvent(run, "error", { message: "Run cancelled.", summary: runSummary(run, { includeResults: false }) });
        }
        for (const controller of run.abortControllers || []) controller.abort();
        run.abortController?.abort();
        return sendJson(res, 200, runSummary(run, { includeResults: false }));
      }
      if (req.method === "POST" && runMatch[2] === "resume") {
        const resumedRun = resumeRun(run);
        return sendJson(res, 200, runSummary(resumedRun, { includeResults: false }));
      }
      if (req.method === "GET" && runMatch[2] === "events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*"
        });
        for (const event of run.events) {
          res.write(`id: ${event.id}\n`);
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        run.clients.add(res);
        req.on("close", () => run.clients.delete(res));
        return;
      }
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      console.error("Request failed after response headers were sent:", error);
      res.end();
    }
  }
});

await loadPersistedRuns();

server.listen(port, "0.0.0.0", () => {
  console.log(`HumanEval benchmark server listening on http://localhost:${port}`);
  console.log(`Benchmark artifacts are written to ${runsDir}`);
});

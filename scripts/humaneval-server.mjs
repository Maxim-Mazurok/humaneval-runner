#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const cacheDir = join(rootDir, ".cache");
const runsDir = join(rootDir, "benchmark-runs");
const humanEvalPath = join(cacheDir, "HumanEval.jsonl");
const humanEvalUrl = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz";
const port = Number(process.env.HUMANEVAL_PORT || 8787);
const runs = new Map();
const taskLogWriteQueues = new Map();
const maxReplayEvents = 5000;
const defaultSystemPrompt = [
  "You are completing a Python programming task.",
  "Return only Python code.",
  "Implement the requested function exactly as described.",
  "Use only the Python standard library."
].join("\n");
const defaultPromptTemplate = [
  "Goal:",
  "- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.",
  "- Return Python code that can be executed by a test harness.",
  "",
  "Response format:",
  "- Output only Python code.",
  "- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).",
  "- Preserve the function name(s), arguments, and return behavior implied by the prompt.",
  "",
  "Task prompt:",
  "```python",
  "%problem_code%",
  "```"
].join("\n");

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

function compactResult(result) {
  if (!result) return result;
  const {
    rawOutput,
    thinkingOutput,
    rawTranscript,
    rawSse,
    extractedCode,
    harnessStdout,
    harnessStderr,
    stdout,
    stderr,
    prompt,
    test,
    instructionPrompt,
    ...rest
  } = result;
  return {
    ...rest,
    tests: result.tests || [],
    error: result.error || null,
    traceback: result.traceback || null,
    generationMs: result.generationMs
  };
}

function runSummary(run, { includeResults = true } = {}) {
  const assertionsTotal = run.results.reduce((sum, result) => sum + (result.tests?.length || 0), 0);
  const assertionsPassed = run.results.reduce(
    (sum, result) => sum + (result.tests || []).filter((test) => test.passed).length,
    0
  );
  return {
    id: run.id,
    status: run.status,
    model: run.model,
    baseUrl: run.baseUrl,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    total: run.total,
    completed: run.completed,
    passed: run.passed,
    failed: run.failed,
    liveScore: run.completed ? run.passed / run.completed : 0,
    finalScore: run.total ? run.passed / run.total : null,
    assertionsPassed,
    assertionsTotal,
    assertionScore: assertionsTotal ? assertionsPassed / assertionsTotal : 0,
    currentTaskId: run.currentTaskId,
    activeTaskIds: run.activeTaskIds || [],
    config: {
      baseUrl: run.baseUrl,
      model: run.model,
      parallelTasks: run.parallelTasks || 1,
      ...(run.publicConfig || {})
    },
    logDir: run.dir,
    selectedIndices: run.selectedIndices,
    results: includeResults ? run.results : []
  };
}

function persistedRunState(run) {
  return runSummary(run, { includeResults: false });
}

function formatRunDirTimestamp(value) {
  return new Date(value).toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function slugifyRunPart(value, fallback = "model") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function runDirName(run) {
  return [
    formatRunDirTimestamp(run.startedAt || run.createdAt),
    slugifyRunPart(run.model),
    run.id
  ].join("-");
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
  run.events.push(event);
  if (run.events.length > maxReplayEvents) run.events.splice(0, run.events.length - maxReplayEvents);
  if (type !== "token" && type !== "raw" && type !== "raw-delta") persistRunArtifacts(run);
  for (const res of run.clients) {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is required.");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function extractTextFromDelta(delta) {
  const parts = [];
  if (typeof delta.reasoning_content === "string") parts.push({ channel: "thinking", text: delta.reasoning_content });
  if (typeof delta.reasoning === "string") parts.push({ channel: "thinking", text: delta.reasoning });
  if (typeof delta.thinking === "string") parts.push({ channel: "thinking", text: delta.thinking });
  if (typeof delta.content === "string") parts.push({ channel: "output", text: delta.content });
  if (typeof delta.refusal === "string") parts.push({ channel: "refusal", text: delta.refusal });
  return parts;
}

function renderPromptTemplate(template, problem) {
  return String(template || defaultPromptTemplate).replaceAll("%problem_code%", problem.prompt);
}

function buildPromptMessages(problem, systemPrompt = defaultSystemPrompt, promptTemplate = defaultPromptTemplate) {
  const messages = [];
  if (String(systemPrompt || "").trim()) {
    messages.push({ role: "system", content: String(systemPrompt).trim() });
  }
  messages.push({ role: "user", content: renderPromptTemplate(promptTemplate, problem) });
  return messages;
}

async function callModel(run, problem, index) {
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

  appendEvent(run, "prompt", { taskId: problem.task_id, index, messages, request: { ...body, messages } });
  const started = Date.now();
  try {
    const response = await fetch(`${run.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(run.apiKey ? { authorization: `Bearer ${run.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
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
            appendEvent(run, "raw", { taskId: problem.task_id, text: payload });
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
            appendEvent(run, "token", { taskId: problem.task_id, index, ...part });
          }
          if (!parts.length && Object.keys(delta).length) {
            appendEvent(run, "raw-delta", { taskId: problem.task_id, index, delta });
          }
        }
      }
    }
    return { output, thinking, transcript, raw, usage, finishReason, elapsedMs: Date.now() - started };
  } finally {
    run.abortControllers?.delete(controller);
    if (run.abortController === controller) run.abortController = null;
  }
}

function extractCode(response, prompt) {
  const text = String(response || "").trim();
  const pythonBlocks = [...text.matchAll(/```python\s*\n([\s\S]*?)```/gi)];
  if (pythonBlocks.length) {
    const code = pythonBlocks[pythonBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  const genericBlocks = [...text.matchAll(/```\s*\n([\s\S]*?)```/g)];
  if (genericBlocks.length) {
    const code = genericBlocks[genericBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  if (text.startsWith("def ") || text.startsWith("import ") || text.startsWith("from ")) return text;
  return prompt + text;
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
  const dir = await fs.mkdtemp(join(tmpdir(), "humaneval-"));
  const scriptPath = join(dir, "run.py");
  await fs.writeFile(scriptPath, pythonHarness(code, problem.test, problem.entry_point), "utf8");
  return await new Promise((resolve) => {
    const child = spawn("python3", [scriptPath], {
      cwd: dir,
      env: { PATH: process.env.PATH || "/usr/bin:/usr/local/bin", LANG: "en_US.UTF-8", HOME: dir }
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ passed: false, tests: [], stdout, stderr, error: "Execution timed out", timeout: true });
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async () => {
      clearTimeout(timeout);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
      try {
        const parsed = lastLine ? JSON.parse(lastLine) : {};
        resolve({ ...parsed, harnessStdout: stdout, harnessStderr: stderr });
      } catch {
        resolve({ passed: false, tests: [], stdout, stderr, error: "Harness returned non-JSON output", harnessStdout: stdout, harnessStderr: stderr });
      }
    });
  });
}

async function runHumanEval(run) {
  if (run.deleted) return;
  run.status = "running";
  run.startedAt = run.startedAt || new Date().toISOString();
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
    run.total = problems.length;
    run.activeTaskIds = [];
    appendEvent(run, "run-started", { summary: runSummary(run, { includeResults: false }), datasetSize: allProblems.length });
    const tasks = problems.map((problem, i) => ({
      problem,
      index: selectedIndices[i],
      ordinal: i + 1
    }));
    let nextTask = 0;
    const workerCount = Math.min(run.parallelTasks || 1, tasks.length || 1);

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

    async function runTask({ problem, index, ordinal }) {
      if (run.cancelled) throw new Error("Run cancelled.");
      run.activeTaskIds = [...new Set([...(run.activeTaskIds || []), problem.task_id])];
      run.currentTaskId = problem.task_id;
      appendEvent(run, "task-started", {
        taskId: problem.task_id,
        index,
        ordinal,
        total: problems.length,
        entryPoint: problem.entry_point,
        prompt: problem.prompt,
        test: problem.test,
        summary: runSummary(run, { includeResults: false })
      });
      try {
        let generation;
        try {
          generation = await callModel(run, problem, index);
        } catch (error) {
          const result = {
            taskId: problem.task_id,
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
        appendEvent(run, "code-extracted", { taskId: problem.task_id, index, code: extractedCode });
        const testResult = await executeTests(problem, extractedCode, run.timeoutSeconds);
        const result = {
          taskId: problem.task_id,
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

    async function runWorker() {
      while (true) {
        if (run.cancelled) throw new Error("Run cancelled.");
        const taskIndex = nextTask;
        nextTask += 1;
        if (taskIndex >= tasks.length) return;
        await runTask(tasks[taskIndex]);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    run.activeTaskIds = [];
    run.currentTaskId = null;
    appendEvent(run, "done", { summary: runSummary(run, { includeResults: false }) });
    persistRunArtifacts(run);
  } catch (error) {
    run.status = run.cancelled ? "cancelled" : "error";
    run.finishedAt = new Date().toISOString();
    run.activeTaskIds = [];
    run.currentTaskId = null;
    appendEvent(run, "error", { message: error instanceof Error ? error.message : String(error), summary: runSummary(run, { includeResults: false }) });
    persistRunArtifacts(run);
  }
}

function parseTestNumbers(value, datasetSize) {
  if (Array.isArray(value)) {
    const selected = [...new Set(value.map(Number).filter((number) => Number.isInteger(number)))].sort((a, b) => a - b);
    const invalid = selected.filter((index) => index < 0 || index >= datasetSize);
    if (invalid.length) {
      throw new Error(`Invalid test number(s): ${invalid.join(", ")}. Use 0-${datasetSize - 1}.`);
    }
    return selected;
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  const selected = new Set();
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const first = Number(range[1]);
      const last = Number(range[2]);
      const step = first <= last ? 1 : -1;
      for (let index = first; step > 0 ? index <= last : index >= last; index += step) selected.add(index);
      continue;
    }
    const task = part.match(/HumanEval\/(\d+)$/i);
    selected.add(Number(task ? task[1] : part));
  }
  const invalid = [...selected].filter((index) => !Number.isInteger(index) || index < 0 || index >= datasetSize);
  if (invalid.length) {
    throw new Error(`Invalid test number(s): ${invalid.join(", ")}. Use 0-${datasetSize - 1}.`);
  }
  return [...selected].sort((a, b) => a - b);
}

function normalizeParallelTasks(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(64, Math.max(1, Math.floor(parsed)));
}

async function createRun(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const allProblems = await ensureHumanEvalData();
  const selectedIndices = parseTestNumbers(config.testNumbers, allProblems.length);
  const parallelTasks = normalizeParallelTasks(config.parallelTasks);
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
      sampleLimit: Number(config.sampleLimit ?? 0),
      startIndex: Number(config.startIndex ?? 0),
      testNumbers: String(config.testNumbers || ""),
      systemPrompt: String(config.systemPrompt ?? defaultSystemPrompt),
      promptTemplate: String(config.promptTemplate ?? defaultPromptTemplate),
      extraBody: config.extraBody && typeof config.extraBody === "object" ? config.extraBody : {}
    },
    total: 0,
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
      const run = {
        ...persisted,
        dir,
        publicConfig: persisted.config || persisted.publicConfig || {},
        parallelTasks: normalizeParallelTasks(persisted.config?.parallelTasks ?? persisted.publicConfig?.parallelTasks ?? persisted.parallelTasks),
        activeTaskIds: [],
        events: [],
        eventSeq: 0,
        results: Array.isArray(results) ? results : [],
        clients: new Set(),
        cancelled: persisted.status === "cancelled",
        abortController: null,
        abortControllers: new Set()
      };
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
      return sendJson(res, 200, { runs: summaries });
    }
    if (req.method === "POST" && url.pathname === "/api/humaneval/runs") {
      const body = await readJsonBody(req);
      const run = await createRun(body);
      return sendJson(res, 201, runSummary(run));
    }
    const runMatch = url.pathname.match(/^\/api\/humaneval\/runs\/([^/]+)(?:\/(events|cancel))?$/);
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
      if (req.method === "GET" && !runMatch[2]) return sendJson(res, 200, { ...runSummary(run), events: run.events });
      if (req.method === "POST" && runMatch[2] === "cancel") {
        run.cancelled = true;
        for (const controller of run.abortControllers || []) controller.abort();
        run.abortController?.abort();
        return sendJson(res, 200, runSummary(run, { includeResults: false }));
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

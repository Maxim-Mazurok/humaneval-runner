export const defaultSystemPrompt = [
  "You are completing a Python programming task.",
  "Implement the requested function exactly as described.",
  "Prioritize functional correctness above all else.",
  "Use straightforward, readable Python.",
  "Use only the Python standard library.",
  "Return only the requested code. Do not include explanations."
].join("\n");

export const defaultPromptTemplate = [
  "Goal:",
  "- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.",
  "- Return Python code that can be executed by a test harness.",
  "",
  "Response format:",
  "- Output one markdown multiline code block with python syntax.",
  "- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).",
  "- Preserve the function name(s), arguments, and return behavior implied by the prompt.",
  "",
  "Task prompt:",
  "```python",
  "%problem_code%",
  "```"
].join("\n");

export function compactResult(result) {
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

export function runSummary(run, { includeResults = true } = {}) {
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
      passCount: run.passCount || 1,
      ...(run.publicConfig || {})
    },
    logDir: run.dir,
    selectedIndices: run.selectedIndices,
    results: includeResults ? run.results : []
  };
}

export function persistedRunState(run) {
  return runSummary(run, { includeResults: false });
}

export function formatRunDirTimestamp(value) {
  return new Date(value).toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function slugifyRunPart(value, fallback = "model") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function runDirName(run) {
  return [
    formatRunDirTimestamp(run.startedAt || run.createdAt),
    slugifyRunPart(run.model),
    run.id
  ].join("-");
}

export function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is required.");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function extractTextFromDelta(delta) {
  const parts = [];
  if (typeof delta.reasoning_content === "string") parts.push({ channel: "thinking", text: delta.reasoning_content });
  if (typeof delta.reasoning === "string") parts.push({ channel: "thinking", text: delta.reasoning });
  if (typeof delta.thinking === "string") parts.push({ channel: "thinking", text: delta.thinking });
  if (typeof delta.content === "string") parts.push({ channel: "output", text: delta.content });
  if (typeof delta.refusal === "string") parts.push({ channel: "refusal", text: delta.refusal });
  return parts;
}

export function renderPromptTemplate(template, problem) {
  return String(template || defaultPromptTemplate).replaceAll("%problem_code%", problem.prompt);
}

export function buildPromptMessages(problem, systemPrompt = defaultSystemPrompt, promptTemplate = defaultPromptTemplate) {
  const messages = [];
  if (String(systemPrompt || "").trim()) {
    messages.push({ role: "system", content: String(systemPrompt).trim() });
  }
  messages.push({ role: "user", content: renderPromptTemplate(promptTemplate, problem) });
  return messages;
}

export function extractCode(response, prompt) {
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

export function parseTestNumbers(value, datasetSize) {
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

export function normalizeParallelTasks(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(64, Math.max(1, Math.floor(parsed)));
}

export function normalizePassCount(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

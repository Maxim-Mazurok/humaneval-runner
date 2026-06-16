import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ClipboardCopy,
  FileText,
  KeyRound,
  Bell,
  BellOff,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Server,
  Settings2,
  TerminalSquare,
  Trash2
} from "lucide-react";
import {
  browserNotificationsAvailable,
  dispatchRunNotification,
  isTerminalNotificationStatus,
  notificationsEnabledForRun,
  notificationEventIsTerminal,
  readDisabledRunNotificationIds,
  requestNotificationsEnabled,
  writeRunNotificationPreference
} from "./notifications";

const BENCH_API = "http://localhost:8787";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "humaneval.sidebar.collapsed";
const DEFAULT_SYSTEM_PROMPT = `You are completing a Python programming task.

Implement the requested function exactly as described by the prompt. Prioritize functional correctness above all else. Performance is secondary unless the prompt gives explicit limits.

Use straightforward, readable Python and avoid clever syntax or unnecessary abstractions. Use only the Python standard library. Preserve the required function names, signatures, and return types.

Return only the requested code. Do not include explanations.
`;
const DEFAULT_PROMPT_TEMPLATE = `Goal:
- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.
- Return Python code that can be executed by a test harness.

Response format:
- Output one markdown multiline code block with python syntax.
- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).
- Preserve the function name(s), arguments, and return behavior implied by the prompt.

Task prompt:
\`\`\`python
%problem_code%
\`\`\`
`;

const DEFAULT_FORM_VALUES = {
  baseUrl: "http://localhost:8000/v1",
  apiKey: "",
  model: "",
  maxTokens: 2048,
  timeoutSeconds: 15,
  parallelTasks: 1,
  passCount: 1,
  commentSignalThreshold: 50,
  sampleLimit: 0,
  startIndex: 0,
  testNumbers: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraBody: "{\n  \"top_p\": 1\n}"
};

type BenchResult = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index: number;
  entryPoint: string;
  passed: boolean;
  tests: Array<{
    source: string;
    passed: boolean;
    error?: string;
    traceback?: string;
    actual?: string;
    expected?: string;
    operator?: string;
  }>;
  instructionPrompt?: string;
  prompt: string;
  test: string;
  rawOutput: string;
  thinkingOutput?: string;
  rawTranscript?: string;
  rawSse?: string;
  extractedCode: string;
  error?: string | null;
  traceback?: string | null;
  modelError?: string;
  generationMs?: number;
  harnessStdout?: string;
  harnessStderr?: string;
  usage?: Record<string, unknown> | null;
};

type BenchRun = {
  id: string;
  status: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  liveScore: number;
  finalScore?: number | null;
  assertionsPassed: number;
  assertionsTotal: number;
  assertionScore: number;
  currentTaskId: string | null;
  logDir?: string;
  selectedIndices?: number[];
  config?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    systemPrompt?: string;
    promptTemplate?: string;
    testNumbers?: string;
    maxTokens?: number;
    timeoutSeconds?: number;
    parallelTasks?: number;
    passCount?: number;
    sampleLimit?: number;
    startIndex?: number;
    extraBody?: Record<string, unknown>;
  };
  activeTaskIds?: string[];
  results: BenchResult[];
};

type TokenEvent = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index?: number;
  channel: string;
  text: string;
};

type EventEnvelope = {
  id?: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

type StartedTask = {
  taskId: string;
  attemptId?: string;
  passNumber: number;
  passTotal: number;
  passOrdinal?: number;
  index: number;
  entryPoint: string;
  prompt?: string;
  test?: string;
};

type TaskRow = StartedTask & {
  key: string;
  status: "running" | "pass" | "fail";
  result?: BenchResult;
};

type TaskGroup = {
  taskId: string;
  index: number;
  entryPoint: string;
  attempts: TaskRow[];
};

type PassTabGroup = {
  key: string;
  startPass: number;
  endPass: number;
  status: TaskRow["status"];
  attempts: TaskRow[];
  representative: TaskRow;
};

type ChartPassGroup = {
  key: string;
  startPass: number;
  endPass: number;
  row: PassVariabilityStats["passRows"][number];
};

type TaskPromptInfo = {
  prompt?: string;
  instructionPrompt?: string;
  test?: string;
};

type CommentLineStats = {
  commentLines: number;
  codeLines: number;
  blankLines: number;
  leadingCommentLines: number;
};

type ThinkingCommentSignal = {
  commentLines: number;
  codeLines: number;
  originalCommentLines: number;
  generatedCommentLines: number;
  generatedCodeLines: number;
  addedCommentLines: number;
  leadingCommentLines: number;
  commentRatio: number;
};

type PassVariabilityStats = {
  passRows: Array<{
    passNumber: number;
    completed: number;
    passed: number;
    failed: number;
    score: number;
  }>;
  passTotal: number;
  minScore: number;
  maxScore: number;
  taskCounts: {
    total: number;
    allPass: number;
    mixed: number;
    allFail: number;
  };
};

type BenchRoute = {
  view: "new";
} | {
  view: "run";
  id: string;
};

function parseBenchRoute(pathname: string): BenchRoute {
  const runMatch = pathname.match(/^\/run\/([^/]+)\/?$/);
  if (runMatch) return { view: "run", id: decodeURIComponent(runMatch[1]) };
  return { view: "new" };
}

function readBenchRoute(): BenchRoute {
  if (typeof window === "undefined") return { view: "new" };
  return parseBenchRoute(window.location.pathname);
}

function routePath(route: BenchRoute) {
  return route.view === "run" ? `/run/${encodeURIComponent(route.id)}` : "/new";
}

function pct(value?: number | null) {
  return `${Math.round((value || 0) * 1000) / 10}%`;
}

function runTotal(run?: BenchRun | null) {
  return run?.total || ((run?.selectedIndices?.length || 164) * runPassCount(run));
}

function runPassCount(run?: BenchRun | null) {
  return normalizePassCount(Number(run?.config?.passCount ?? 1));
}

function ordinal(value: number) {
  const normalized = Math.max(1, Math.floor(value));
  const mod100 = normalized % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${normalized}th`;
  switch (normalized % 10) {
    case 1:
      return `${normalized}st`;
    case 2:
      return `${normalized}nd`;
    case 3:
      return `${normalized}rd`;
    default:
      return `${normalized}th`;
  }
}

function completedMetricLines(run?: BenchRun | null): Array<[string, string]> {
  const total = runTotal(run);
  const completed = Math.min(Math.max(run?.completed ?? 0, 0), total);
  const passCount = runPassCount(run);
  const passTotal = Math.max(1, Math.ceil(total / passCount));
  const currentPass = completed >= total
    ? passCount
    : Math.min(passCount, Math.floor(completed / passTotal) + 1);
  const currentPassCompleted = completed >= total ? passTotal : completed % passTotal;

  return [
    ["Total:", `${pct(total ? completed / total : 0)} (${completed}/${total})`],
    [`${ordinal(currentPass)} pass:`, `${pct(currentPassCompleted / passTotal)} (${currentPassCompleted}/${passTotal})`]
  ];
}

function thresholdRatio(thresholdPercent: number) {
  return normalizeCommentSignalThreshold(thresholdPercent) / 100;
}

function countPythonCommentLines(source: string): CommentLineStats {
  const lines = String(source || "").split(/\r?\n/);
  let commentLines = 0;
  let codeLines = 0;
  let blankLines = 0;
  let leadingCommentLines = 0;
  let seenCode = false;
  let tripleQuote: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines += 1;
      continue;
    }

    if (tripleQuote) {
      commentLines += 1;
      if (line.includes(tripleQuote)) tripleQuote = null;
      continue;
    }

    const docstringDelimiter = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
    if (docstringDelimiter) {
      commentLines += 1;
      if (!seenCode) leadingCommentLines += 1;
      if (trimmed.indexOf(docstringDelimiter, 3) === -1) tripleQuote = docstringDelimiter;
      continue;
    }

    let hasComment = false;
    let hasCodeBeforeComment = false;
    let cursor = 0;
    let lineContinuesString = Boolean(tripleQuote);
    let quote: string | null = null;
    let escaped = false;
    while (cursor < line.length) {
      if (tripleQuote) {
        const end = line.indexOf(tripleQuote, cursor);
        if (end === -1) break;
        cursor = end + 3;
        tripleQuote = null;
        lineContinuesString = false;
        continue;
      }

      const char = line[cursor];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        cursor += 1;
        continue;
      }

      const triple = line.slice(cursor, cursor + 3);
      if (triple === "'''" || triple === '"""') {
        const end = line.indexOf(triple, cursor + 3);
        if (end === -1) {
          tripleQuote = triple;
          lineContinuesString = true;
          break;
        }
        cursor = end + 3;
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        cursor += 1;
        continue;
      }

      if (char === "#") {
        hasComment = true;
        hasCodeBeforeComment = line.slice(0, cursor).trim().length > 0;
        break;
      }

      cursor += 1;
    }

    if (tripleQuote || lineContinuesString) {
      codeLines += 1;
      seenCode = true;
      continue;
    }

    if (hasComment) {
      commentLines += 1;
      if (hasCodeBeforeComment) {
        codeLines += 1;
        seenCode = true;
      } else if (!seenCode) {
        leadingCommentLines += 1;
      }
      continue;
    }

    codeLines += 1;
    seenCode = true;
  }

  return { commentLines, codeLines, blankLines, leadingCommentLines };
}

function normalizedPromptLine(line: string) {
  return line
    .trim()
    .replace(/'''/g, '"""')
    .replace(/\s+/g, " ");
}

function sourceFunctionName(source: string) {
  return source.match(/\bdef\s+([A-Za-z_]\w*)\s*\(/)?.[1] ?? null;
}

function promptHasFunctionDocstring(originalPrompt: string, functionName: string) {
  const lines = originalPrompt.split(/\r?\n/);
  const defIndex = lines.findIndex((line) => line.match(new RegExp(`\\bdef\\s+${functionName}\\s*\\(`)));
  if (defIndex === -1) return false;
  let cursor = defIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const firstBodyLine = lines[cursor]?.trim() || "";
  return firstBodyLine.startsWith('"""') || firstBodyLine.startsWith("'''");
}

function generatedTailAfterPromptDocstring(extractedCode: string, originalPrompt: string, entryPoint?: string) {
  const functionName = entryPoint || sourceFunctionName(originalPrompt);
  if (!functionName || !promptHasFunctionDocstring(originalPrompt, functionName)) {
    return null;
  }

  const lines = extractedCode.split(/\r?\n/);
  const defIndex = lines.findIndex((line) => line.match(new RegExp(`\\bdef\\s+${functionName}\\s*\\(`)));
  if (defIndex === -1) return null;

  let cursor = defIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const firstBodyLine = lines[cursor]?.trim() || "";
  const delimiter = firstBodyLine.startsWith('"""') ? '"""' : firstBodyLine.startsWith("'''") ? "'''" : null;
  if (!delimiter) return null;

  if (firstBodyLine.indexOf(delimiter, 3) !== -1) {
    return lines.slice(cursor + 1).join("\n");
  }

  cursor += 1;
  while (cursor < lines.length) {
    if (lines[cursor].includes(delimiter)) return lines.slice(cursor + 1).join("\n");
    cursor += 1;
  }

  return null;
}

function generatedTail(extractedCode: string, originalPrompt: string, entryPoint?: string) {
  if (!extractedCode || !originalPrompt) return extractedCode;
  const tailAfterDocstring = generatedTailAfterPromptDocstring(extractedCode, originalPrompt, entryPoint);
  if (tailAfterDocstring !== null) return tailAfterDocstring;
  if (extractedCode.startsWith(originalPrompt)) return extractedCode.slice(originalPrompt.length);

  const promptLines = originalPrompt.split(/\r?\n/);
  const extractedLines = extractedCode.split(/\r?\n/);
  const comparablePromptLines = promptLines.filter((line) => normalizedPromptLine(line)).length;
  const maxMismatches = Math.max(2, Math.ceil(comparablePromptLines * 0.15));
  const minMatchRatio = 0.6;
  let promptIndex = 0;
  let extractedIndex = 0;
  let matched = 0;
  let mismatches = 0;
  let candidateEndLine = 0;
  let lastMatchedEndLine = 0;

  while (promptIndex < promptLines.length && extractedIndex < extractedLines.length) {
    const promptLine = normalizedPromptLine(promptLines[promptIndex]);
    const extractedLine = normalizedPromptLine(extractedLines[extractedIndex]);

    if (!promptLine) {
      promptIndex += 1;
      if (!extractedLine) {
        extractedIndex += 1;
        candidateEndLine = extractedIndex;
      }
      continue;
    }

    if (!extractedLine) {
      extractedIndex += 1;
      candidateEndLine = extractedIndex;
      continue;
    }

    if (promptLine === extractedLine) {
      promptIndex += 1;
      extractedIndex += 1;
      matched += 1;
      candidateEndLine = extractedIndex;
      lastMatchedEndLine = extractedIndex;
      continue;
    }

    if (mismatches < maxMismatches) {
      promptIndex += 1;
      extractedIndex += 1;
      mismatches += 1;
      candidateEndLine = extractedIndex;
      continue;
    }

    break;
  }

  const matchRatio = comparablePromptLines ? matched / comparablePromptLines : 0;
  if (promptIndex >= promptLines.length && matchRatio >= minMatchRatio) {
    return extractedLines.slice(candidateEndLine).join("\n");
  }
  if (matchRatio >= minMatchRatio) {
    return extractedLines.slice(lastMatchedEndLine).join("\n");
  }
  return extractedCode;
}

function analyzeThinkingComments(result?: BenchResult): ThinkingCommentSignal | undefined {
  if (!result) return undefined;
  const originalPrompt = result.prompt || "";
  const extractedCode = result.extractedCode || "";
  const originalStats = countPythonCommentLines(originalPrompt);
  const generatedSegment = generatedTail(extractedCode, originalPrompt, result.entryPoint);
  const generatedStats = countPythonCommentLines(generatedSegment);
  const addedCommentLines = generatedStats.commentLines;
  const commentRatio = generatedStats.codeLines
    ? generatedStats.commentLines / generatedStats.codeLines
    : generatedStats.commentLines
      ? 1
      : 0;

  return {
    commentLines: generatedStats.commentLines,
    codeLines: generatedStats.codeLines,
    originalCommentLines: originalStats.commentLines,
    generatedCommentLines: generatedStats.commentLines,
    generatedCodeLines: generatedStats.codeLines,
    addedCommentLines,
    leadingCommentLines: generatedStats.leadingCommentLines,
    commentRatio
  };
}

function commentSignalIsFlagged(signal: ThinkingCommentSignal | undefined, thresholdPercent: number) {
  if (!signal) return false;
  return signal.generatedCommentLines > 0 && signal.commentRatio >= thresholdRatio(thresholdPercent);
}

function commentSignalReasons(signal: ThinkingCommentSignal, thresholdPercent: number) {
  if (!commentSignalIsFlagged(signal, thresholdPercent)) return [];
  return [
    `extra comment density meets threshold (${signal.generatedCommentLines}/${signal.generatedCodeLines || 0}, threshold ${normalizeCommentSignalThreshold(thresholdPercent)}%)`
  ];
}

function thinkingInCommentsStats(results: BenchResult[] = [], thresholdPercent: number) {
  const flagged = results.filter((result) => commentSignalIsFlagged(analyzeThinkingComments(result), thresholdPercent)).length;
  return { flagged, total: results.length };
}

function scoreRange(run?: BenchRun | null) {
  if (!run) return { worst: 0, best: 0 };
  const total = runTotal(run);
  const remaining = Math.max(total - run.completed, 0);
  return {
    worst: total ? run.passed / total : 0,
    best: total ? (run.passed + remaining) / total : 0
  };
}

function progressSegments(run?: BenchRun | null) {
  if (!run) return { failed: 0, passed: 0, remaining: 100 };
  const total = runTotal(run);
  const remaining = Math.max(total - run.completed, 0);
  if (!total) return { failed: 0, passed: 0, remaining: 100 };
  return {
    failed: (run.failed / total) * 100,
    passed: (run.passed / total) * 100,
    remaining: (remaining / total) * 100
  };
}

function formatMs(value?: number) {
  if (!value) return "n/a";
  if (value < 1000) return `${value}ms`;
  if (value >= 60_000) return formatDuration(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatDuration(valueMs: number) {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function formatClock(valueMs: number) {
  const date = new Date(valueMs);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function runStartedAtMs(run?: BenchRun | null) {
  const value = run?.startedAt || run?.createdAt;
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function currentTaskStartedAtMs(run: BenchRun | null, events: EventEnvelope[]) {
  if (!run?.currentTaskId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "task-started") continue;
    if (event.data.taskId !== run.currentTaskId) continue;
    const timestamp = new Date(event.at).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function liveEstimate(run: BenchRun | null, events: EventEnvelope[], nowMs: number, taskStartedAtMs?: number | null) {
  if (!run || !statusIsLive(run.status)) return null;
  const total = runTotal(run);
  const remainingTasks = Math.max(total - run.completed, 0);
  const startedAtMs = runStartedAtMs(run);
  if (!startedAtMs || run.completed <= 0 || remainingTasks <= 0) return null;
  const parallelTasks = Math.max(1, Math.floor(Number(run.config?.parallelTasks ?? 1)));
  const elapsedMs = Math.max(nowMs - startedAtMs, 0);
  if (parallelTasks > 1) {
    const averageMs = elapsedMs / run.completed;
    const remainingMs = Math.max((averageMs * remainingTasks) / parallelTasks, 0);
    return {
      remaining: formatDuration(remainingMs),
      endTime: formatClock(nowMs + remainingMs)
    };
  }
  const currentStartedAtMs = taskStartedAtMs ?? currentTaskStartedAtMs(run, events);
  const currentTaskMs = currentStartedAtMs ? Math.max(nowMs - currentStartedAtMs, 0) : 0;
  const completedTaskMs = Math.max(elapsedMs - currentTaskMs, 0);
  const averageMs = completedTaskMs > 0 ? completedTaskMs / run.completed : elapsedMs / run.completed;
  const remainingMs = Math.max(averageMs * remainingTasks - currentTaskMs, 0);
  return {
    remaining: formatDuration(remainingMs),
    endTime: formatClock(nowMs + remainingMs)
  };
}

function runElapsedMs(run: BenchRun | null, nowMs: number) {
  const startedAtMs = runStartedAtMs(run);
  if (!startedAtMs) return null;
  const finishedAtMs = run?.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const endMs = finishedAtMs && Number.isFinite(finishedAtMs) ? finishedAtMs : nowMs;
  return Math.max(endMs - startedAtMs, 0);
}

function speedStats(run: BenchRun | null, events: EventEnvelope[], nowMs: number, taskStartedAtMs?: number | null) {
  if (!run) return { averageTask: "n/a", bench: "n/a" };
  const elapsedMs = runElapsedMs(run, nowMs);
  const completed = Math.max(run.completed || run.results.length || 0, 0);
  const parallelTasks = Math.max(1, Math.floor(Number(run.config?.parallelTasks ?? 1)));
  const currentStartedAtMs = statusIsLive(run.status) && parallelTasks === 1
    ? (taskStartedAtMs ?? currentTaskStartedAtMs(run, events))
    : null;
  const currentTaskMs = currentStartedAtMs ? Math.max(nowMs - currentStartedAtMs, 0) : 0;
  const completedTaskElapsedMs = elapsedMs === null ? null : Math.max(elapsedMs - currentTaskMs, 0);
  const resultDurations = run.results
    .map((result) => result.generationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const averageTaskMs = resultDurations.length
    ? resultDurations.reduce((sum, value) => sum + value, 0) / resultDurations.length
    : completedTaskElapsedMs && completed
      ? completedTaskElapsedMs / completed
      : null;
  const estimatedBenchMs = averageTaskMs
    ? (averageTaskMs * runTotal(run)) / parallelTasks
    : null;
  return {
    averageTask: averageTaskMs ? formatMs(averageTaskMs) : "n/a",
    bench: elapsedMs === null
      ? "n/a"
      : run.finishedAt
        ? `took ${formatDuration(elapsedMs)}`
        : estimatedBenchMs
          ? `~${formatDuration(estimatedBenchMs)}`
          : "n/a"
  };
}

function assertionStats(results: BenchResult[] = []) {
  const total = results.reduce((sum, result) => sum + result.tests.length, 0);
  const passed = results.reduce((sum, result) => sum + result.tests.filter((test) => test.passed).length, 0);
  return { passed, total, score: total ? passed / total : 0 };
}

function passVariabilityStats(run?: BenchRun | null): PassVariabilityStats {
  const results = run?.results ?? [];
  const configuredPasses = runPassCount(run);
  const passTotal = Math.max(
    configuredPasses,
    ...results.map((result) => Number(result.passTotal ?? result.passNumber ?? 1)).filter(Number.isFinite)
  );
  const passRows = new Map<number, PassVariabilityStats["passRows"][number]>();
  for (let passNumber = 1; passNumber <= passTotal; passNumber += 1) {
    passRows.set(passNumber, { passNumber, completed: 0, passed: 0, failed: 0, score: 0 });
  }
  const taskRows = new Map<string, { completed: number; passed: number }>();

  for (const result of results) {
    const passNumber = attemptPassNumber(result);
    const row = passRows.get(passNumber) ?? { passNumber, completed: 0, passed: 0, failed: 0, score: 0 };
    row.completed += 1;
    if (result.passed) row.passed += 1;
    else row.failed += 1;
    row.score = row.completed ? row.passed / row.completed : 0;
    passRows.set(passNumber, row);

    const task = taskRows.get(result.taskId) ?? { completed: 0, passed: 0 };
    task.completed += 1;
    if (result.passed) task.passed += 1;
    taskRows.set(result.taskId, task);
  }

  const completedRows = [...passRows.values()].filter((row) => row.completed > 0);
  const scores = completedRows.map((row) => row.score);
  let allPass = 0;
  let mixed = 0;
  let allFail = 0;
  for (const task of taskRows.values()) {
    if (task.passed === 0) allFail += 1;
    else if (task.passed === task.completed) allPass += 1;
    else mixed += 1;
  }

  return {
    passRows: [...passRows.values()].sort((left, right) => left.passNumber - right.passNumber),
    passTotal,
    minScore: scores.length ? Math.min(...scores) : 0,
    maxScore: scores.length ? Math.max(...scores) : 0,
    taskCounts: {
      total: taskRows.size,
      allPass,
      mixed,
      allFail
    }
  };
}

function formatAssert(test: BenchResult["tests"][number]) {
  const lines = [`${test.passed ? "PASS" : "FAIL"} ${test.source}`];
  if (!test.passed && (test.expected !== undefined || test.actual !== undefined)) {
    lines.push(`expected: ${test.expected ?? "n/a"}`);
    lines.push(`actual:   ${test.actual ?? "n/a"}`);
    if (test.operator) lines.push(`operator: ${test.operator}`);
  }
  if (!test.passed && test.error) lines.push(`error: ${test.error}`);
  return lines.join("\n");
}

function formatCommentSignal(signal: ThinkingCommentSignal | undefined, thresholdPercent: number) {
  if (!signal) return "No thinking-in-comments signal recorded for this result.";
  const flagged = commentSignalIsFlagged(signal, thresholdPercent);
  const reasons = commentSignalReasons(signal, thresholdPercent);
  const lines = [
    flagged ? "FLAGGED: generated comments look like thinking." : "OK: generated comments are below the threshold.",
    `Threshold: ${normalizeCommentSignalThreshold(thresholdPercent)}%`,
    `Original task comment lines: ${signal.originalCommentLines}`,
    `Extra comment lines: ${signal.generatedCommentLines}`,
    `Generated code lines: ${signal.generatedCodeLines}`,
    `Added comment lines: ${signal.addedCommentLines}`,
    `Extra comment/code ratio: ${pct(signal.commentRatio)}`
  ];
  if (reasons.length) {
    lines.push("", "Reasons:", ...reasons.map((reason) => `- ${reason}`));
  }
  return lines.join("\n");
}

function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra request body must be a JSON object.");
  }
  return parsed;
}

function statusIsLive(status?: string) {
  return status === "running" || status === "queued";
}

function statusIsInProgress(status?: string) {
  return status === "running";
}

function resultNumbers(run: BenchRun | null, passed: boolean) {
  return (run?.results ?? [])
    .filter((result) => result.passed === passed)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}

function thinkingResultNumbers(run: BenchRun | null, flagged: boolean, thresholdPercent: number) {
  return (run?.results ?? [])
    .filter((result) => commentSignalIsFlagged(analyzeThinkingComments(result), thresholdPercent) === flagged)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}

function mergeRun(previous: BenchRun | undefined, next: BenchRun) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    results: next.results.length ? next.results : previous.results
  };
}

function mergeRunList(previous: BenchRun[], nextRuns: BenchRun[]) {
  return nextRuns.map((next) => mergeRun(previous.find((run) => run.id === next.id), next));
}

function updateRunInPlace(previous: BenchRun[], next: BenchRun) {
  const index = previous.findIndex((run) => run.id === next.id);
  if (index === -1) return [next, ...previous];
  return previous.map((run, runIndex) => (runIndex === index ? mergeRun(run, next) : run));
}

function formatExtraBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  return JSON.stringify(value, null, 2);
}

function normalizeParallelTasks(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(64, Math.max(1, Math.floor(value)));
}

function normalizePassCount(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.passCount;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function normalizeCommentSignalThreshold(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.commentSignalThreshold;
  return value;
}

function readSidebarCollapsed(win: Window = window) {
  return win.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

function attemptPassNumber(value: { passNumber?: number } | Record<string, unknown> | undefined) {
  const parsed = Number(value?.passNumber ?? 1);
  return normalizePassCount(parsed);
}

function attemptKey(taskId: string, passNumber = 1, attemptId?: string) {
  return attemptId || `${taskId}::pass-${attemptPassNumber({ passNumber })}`;
}

function attemptLabel(passNumber: number, passTotal = 1) {
  return passTotal > 1 ? `Pass ${passNumber}` : "Pass";
}

function passRangeLabel(startPass: number, endPass: number, passTotal = 1) {
  if (passTotal <= 1) return "Pass";
  return startPass === endPass ? `Pass ${startPass}` : `Pass ${startPass} - ${endPass}`;
}

function groupSequentialPasses(
  attempts: Array<{ attempt: TaskRow; mergeKey: string }>
): PassTabGroup[] {
  const groups: PassTabGroup[] = [];
  for (const item of attempts) {
    const { attempt, mergeKey } = item;
    const previousGroup = groups[groups.length - 1];
    const canAppend = previousGroup
      && previousGroup.key.split("::merge::")[1] === mergeKey
      && previousGroup.status === attempt.status
      && previousGroup.endPass + 1 === attempt.passNumber;
    if (!canAppend) {
      groups.push({
        key: `${attempt.taskId}::range-${attempt.passNumber}::merge::${mergeKey}`,
        startPass: attempt.passNumber,
        endPass: attempt.passNumber,
        status: attempt.status,
        attempts: [attempt],
        representative: attempt
      });
      continue;
    }
    previousGroup.endPass = attempt.passNumber;
    previousGroup.attempts.push(attempt);
  }
  return groups;
}

function groupSequentialChartPasses(
  rows: PassVariabilityStats["passRows"]
): ChartPassGroup[] {
  const groups: ChartPassGroup[] = [];
  for (const row of rows) {
    const mergeKey = JSON.stringify({
      completed: row.completed,
      passed: row.passed,
      failed: row.failed,
      score: row.score
    });
    const previousGroup = groups[groups.length - 1];
    const canAppend = previousGroup
      && previousGroup.key.split("::merge::")[1] === mergeKey
      && previousGroup.endPass + 1 === row.passNumber;
    if (!canAppend) {
      groups.push({
        key: `chart-range-${row.passNumber}::merge::${mergeKey}`,
        startPass: row.passNumber,
        endPass: row.passNumber,
        row
      });
      continue;
    }
    previousGroup.endPass = row.passNumber;
  }
  return groups;
}

function groupedGenerationLabel(attempts: TaskRow[]) {
  const durations = attempts
    .map((attempt) => attempt.result?.generationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (!durations.length) return "n/a";
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  if (min === max) return formatMs(min);
  return `${formatMs(min)} - ${formatMs(max)}`;
}

function orderedChannelOutput(taskTokens: TokenEvent[] = []) {
  const grouped = new Map<string, string>();
  for (const token of taskTokens) {
    grouped.set(token.channel, `${grouped.get(token.channel) || ""}${token.text}`);
  }
  const channelOrder = ["thinking", "output", "refusal"];
  return [...grouped.entries()].sort(([left], [right]) => {
    const leftIndex = channelOrder.indexOf(left);
    const rightIndex = channelOrder.indexOf(right);
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

function formatPromptMessages(messages: unknown) {
  if (!Array.isArray(messages)) return undefined;
  const formatted = messages.map((message) => {
    if (!message || typeof message !== "object") return "";
    const role = "role" in message ? String(message.role || "").toUpperCase() : "";
    const content = "content" in message ? String(message.content || "") : "";
    if (!role && !content) return "";
    return role ? `${role}:\n${content}` : content;
  }).filter(Boolean);
  return formatted.length ? formatted.join("\n\n") : undefined;
}

function buildInstructionPromptFallback(run: BenchRun | null, originalPrompt?: string) {
  if (!originalPrompt) return undefined;
  const systemContent = run?.config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userTemplate = run?.config?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
  const userContent = String(userTemplate || DEFAULT_PROMPT_TEMPLATE).replaceAll("%problem_code%", originalPrompt);
  return `SYSTEM:\n${systemContent}\n\nUSER:\n${userContent}`;
}

export default function App() {
  const initialRoute = useMemo(() => readBenchRoute(), []);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_FORM_VALUES.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_FORM_VALUES.apiKey);
  const [model, setModel] = useState(DEFAULT_FORM_VALUES.model);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_FORM_VALUES.maxTokens);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_FORM_VALUES.timeoutSeconds);
  const [parallelTasks, setParallelTasks] = useState(DEFAULT_FORM_VALUES.parallelTasks);
  const [passCount, setPassCount] = useState(DEFAULT_FORM_VALUES.passCount);
  const [commentSignalThreshold, setCommentSignalThreshold] = useState(DEFAULT_FORM_VALUES.commentSignalThreshold);
  const [sampleLimit, setSampleLimit] = useState(DEFAULT_FORM_VALUES.sampleLimit);
  const [startIndex, setStartIndex] = useState(DEFAULT_FORM_VALUES.startIndex);
  const [testNumbers, setTestNumbers] = useState(DEFAULT_FORM_VALUES.testNumbers);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_FORM_VALUES.systemPrompt);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_FORM_VALUES.promptTemplate);
  const [extraBody, setExtraBody] = useState(DEFAULT_FORM_VALUES.extraBody);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [route, setRoute] = useState<BenchRoute>(initialRoute);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    initialRoute.view === "run" ? initialRoute.id : null
  );
  const [tokens, setTokens] = useState<TokenEvent[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    typeof window !== "undefined" ? readSidebarCollapsed(window) : false
  ));
  const [selectedPassByTask, setSelectedPassByTask] = useState<Record<string, number>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [taskStartedAtByRun, setTaskStartedAtByRun] = useState<Record<string, number>>({});
  const [disabledNotificationRunIds, setDisabledNotificationRunIds] = useState(() => (
    typeof window !== "undefined" ? readDisabledRunNotificationIds(window) : new Set<string>()
  ));
  const sourcesRef = useRef<Map<string, EventSource>>(new Map());
  const notifiedRunsRef = useRef<Set<string>>(new Set());
  const observedLiveRunsRef = useRef<Set<string>>(new Set());
  const disabledNotificationRunIdsRef = useRef(disabledNotificationRunIds);
  const selectedRunIdRef = useRef<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((candidate) => candidate.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );
  const selectedScoreRange = useMemo(() => scoreRange(selectedRun), [selectedRun]);
  const selectedProgressSegments = useMemo(() => progressSegments(selectedRun), [selectedRun]);
  const selectedTaskStartedAtMs = selectedRun?.id ? taskStartedAtByRun[selectedRun.id] : null;
  const selectedLiveEstimate = useMemo(
    () => liveEstimate(selectedRun, events, nowMs, selectedTaskStartedAtMs),
    [events, nowMs, selectedRun, selectedTaskStartedAtMs]
  );
  const selectedSpeedStats = useMemo(
    () => speedStats(selectedRun, events, nowMs, selectedTaskStartedAtMs),
    [events, nowMs, selectedRun, selectedTaskStartedAtMs]
  );
  const selectedThinkingStats = useMemo(
    () => thinkingInCommentsStats(selectedRun?.results ?? [], commentSignalThreshold),
    [commentSignalThreshold, selectedRun]
  );
  const selectedRunNotificationsEnabled = selectedRun
    ? notificationsEnabledForRun(selectedRun.id, disabledNotificationRunIds)
    : true;

  const tokensByAttempt = useMemo(() => {
    const grouped = new Map<string, TokenEvent[]>();
    for (const token of tokens) {
      const key = attemptKey(token.taskId, attemptPassNumber(token), token.attemptId);
      grouped.set(key, [...(grouped.get(key) || []), token]);
    }
    return grouped;
  }, [tokens]);

  const promptInfoByAttempt = useMemo(() => {
    const grouped = new Map<string, TaskPromptInfo>();
    const update = (taskId: string, passNumber: number, attemptId: string | undefined, next: TaskPromptInfo) => {
      if (!taskId) return;
      const key = attemptKey(taskId, passNumber, attemptId);
      grouped.set(key, { ...(grouped.get(key) || {}), ...next });
    };
    for (const event of events) {
      const taskId = String(event.data.taskId || "");
      const passNumber = attemptPassNumber(event.data);
      const attemptId = typeof event.data.attemptId === "string" ? event.data.attemptId : undefined;
      if (event.type === "task-started") {
        update(taskId, passNumber, attemptId, {
          prompt: typeof event.data.prompt === "string" ? event.data.prompt : undefined,
          test: typeof event.data.test === "string" ? event.data.test : undefined
        });
      }
      if (event.type === "prompt") {
        update(taskId, passNumber, attemptId, {
          instructionPrompt: formatPromptMessages(event.data.messages)
        });
      }
    }
    for (const result of selectedRun?.results ?? []) {
      update(result.taskId, attemptPassNumber(result), result.attemptId, {
        prompt: result.prompt,
        instructionPrompt: result.instructionPrompt,
        test: result.test
      });
    }
    return grouped;
  }, [events, selectedRun]);

  const taskGroups = useMemo(() => {
    const rows = new Map<string, TaskRow>();
    for (const event of events) {
      if (event.type !== "task-started") continue;
      const taskId = String(event.data.taskId || "");
      const index = Number(event.data.index);
      if (!taskId || !Number.isFinite(index)) continue;
      const passNumber = attemptPassNumber(event.data);
      const passTotal = attemptPassNumber({ passNumber: Number(event.data.passTotal ?? runPassCount(selectedRun)) });
      const attemptId = typeof event.data.attemptId === "string" ? event.data.attemptId : undefined;
      const key = attemptKey(taskId, passNumber, attemptId);
      rows.set(key, {
        key,
        taskId,
        attemptId,
        passNumber,
        passTotal,
        passOrdinal: Number(event.data.passOrdinal) || undefined,
        index,
        entryPoint: String(event.data.entryPoint || ""),
        prompt: typeof event.data.prompt === "string" ? event.data.prompt : undefined,
        test: typeof event.data.test === "string" ? event.data.test : undefined,
        status: "running"
      });
    }
    for (const taskId of selectedRun?.activeTaskIds ?? []) {
      const passNumber = 1;
      const key = attemptKey(taskId, passNumber);
      if (rows.has(key)) continue;
      const tokenIndex = tokensByAttempt.get(key)?.find((token) => Number.isFinite(token.index))?.index;
      const parsedIndex = Number(taskId.match(/HumanEval\/(\d+)$/)?.[1]);
      const fallbackIndex = Number.isFinite(parsedIndex) ? parsedIndex : Number.MAX_SAFE_INTEGER;
      const promptInfo = promptInfoByAttempt.get(key);
      rows.set(key, {
        key,
        taskId,
        passNumber,
        passTotal: runPassCount(selectedRun),
        index: Number.isFinite(tokenIndex) ? Number(tokenIndex) : fallbackIndex,
        entryPoint: "",
        prompt: promptInfo?.prompt,
        test: promptInfo?.test,
        status: "running"
      });
    }
    for (const result of selectedRun?.results ?? []) {
      const passNumber = attemptPassNumber(result);
      const passTotal = attemptPassNumber({ passNumber: result.passTotal ?? runPassCount(selectedRun) });
      const key = attemptKey(result.taskId, passNumber, result.attemptId);
      rows.set(key, {
        key,
        taskId: result.taskId,
        attemptId: result.attemptId,
        passNumber,
        passTotal,
        index: result.index,
        entryPoint: result.entryPoint,
        prompt: result.prompt,
        test: result.test,
        status: result.passed ? "pass" : "fail",
        result
      });
    }
    const groups = new Map<string, TaskGroup>();
    for (const row of rows.values()) {
      const group = groups.get(row.taskId);
      if (group) {
        group.index = Math.min(group.index, row.index);
        if (!group.entryPoint && row.entryPoint) group.entryPoint = row.entryPoint;
        group.attempts.push(row);
      } else {
        groups.set(row.taskId, {
          taskId: row.taskId,
          index: row.index,
          entryPoint: row.entryPoint,
          attempts: [row]
        });
      }
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        attempts: group.attempts.sort((left, right) => left.passNumber - right.passNumber)
      }))
      .sort((left, right) => left.index - right.index);
  }, [events, promptInfoByAttempt, selectedRun, tokensByAttempt]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    const canonicalPath = routePath(route);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(null, "", canonicalPath);
    }
    const handlePopState = () => setRoute(readBenchRoute());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (route.view === "run") {
      setSelectedRunId(route.id);
      return;
    }
    setSelectedRunId(null);
    setTokens([]);
    setEvents([]);
    resetRunConfig();
  }, [route]);

  useEffect(() => {
    disabledNotificationRunIdsRef.current = disabledNotificationRunIds;
  }, [disabledNotificationRunIds]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!statusIsLive(selectedRun?.status)) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRun?.status]);

  async function toggleNotificationsForRun(run: BenchRun) {
    if (!browserNotificationsAvailable(window)) {
      setError("This browser does not support web notifications.");
      return;
    }
    const currentlyEnabled = notificationsEnabledForRun(run.id, disabledNotificationRunIdsRef.current);
    if (currentlyEnabled) {
      setDisabledNotificationRunIds(writeRunNotificationPreference(run.id, false, window));
      return;
    }
    const enabled = await requestNotificationsEnabled(window);
    if (enabled) {
      setDisabledNotificationRunIds(writeRunNotificationPreference(run.id, true, window));
    }
    if (!enabled) setError("Notifications were not enabled.");
  }

  function rememberLiveRuns(nextRuns: BenchRun[]) {
    for (const run of nextRuns) {
      if (statusIsLive(run.status)) observedLiveRunsRef.current.add(run.id);
    }
  }

  function notifyRunFinished(run: BenchRun, eventType: string) {
    if (!notificationsEnabledForRun(run.id, disabledNotificationRunIdsRef.current)) return;
    dispatchRunNotification(run, eventType, notifiedRunsRef.current, window);
  }

  function notifyObservedTerminalRuns(nextRuns: BenchRun[]) {
    for (const run of nextRuns) {
      if (!observedLiveRunsRef.current.has(run.id)) continue;
      if (!isTerminalNotificationStatus(run.status)) continue;
      notifyRunFinished(run, run.status);
    }
  }

  function navigateTo(routeTarget: BenchRoute, replace = false) {
    const path = routePath(routeTarget);
    if (window.location.pathname !== path) {
      if (replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
    }
    setRoute(routeTarget);
  }

  async function loadRuns(selectLatest = false) {
    const response = await fetch(`${BENCH_API}/api/humaneval/runs`);
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed to load runs");
    const nextRuns = json.runs as BenchRun[];
    rememberLiveRuns(nextRuns);
    notifyObservedTerminalRuns(nextRuns);
    setRuns((previous) => mergeRunList(previous, nextRuns));
    if (selectLatest) {
      const latestRun = nextRuns[0];
      navigateTo(latestRun ? { view: "run", id: latestRun.id } : { view: "new" });
    } else if (selectedRunId && !nextRuns.some((run) => run.id === selectedRunId)) {
      navigateTo({ view: "new" });
    }
    for (const run of nextRuns.filter((candidate) => statusIsLive(candidate.status))) {
      connectEvents(run.id);
    }
  }

  useEffect(() => {
    loadRuns().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => {
      for (const source of sourcesRef.current.values()) source.close();
      sourcesRef.current.clear();
    };
  }, []);

  function resetRunConfig() {
    setBaseUrl(DEFAULT_FORM_VALUES.baseUrl);
    setApiKey(DEFAULT_FORM_VALUES.apiKey);
    setModel(DEFAULT_FORM_VALUES.model);
    setMaxTokens(DEFAULT_FORM_VALUES.maxTokens);
    setTimeoutSeconds(DEFAULT_FORM_VALUES.timeoutSeconds);
    setParallelTasks(DEFAULT_FORM_VALUES.parallelTasks);
    setPassCount(DEFAULT_FORM_VALUES.passCount);
    setCommentSignalThreshold(DEFAULT_FORM_VALUES.commentSignalThreshold);
    setSampleLimit(DEFAULT_FORM_VALUES.sampleLimit);
    setStartIndex(DEFAULT_FORM_VALUES.startIndex);
    setTestNumbers(DEFAULT_FORM_VALUES.testNumbers);
    setSystemPrompt(DEFAULT_FORM_VALUES.systemPrompt);
    setPromptTemplate(DEFAULT_FORM_VALUES.promptTemplate);
    setExtraBody(DEFAULT_FORM_VALUES.extraBody);
  }

  function selectNewBench() {
    navigateTo({ view: "new" });
  }

  function loadRunConfig(run: BenchRun) {
    const config = run.config ?? {};
    setBaseUrl(config.baseUrl ?? run.baseUrl ?? "");
    setModel(config.model ?? run.model ?? "");
    setMaxTokens(Number(config.maxTokens ?? 2048));
    setTimeoutSeconds(Number(config.timeoutSeconds ?? 15));
    setParallelTasks(normalizeParallelTasks(Number(config.parallelTasks ?? 1)));
    setPassCount(normalizePassCount(Number(config.passCount ?? 1)));
    setSampleLimit(Number(config.sampleLimit ?? 0));
    setStartIndex(Number(config.startIndex ?? 0));
    setTestNumbers(String(config.testNumbers ?? ""));
    setSystemPrompt(String(config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT));
    setPromptTemplate(String(config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE));
    setExtraBody(formatExtraBody(config.extraBody));
  }

  useEffect(() => {
    if (!selectedRunId) {
      setTokens([]);
      setEvents([]);
      return;
    }
    fetch(`${BENCH_API}/api/humaneval/runs/${selectedRunId}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Failed to load run");
        setRuns((previous) => updateRunInPlace(previous, json));
        loadRunConfig(json);
        if (statusIsLive(json.status)) connectEvents(json.id);
        const runEvents = (json.events as EventEnvelope[] | undefined) ?? [];
        const tokenEvents = runEvents.filter((event) => event.type === "token");
        const latestTaskStartedAtMs = currentTaskStartedAtMs(json, runEvents);
        if (latestTaskStartedAtMs) {
          setTaskStartedAtByRun((previous) => ({ ...previous, [json.id]: latestTaskStartedAtMs }));
        }
        setEvents(runEvents);
        setTokens(tokenEvents.map((event) => event.data as unknown as TokenEvent));
      })
      .catch((runError) => setError(runError instanceof Error ? runError.message : String(runError)));
  }, [selectedRunId]);

  async function startRun() {
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/humaneval/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          model,
          maxTokens,
          timeoutSeconds,
          parallelTasks: normalizeParallelTasks(parallelTasks),
          passCount: normalizePassCount(passCount),
          sampleLimit,
          startIndex,
          testNumbers,
          systemPrompt,
          promptTemplate,
          temperature: 0,
          extraBody: parseJsonObject(extraBody)
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to start run");
      setRuns((previous) => updateRunInPlace(previous, json));
      navigateTo({ view: "run", id: json.id });
      setTokens([]);
      setEvents([]);
      setTaskStartedAtByRun((previous) => {
        const { [json.id]: _ignored, ...rest } = previous;
        return rest;
      });
      if (browserNotificationsAvailable(window)) {
        requestNotificationsEnabled(window).then((enabled) => {
          if (!enabled) setError("Notifications were not enabled.");
        }).catch(() => undefined);
      }
      observedLiveRunsRef.current.add(json.id);
      connectEvents(json.id);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  }

  function connectEvents(runId: string) {
    if (sourcesRef.current.has(runId)) return;
    observedLiveRunsRef.current.add(runId);
    const source = new EventSource(`${BENCH_API}/api/humaneval/runs/${runId}/events`);
    sourcesRef.current.set(runId, source);
    const handle = (message: MessageEvent) => {
      const event = JSON.parse(message.data) as EventEnvelope;
      const maybeSummary = event.data.summary as BenchRun | undefined;
      if (maybeSummary) {
        rememberLiveRuns([maybeSummary]);
        setRuns((previous) => updateRunInPlace(previous, maybeSummary));
      }
      const currentSelectedRunId = selectedRunIdRef.current;
      if (runId === currentSelectedRunId) {
        setEvents((prev) => [...prev, event]);
        if (event.type === "task-started") {
          const timestamp = new Date(event.at).getTime();
          if (Number.isFinite(timestamp)) {
            setTaskStartedAtByRun((previous) => ({ ...previous, [runId]: timestamp }));
          }
        }
        if (event.type === "token") {
          const data = event.data as unknown as TokenEvent;
          setTokens((prev) => [...prev, data]);
        }
        if (event.type === "task-finished") {
          fetch(`${BENCH_API}/api/humaneval/runs/${runId}`)
            .then(async (response) => {
              const json = await response.json();
              if (response.ok) {
                setRuns((previous) => updateRunInPlace(previous, json));
                if (runId === selectedRunIdRef.current) {
                  const refreshedEvents = (json.events as EventEnvelope[] | undefined) ?? [];
                  const refreshedTokens = refreshedEvents
                    .filter((refreshedEvent) => refreshedEvent.type === "token")
                    .map((refreshedEvent) => refreshedEvent.data as unknown as TokenEvent);
                  setEvents(refreshedEvents);
                  setTokens(refreshedTokens);
                }
              }
            })
            .catch(() => undefined);
        }
      }
      if (notificationEventIsTerminal(event.type)) {
        if (maybeSummary) notifyRunFinished(maybeSummary, event.type);
        source.close();
        sourcesRef.current.delete(runId);
        loadRuns().catch(() => undefined);
      }
    };
    for (const name of ["run-started", "task-started", "prompt", "token", "raw-delta", "code-extracted", "task-finished", "done", "error"]) {
      source.addEventListener(name, handle);
    }
    source.onerror = () => {
      source.close();
      sourcesRef.current.delete(runId);
      loadRuns().catch(() => undefined);
    };
  }

  async function cancelRun() {
    if (!selectedRun || !statusIsLive(selectedRun.status)) return;
    await fetch(`${BENCH_API}/api/humaneval/runs/${selectedRun.id}/cancel`, { method: "POST" });
    await loadRuns();
  }

  async function deleteRun(run: BenchRun) {
    const label = `${run.model || "model"} · ${formatTime(run.createdAt)}`;
    if (!window.confirm(`Delete benchmark run?\n\n${label}\n\nThis removes its saved artifacts from disk.`)) return;
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/humaneval/runs/${run.id}`, { method: "DELETE" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Failed to delete run");
      sourcesRef.current.get(run.id)?.close();
      sourcesRef.current.delete(run.id);
      if (selectedRunIdRef.current === run.id) {
        navigateTo({ view: "new" });
        setTokens([]);
        setEvents([]);
      }
      await loadRuns();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function copyNumbers(passed: boolean) {
    const text = resultNumbers(selectedRun, passed);
    await navigator.clipboard.writeText(text);
  }

  async function copyThinkingNumbers(flagged: boolean) {
    const text = thinkingResultNumbers(selectedRun, flagged, commentSignalThreshold);
    await navigator.clipboard.writeText(text);
  }

  return (
    <main className={sidebarCollapsed ? "bench-shell sidebar-collapsed" : "bench-shell"}>
      {sidebarCollapsed ? (
        <button
          aria-label="Expand benchmark settings"
          className="sidebar-float-toggle"
          title="Expand settings"
          type="button"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeftOpen size={21} />
        </button>
      ) : (
        <aside className="bench-sidebar">
          <div className="bench-title-row">
            <div className="bench-title">
              <TerminalSquare size={34} />
              <div>
                <p>HumanEval</p>
                <h1>Code benchmark workbench</h1>
              </div>
            </div>
            <button
              aria-label="Collapse benchmark settings"
              className="sidebar-toggle"
              title="Collapse settings"
              type="button"
              onClick={() => setSidebarCollapsed(true)}
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
          <label className="field">
            <span><Server size={14} /> Base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" />
          </label>
          <label className="field">
            <span><KeyRound size={14} /> API key</span>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="optional" />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model-name" />
          </label>
          <div className="bench-number-grid">
            <label className="field">
              <span>Max tokens</span>
              <input value={maxTokens} min={256} step={256} type="number" onChange={(event) => setMaxTokens(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Timeout</span>
              <input value={timeoutSeconds} min={1} type="number" onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Parallel</span>
              <input value={parallelTasks} min={1} max={64} type="number" onChange={(event) => setParallelTasks(normalizeParallelTasks(Number(event.target.value)))} />
            </label>
            <label className="field">
              <span>Passes</span>
              <input value={passCount} min={1} max={100} type="number" onChange={(event) => setPassCount(normalizePassCount(Number(event.target.value)))} />
            </label>
            <label className="field">
              <span>Start</span>
              <input value={startIndex} min={0} max={163} type="number" onChange={(event) => setStartIndex(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Limit</span>
              <input value={sampleLimit} min={0} max={164} type="number" onChange={(event) => setSampleLimit(Number(event.target.value))} />
            </label>
          </div>
          <label className="field">
            <span><FileText size={14} /> Test numbers</span>
            <textarea
              value={testNumbers}
              onChange={(event) => setTestNumbers(event.target.value)}
              rows={3}
              placeholder="0, 1, 2 or 10-25. Empty uses start/limit."
            />
          </label>
          <label className="field">
            <span><Settings2 size={14} /> System prompt</span>
            <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} />
          </label>
          <label className="field">
            <span><FileText size={14} /> Prompt template</span>
            <textarea
              value={promptTemplate}
              onChange={(event) => setPromptTemplate(event.target.value)}
              rows={11}
              placeholder="Use %problem_code% where the HumanEval function stub should be inserted."
            />
          </label>
          <label className="field">
            <span><Settings2 size={14} /> Extra request body</span>
            <textarea value={extraBody} onChange={(event) => setExtraBody(event.target.value)} rows={5} />
          </label>
          <div className="bench-warning">
            Executes model-generated Python locally. Use a dedicated sandbox for untrusted endpoints.
          </div>
          <div className="bench-actions">
            <button className="primary-action" type="button" onClick={startRun} disabled={!model.trim()}>
              <Play size={17} /> Start run
            </button>
            <button className="secondary-action" type="button" onClick={cancelRun} disabled={!statusIsLive(selectedRun?.status)}>
              <CircleStop size={17} /> Stop selected
            </button>
          </div>
          {error ? <p className="bench-error">{error}</p> : null}
        </aside>
      )}

      <section className="bench-main">
        <section className="run-strip">
          <div className="pane-head">Benchmarks</div>
          <div className="run-list">
            <div className={selectedRunId === null ? "run-tab new-run-tab active" : "run-tab new-run-tab"}>
              <button className="run-tab-main" type="button" onClick={selectNewBench}>
                <Plus size={16} />
                <strong>New bench</strong>
                <small>Default parameters</small>
              </button>
            </div>
            {runs.length ? runs.map((candidate) => (
              <div
                className={candidate.id === selectedRunId ? "run-tab active" : "run-tab"}
                key={candidate.id}
              >
                <button className="run-tab-main" type="button" onClick={() => navigateTo({ view: "run", id: candidate.id })}>
                  <span className={`status-dot ${statusIsLive(candidate.status) ? "live" : ""}`} />
                  <strong>{candidate.model || "model"}</strong>
                  <small>{candidate.status} · {candidate.completed}/{runTotal(candidate)} · {formatTime(candidate.createdAt)}</small>
                </button>
                <button
                  aria-label={`Delete benchmark run ${candidate.model || candidate.id}`}
                  className="run-delete"
                  title="Delete benchmark run"
                  type="button"
                  onClick={() => deleteRun(candidate)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )) : <p className="empty-copy">No benchmark runs recorded yet.</p>}
          </div>
        </section>

        <header className="bench-status">
          <div>
            <p>{selectedRun ? selectedRun.status : "idle"}</p>
            <h2>{selectedRun ? selectedRun.model : "Ready for an OpenAI-compatible model"}</h2>
          </div>
          <div className="bench-score">
            <strong>{selectedRun ? pct(selectedRun.liveScore) : "0%"}</strong>
            <span>{selectedRun ? `${selectedRun.passed}/${selectedRun.completed || 0} passing live` : "pass@1 live score"}</span>
            <small>{selectedRun ? `est. range ${pct(selectedScoreRange.worst)}-${pct(selectedScoreRange.best)}` : "est. range 0%-100%"}</small>
          </div>
        </header>
        <div
          className="progress-rail"
          aria-label={
            selectedRun
              ? `${selectedRun.failed} failed, ${selectedRun.passed} passed, ${Math.max(runTotal(selectedRun) - selectedRun.completed, 0)} remaining`
              : "No run progress"
          }
        >
          <span className="progress-failed" style={{ width: `${selectedProgressSegments.failed}%` }} />
          <span className="progress-passed" style={{ width: `${selectedProgressSegments.passed}%` }} />
          <span className="progress-remaining" style={{ width: `${selectedProgressSegments.remaining}%` }} />
        </div>
        <section className="bench-metrics">
          <Metric label="Completed" value={<MetricLines lines={completedMetricLines(selectedRun)} />} />
          <Metric label="Passed" value={String(selectedRun?.passed ?? 0)} tone="passed">
            <button className="metric-action" type="button" onClick={() => copyNumbers(true)} disabled={!selectedRun?.results.length}>
              <ClipboardCopy size={14} /> Copy passed
            </button>
          </Metric>
          <Metric label="Failed" value={String(selectedRun?.failed ?? 0)} tone="failed">
            <button className="metric-action" type="button" onClick={() => copyNumbers(false)} disabled={!selectedRun?.results.length}>
              <ClipboardCopy size={14} /> Copy failed
            </button>
          </Metric>
          <Metric
            label="Assertions"
            value={
              selectedRun
                ? `${selectedRun.assertionsPassed ?? assertionStats(selectedRun.results).passed}/${selectedRun.assertionsTotal ?? assertionStats(selectedRun.results).total} (${pct(selectedRun.assertionScore ?? assertionStats(selectedRun.results).score)})`
                : "0/0 (0%)"
            }
          />
          <Metric
            label="Thinking in comments"
            value={selectedRun ? `${selectedThinkingStats.flagged}/${selectedThinkingStats.total}` : "0/0"}
          >
            <div className="metric-actions">
              <button className="metric-action" type="button" onClick={() => copyThinkingNumbers(true)} disabled={!selectedRun?.results.length}>
                <ClipboardCopy size={14} /> Copy detected
              </button>
              <button className="metric-action" type="button" onClick={() => copyThinkingNumbers(false)} disabled={!selectedRun?.results.length}>
                <ClipboardCopy size={14} /> Copy clean
              </button>
            </div>
            <label className="metric-input">
              <span>Threshold</span>
              <input
                value={commentSignalThreshold}
                type="number"
                onChange={(event) => setCommentSignalThreshold(normalizeCommentSignalThreshold(Number(event.target.value)))}
              />
              <b>%</b>
            </label>
          </Metric>
          {statusIsInProgress(selectedRun?.status) ? (
            <Metric
              label="ETA"
              value={selectedLiveEstimate
                ? (
                    <MetricLines
                      lines={[
                        ["Duration", `~${selectedLiveEstimate.remaining}`],
                        ["Time", selectedLiveEstimate.endTime]
                      ]}
                    />
                  )
                : "Estimating..."}
            >
              {selectedRun ? (
                <button
                  className="metric-action"
                  type="button"
                  onClick={() => toggleNotificationsForRun(selectedRun)}
                  disabled={typeof window !== "undefined" && !("Notification" in window)}
                >
                  {selectedRunNotificationsEnabled ? <BellOff size={14} /> : <Bell size={14} />}
                  {selectedRunNotificationsEnabled ? "Disable finish notification" : "Enable finish notification"}
                </button>
              ) : null}
            </Metric>
          ) : null}
          <Metric
            label="Speed"
            value={<MetricLines lines={[["Per task", selectedSpeedStats.averageTask], ["Total", selectedSpeedStats.bench]]} />}
          />
        </section>

        <PassVariabilityChart run={selectedRun} />

        <section className="results-panel">
          <div className="pane-head">Tasks</div>
          {taskGroups.length ? taskGroups.map((group) => {
            const runningAttempt = group.attempts.find((attempt) => attempt.status === "running");
            const passTotal = Math.max(runPassCount(selectedRun), ...group.attempts.map((attempt) => attempt.passTotal || 1));
            const attemptViews = group.attempts.map((attempt) => {
              const attemptResult = attempt.result;
              const promptInfo = promptInfoByAttempt.get(attempt.key);
              const originalPrompt = attemptResult?.prompt || promptInfo?.prompt || attempt.prompt;
              const instructionPrompt = attemptResult?.instructionPrompt
                || promptInfo?.instructionPrompt
                || buildInstructionPromptFallback(selectedRun, originalPrompt);
              const testPrompt = attemptResult?.test || promptInfo?.test || attempt.test;
              const liveOutput = orderedChannelOutput(tokensByAttempt.get(attempt.key));
              const commentSignal = analyzeThinkingComments(attemptResult);
              return {
                attempt,
                promptInfo,
                originalPrompt,
                instructionPrompt,
                testPrompt,
                liveOutput,
                commentSignal,
                thinkingInComments: commentSignalIsFlagged(commentSignal, commentSignalThreshold),
                mergeKey: JSON.stringify({
                  status: attempt.status,
                  entryPoint: attempt.entryPoint,
                  originalPrompt,
                  instructionPrompt,
                  testPrompt,
                  liveOutput: attempt.status === "running" ? liveOutput : null,
                  commentSignal: attemptResult ? formatCommentSignal(commentSignal, commentSignalThreshold) : null,
                  modelError: attemptResult?.modelError ?? null,
                  tests: attemptResult?.tests ?? null,
                  thinkingOutput: attemptResult?.thinkingOutput ?? null,
                  rawOutput: attemptResult?.rawOutput ?? null,
                  extractedCode: attemptResult?.extractedCode ?? null,
                  traceback: attemptResult?.traceback ?? null,
                  error: attemptResult?.error ?? null,
                  harnessStderr: attemptResult?.harnessStderr ?? null
                })
              };
            });
            const passTabGroups = groupSequentialPasses(attemptViews);
            const requestedPass = selectedPassByTask[group.taskId];
            const activePassGroup = passTabGroups.find((tabGroup) => (
              requestedPass !== undefined
              && requestedPass >= tabGroup.startPass
              && requestedPass <= tabGroup.endPass
            ))
              ?? passTabGroups.find((tabGroup) => tabGroup.status === "running")
              ?? passTabGroups[0];
            const row = activePassGroup?.representative ?? runningAttempt ?? group.attempts[0];
            const activeAttemptView = attemptViews.find((view) => view.attempt.key === row.key);
            const result = row.result;
            const liveOutput = activeAttemptView?.liveOutput ?? orderedChannelOutput(tokensByAttempt.get(row.key));
            const isRunning = row.status === "running";
            const groupIsRunning = group.attempts.some((attempt) => attempt.status === "running");
            const groupStatus = groupIsRunning
              ? "running"
              : group.attempts.every((attempt) => attempt.status === "pass")
                ? "pass"
                : "fail";
            const isOpen = expanded[group.taskId] ?? groupIsRunning;
            const completedPasses = group.attempts.filter((attempt) => attempt.status !== "running").length;
            const passedPasses = group.attempts.filter((attempt) => attempt.status === "pass").length;
            const assertsPassed = result?.tests.filter((test) => test.passed).length ?? 0;
            const assertScore = result?.tests.length ? assertsPassed / result.tests.length : 0;
            const commentSignal = activeAttemptView?.commentSignal ?? analyzeThinkingComments(result);
            const thinkingInComments = activeAttemptView?.thinkingInComments ?? commentSignalIsFlagged(commentSignal, commentSignalThreshold);
            const originalPrompt = activeAttemptView?.originalPrompt ?? result?.prompt ?? row.prompt;
            const instructionPrompt = activeAttemptView?.instructionPrompt
              ?? result?.instructionPrompt
              ?? buildInstructionPromptFallback(selectedRun, originalPrompt);
            const testPrompt = activeAttemptView?.testPrompt ?? result?.test ?? row.test;
            return (
              <article className={`result-row ${groupIsRunning ? "in-progress" : ""}`} key={group.taskId}>
                <button type="button" onClick={() => setExpanded((prev) => ({ ...prev, [group.taskId]: !isOpen }))}>
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className={`${groupStatus}-pill`}>{groupStatus === "running" ? "running" : groupStatus}</span>
                  <strong>{group.taskId}</strong>
                  <small>
                    #{group.index} · {row.entryPoint || group.entryPoint || "entry point pending"} · {passedPasses}/{completedPasses || 0} passes passing
                    {passTotal > 1 ? ` · ${completedPasses}/${passTotal} passes complete` : ""}
                    {result ? ` · ${passRangeLabel(activePassGroup.startPass, activePassGroup.endPass, passTotal)} · ${assertsPassed}/${result.tests.length} asserts · ${pct(assertScore)}` : ""}
                    {isRunning ? " · in progress" : result ? ` · ${groupedGenerationLabel(activePassGroup.attempts)}` : ""}
                    {thinkingInComments ? <span className="comment-flag"><AlertTriangle size={12} /> thinking in comments</span> : null}
                  </small>
                </button>
                {isOpen ? (
                  <div className="result-detail">
                    {passTotal > 1 || group.attempts.length > 1 ? (
                      <div className="pass-tabs" role="tablist" aria-label={`${group.taskId} passes`}>
                        {passTabGroups.map((tabGroup) => {
                          const attempt = tabGroup.representative;
                          const attemptAssertsPassed = attempt.result?.tests.filter((test) => test.passed).length ?? 0;
                          return (
                            <button
                              aria-selected={tabGroup.key === activePassGroup.key}
                              className={tabGroup.key === activePassGroup.key ? "active" : ""}
                              key={tabGroup.key}
                              role="tab"
                              type="button"
                              onClick={() => setSelectedPassByTask((prev) => ({ ...prev, [group.taskId]: tabGroup.startPass }))}
                            >
                              <span className={`${tabGroup.status}-pill`}>
                                {tabGroup.status === "running" ? "running" : tabGroup.status}
                              </span>
                              <strong>{passRangeLabel(tabGroup.startPass, tabGroup.endPass, passTotal)}</strong>
                              <small>
                                {attempt.result
                                  ? `${attemptAssertsPassed}/${attempt.result.tests.length} asserts · ${groupedGenerationLabel(tabGroup.attempts)}`
                                  : "in progress"}
                              </small>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    {isRunning ? (
                      <details open>
                        <summary>Live output</summary>
                        {liveOutput.length ? liveOutput.map(([channel, text]) => (
                          <pre key={channel}>{`${channel}\n\n${text}`}</pre>
                        )) : <pre>Waiting for model tokens...</pre>}
                      </details>
                    ) : null}
                    {result?.modelError ? <pre>{result.modelError}</pre> : null}
                    {thinkingInComments ? <details open><summary>Thinking in comments</summary><pre className="comment-signal">{formatCommentSignal(commentSignal, commentSignalThreshold)}</pre></details> : null}
                    {result ? <details open><summary>Assert ledger</summary>{result.tests.map((test, index) => <pre key={index} className={test.passed ? "assert-pass" : "assert-fail"}>{formatAssert(test)}</pre>)}</details> : null}
                    <details open><summary>Prompt sent to model</summary><pre>{instructionPrompt || "Prompt pending."}</pre></details>
                    <details><summary>Original HumanEval task</summary><pre>{originalPrompt || "Task prompt pending."}</pre></details>
                    {result ? <details><summary>Thinking</summary><pre>{result.thinkingOutput || "No separate thinking stream captured."}</pre></details> : null}
                    {result ? <details><summary>Raw output</summary><pre>{result.rawOutput}</pre></details> : null}
                    {result ? <details><summary>Extracted code</summary><pre>{result.extractedCode}</pre></details> : null}
                    <details><summary>HumanEval tests</summary><pre>{testPrompt || "Tests pending."}</pre></details>
                    {result ? <details><summary>Traceback / harness</summary><pre>{result.traceback || result.error || result.harnessStderr || "No harness error."}</pre></details> : null}
                  </div>
                ) : null}
              </article>
            );
          }) : <p className="empty-copy">Tasks will appear as soon as they start.</p>}
        </section>
      </section>
    </main>
  );
}

function PassVariabilityChart({ run }: { run: BenchRun | null }) {
  const stats = passVariabilityStats(run);
  const completedRows = stats.passRows.filter((row) => row.completed > 0);
  const chartPassGroups = groupSequentialChartPasses(stats.passRows);
  const scoreSwing = stats.maxScore - stats.minScore;
  const hasMultiplePasses = stats.passTotal > 1;
  const consistencyTotal = stats.taskCounts.total || 1;
  const consistencySegments = [
    { key: "all-pass", label: "Always pass", value: stats.taskCounts.allPass, className: "consistency-pass" },
    { key: "mixed", label: "Mixed", value: stats.taskCounts.mixed, className: "consistency-mixed" },
    { key: "all-fail", label: "Always fail", value: stats.taskCounts.allFail, className: "consistency-fail" }
  ];

  return (
    <section className="variability-panel" aria-labelledby="pass-variability-title">
      <div className="pane-head" id="pass-variability-title">Pass variability</div>
      <div className="variability-body">
        <div className="variability-summary">
          <div>
            <span>Pass spread</span>
            <strong>{completedRows.length ? `${pct(stats.minScore)}-${pct(stats.maxScore)}` : "n/a"}</strong>
            <small>{completedRows.length > 1 ? `${pct(scoreSwing)} swing` : "Needs completed passes"}</small>
          </div>
          <div>
            <span>Mixed tasks</span>
            <strong>{stats.taskCounts.mixed}/{stats.taskCounts.total || 0}</strong>
            <small>At least one pass and one fail</small>
          </div>
          <div>
            <span>Completed passes</span>
            <strong>{completedRows.length}/{stats.passTotal}</strong>
            <small>{hasMultiplePasses ? "Per-pass score below" : "Run with 2+ passes"}</small>
          </div>
        </div>

        {run && hasMultiplePasses ? (
          <div
            className="pass-chart"
            role="img"
            aria-label={`Pass scores range from ${pct(stats.minScore)} to ${pct(stats.maxScore)} across completed passes.`}
          >
            {chartPassGroups.map((group) => (
              <div className="pass-chart-row" key={group.key}>
                <span>{passRangeLabel(group.startPass, group.endPass, stats.passTotal)}</span>
                <div className="pass-bar-track" aria-hidden="true">
                  <i style={{ width: `${group.row.score * 100}%` }} />
                </div>
                <b>{group.row.completed ? pct(group.row.score) : "pending"}</b>
                <small>{group.row.completed ? `${group.row.passed}/${group.row.completed}` : "0/0"}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">
            {run ? "Run with 2+ passes to see pass-to-pass variability." : "Select a run to see pass-to-pass variability."}
          </p>
        )}

        {stats.taskCounts.total ? (
          <div className="consistency-block">
            <div className="consistency-strip" aria-hidden="true">
              {consistencySegments.map((segment) => (
                segment.value ? (
                  <span
                    className={segment.className}
                    key={segment.key}
                    style={{ width: `${(segment.value / consistencyTotal) * 100}%` }}
                  />
                ) : null
              ))}
            </div>
            <div className="consistency-legend">
              {consistencySegments.map((segment) => (
                <span key={segment.key}>
                  <i className={segment.className} /> {segment.label} {segment.value}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  children,
  tone
}: {
  label: string;
  value: React.ReactNode;
  children?: React.ReactNode;
  tone?: "passed" | "failed";
}) {
  return (
    <div className={`bench-metric${tone ? ` bench-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

function MetricLines({ lines }: { lines: Array<[string, string]> }) {
  return (
    <span className="metric-lines">
      {lines.map(([label, value]) => (
        <span className="metric-line" key={label}>
          <span>{label}</span>
          <b>{value}</b>
        </span>
      ))}
    </span>
  );
}

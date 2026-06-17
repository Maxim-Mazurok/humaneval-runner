import {
  DEFAULT_FORM_VALUES,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  type BenchResult,
  type BenchRun,
  type EventEnvelope
} from "./benchmark";

export function pct(value?: number | null) {
  return `${Math.round((value || 0) * 1000) / 10}%`;
}

export function normalizeParallelTasks(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(64, Math.max(1, Math.floor(value)));
}

export function normalizePassCount(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.passCount;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

export function normalizeCommentSignalThreshold(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.commentSignalThreshold;
  return value;
}

export function runPassCount(run?: BenchRun | null) {
  return normalizePassCount(Number(run?.config?.passCount ?? 1));
}

export function runTotal(run?: BenchRun | null) {
  return run?.total || ((run?.selectedIndices?.length || 164) * runPassCount(run));
}

export function ordinal(value: number) {
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

export function completedMetricLines(run?: BenchRun | null): Array<[string, string]> {
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

export function scoreRange(run?: BenchRun | null) {
  if (!run) return { worst: 0, best: 0 };
  const total = runTotal(run);
  const remaining = Math.max(total - run.completed, 0);
  return {
    worst: total ? run.passed / total : 0,
    best: total ? (run.passed + remaining) / total : 0
  };
}

export function progressSegments(run?: BenchRun | null) {
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

export function formatMs(value?: number) {
  if (!value) return "n/a";
  if (value < 1000) return `${value}ms`;
  if (value >= 60_000) return formatDuration(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export function formatDuration(valueMs: number) {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTime(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

export function formatClock(valueMs: number) {
  const date = new Date(valueMs);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function runStartedAtMs(run?: BenchRun | null) {
  const value = run?.startedAt || run?.createdAt;
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function currentTaskStartedAtMs(run: BenchRun | null, events: EventEnvelope[]) {
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

export function statusIsLive(status?: string) {
  return status === "running" || status === "queued";
}

export function statusIsInProgress(status?: string) {
  return status === "running";
}

export function liveEstimate(run: BenchRun | null, events: EventEnvelope[], nowMs: number, taskStartedAtMs?: number | null) {
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

export function runElapsedMs(run: BenchRun | null, nowMs: number) {
  const startedAtMs = runStartedAtMs(run);
  if (!startedAtMs) return null;
  const finishedAtMs = run?.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const endMs = finishedAtMs && Number.isFinite(finishedAtMs) ? finishedAtMs : nowMs;
  return Math.max(endMs - startedAtMs, 0);
}

export function speedStats(run: BenchRun | null, events: EventEnvelope[], nowMs: number, taskStartedAtMs?: number | null) {
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

export function assertionStats(results: BenchResult[] = []) {
  const total = results.reduce((sum, result) => sum + result.tests.length, 0);
  const passed = results.reduce((sum, result) => sum + result.tests.filter((test) => test.passed).length, 0);
  return { passed, total, score: total ? passed / total : 0 };
}

export function formatAssert(test: BenchResult["tests"][number]) {
  const lines = [`${test.passed ? "PASS" : "FAIL"} ${test.source}`];
  if (!test.passed && (test.expected !== undefined || test.actual !== undefined)) {
    lines.push(`expected: ${test.expected ?? "n/a"}`);
    lines.push(`actual:   ${test.actual ?? "n/a"}`);
    if (test.operator) lines.push(`operator: ${test.operator}`);
  }
  if (!test.passed && test.error) lines.push(`error: ${test.error}`);
  return lines.join("\n");
}

export function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra request body must be a JSON object.");
  }
  return parsed;
}

export function resultNumbers(run: BenchRun | null, passed: boolean) {
  return (run?.results ?? [])
    .filter((result) => result.passed === passed)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}

export function mergeRun(previous: BenchRun | undefined, next: BenchRun) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    results: next.results.length ? next.results : previous.results
  };
}

export function mergeRunList(previous: BenchRun[], nextRuns: BenchRun[]) {
  return nextRuns.map((next) => mergeRun(previous.find((run) => run.id === next.id), next));
}

export function updateRunInPlace(previous: BenchRun[], next: BenchRun) {
  const index = previous.findIndex((run) => run.id === next.id);
  if (index === -1) return [next, ...previous];
  return previous.map((run, runIndex) => (runIndex === index ? mergeRun(run, next) : run));
}

export function formatExtraBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  return JSON.stringify(value, null, 2);
}

export function readSidebarCollapsed(win: Window = window) {
  return win.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

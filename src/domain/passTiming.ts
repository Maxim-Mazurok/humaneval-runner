import type { BenchRun, ChartPassGroup, EventEnvelope } from "./benchmark";
import { attemptPassNumber } from "./passes";
import { currentTaskStartedAtMs, formatClock, formatDuration, formatMs, runPassCount, runTotal, statusIsLive } from "./runs";

export type CurrentPassTiming = {
  passNumber: number;
  elapsedMilliseconds: number;
  elapsed: string;
  remaining: string | null;
  endTime: string | null;
};

export function currentPassTiming(
  run: BenchRun | null,
  events: EventEnvelope[],
  nowMilliseconds: number,
  taskStartedAtMilliseconds?: number | null
): CurrentPassTiming | null {
  if (!run || !statusIsLive(run.status)) return null;
  const passNumber = currentPassNumber(run, events);
  const startedAtMilliseconds = taskStartedAtMilliseconds ?? currentTaskStartedAtMs(run, events);
  const currentTaskMilliseconds = startedAtMilliseconds ? Math.max(nowMilliseconds - startedAtMilliseconds, 0) : 0;
  const completedResults = run.results.filter((result) => attemptPassNumber(result) === passNumber);
  const completedTaskMilliseconds = completedResults.reduce((totalMilliseconds, result) => (
    totalMilliseconds + validDurationMilliseconds(result.generationMs)
  ), 0);
  const elapsedMilliseconds = completedTaskMilliseconds + currentTaskMilliseconds;
  const remainingMilliseconds = currentPassRemainingMilliseconds(
    run,
    completedResults.length,
    completedTaskMilliseconds,
    currentTaskMilliseconds
  );

  return {
    passNumber,
    elapsedMilliseconds,
    elapsed: elapsedMilliseconds > 0 ? formatMs(elapsedMilliseconds) : "0s",
    remaining: remainingMilliseconds === null ? null : formatDuration(remainingMilliseconds),
    endTime: remainingMilliseconds === null ? null : formatClock(nowMilliseconds + remainingMilliseconds)
  };
}

export function passGroupTimeLabel(group: ChartPassGroup, timing: CurrentPassTiming | null) {
  if (timing && timing.passNumber >= group.startPass && timing.passNumber <= group.endPass) {
    return `current pass ${timing.elapsed}`;
  }
  return group.averagePassDurationMilliseconds
    ? `avg pass ${formatMs(group.averagePassDurationMilliseconds)}`
    : "";
}

function currentPassNumber(run: BenchRun, events: EventEnvelope[]) {
  const activeTaskIds = new Set(run.activeTaskIds ?? []);
  if (run.currentTaskId) activeTaskIds.add(run.currentTaskId);
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex];
    if (event.type !== "task-started") continue;
    const taskId = String(event.data.taskId || "");
    if (activeTaskIds.size && !activeTaskIds.has(taskId)) continue;
    return event.data.passNumber === undefined ? derivedCurrentPassNumber(run) : attemptPassNumber(event.data);
  }
  return derivedCurrentPassNumber(run);
}

function derivedCurrentPassNumber(run: BenchRun) {
  const passCount = runPassCount(run);
  const tasksPerPass = Math.max(1, Math.ceil(runTotal(run) / passCount));
  return Math.min(passCount, Math.floor(Math.max(run.completed, 0) / tasksPerPass) + 1);
}

function currentPassRemainingMilliseconds(
  run: BenchRun,
  completedTaskCount: number,
  completedTaskMilliseconds: number,
  currentTaskMilliseconds: number
) {
  const passCount = runPassCount(run);
  const tasksPerPass = Math.max(1, Math.ceil(runTotal(run) / passCount));
  const remainingTaskCount = Math.max(tasksPerPass - completedTaskCount, 0);
  if (!remainingTaskCount) return 0;
  const averageTaskMilliseconds = completedTaskCount
    ? completedTaskMilliseconds / completedTaskCount
    : currentTaskMilliseconds || null;
  if (!averageTaskMilliseconds) return null;
  const parallelTasks = Math.max(1, Math.floor(Number(run.config?.parallelTasks ?? 1)));
  const estimatedRemainingMilliseconds = (averageTaskMilliseconds * remainingTaskCount) / parallelTasks;
  return Math.max(estimatedRemainingMilliseconds - currentTaskMilliseconds, 0);
}

function validDurationMilliseconds(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
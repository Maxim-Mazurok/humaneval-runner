import type { BenchRun, ChartPassGroup, PassTabGroup, PassVariabilityStats, TaskRow } from "./benchmark";
import { formatMs, normalizePassCount, runPassCount, runTotal } from "./runs";

export function attemptPassNumber(value: { passNumber?: number } | Record<string, unknown> | undefined) {
  const parsed = Number(value?.passNumber ?? 1);
  return normalizePassCount(parsed);
}

export function attemptKey(taskId: string, passNumber = 1, attemptId?: string) {
  return attemptId || `${taskId}::pass-${attemptPassNumber({ passNumber })}`;
}

export function attemptLabel(passNumber: number, passTotal = 1) {
  return passTotal > 1 ? `Pass ${passNumber}` : "Pass";
}

export function passRangeLabel(startPass: number, endPass: number, passTotal = 1) {
  if (passTotal <= 1) return "Pass";
  return startPass === endPass ? `Pass ${startPass}` : `Pass ${startPass} - ${endPass}`;
}

export function passVariabilityStats(run?: BenchRun | null): PassVariabilityStats {
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
  const tasksPerPass = Math.max(1, Math.ceil(runTotal(run) / passTotal));
  const spreadRows = completedRows.filter((row) => row.completed >= tasksPerPass);
  const scores = spreadRows.map((row) => row.score);
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
    spreadPassCount: spreadRows.length,
    taskCounts: {
      total: taskRows.size,
      allPass,
      mixed,
      allFail
    }
  };
}

export function groupSequentialPasses(
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

export function groupSequentialChartPasses(
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

export function groupedGenerationLabel(attempts: TaskRow[]) {
  const durations = attempts
    .map((attempt) => attempt.result?.generationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (!durations.length) return "n/a";
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  if (min === max) return formatMs(min);
  return `${formatMs(min)} - ${formatMs(max)}`;
}

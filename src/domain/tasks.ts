import type { BenchRun, EventEnvelope, TaskGroup, TaskPromptInfo, TaskRow, TokenEvent } from "./benchmark";
import { attemptKey, attemptPassNumber } from "./passes";
import { formatPromptMessages } from "./prompts";
import { resultStatus, runPassCount } from "./runs";

export function tokensByAttempt(tokens: TokenEvent[]) {
  const grouped = new Map<string, TokenEvent[]>();
  for (const token of tokens) {
    const key = attemptKey(token.taskId, attemptPassNumber(token), token.attemptId);
    grouped.set(key, [...(grouped.get(key) || []), token]);
  }
  return grouped;
}

export function promptInfoByAttempt(events: EventEnvelope[], selectedRun: BenchRun | null) {
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
}

export function taskGroupsFromRun(
  events: EventEnvelope[],
  selectedRun: BenchRun | null,
  groupedTokens: Map<string, TokenEvent[]>,
  groupedPromptInfo: Map<string, TaskPromptInfo>
): TaskGroup[] {
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
    const completedAttempts = (selectedRun?.results ?? [])
      .filter((result) => result.taskId === taskId)
      .length;
    const inferredPass = completedAttempts + 1;
    const passNumber = Math.min(runPassCount(selectedRun), Math.max(1, inferredPass));
    const key = attemptKey(taskId, passNumber);
    if (rows.has(key)) continue;
    const tokenIndex = groupedTokens.get(key)?.find((token) => Number.isFinite(token.index))?.index;
    const parsedIndex = Number(taskId.match(/HumanEval\/(\d+)$/)?.[1]);
    const fallbackIndex = Number.isFinite(parsedIndex) ? parsedIndex : Number.MAX_SAFE_INTEGER;
    const promptInfo = groupedPromptInfo.get(key);
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
      status: resultStatus(result),
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
}

export function orderedChannelOutput(taskTokens: TokenEvent[] = []) {
  const grouped = new Map<string, string>();
  for (const token of taskTokens) {
    grouped.set(token.channel, `${grouped.get(token.channel) || ""}${token.text}`);
  }
  const channelOrder = ["thinking", "output", "refusal"];
  return [...grouped.entries()].sort(([left], [right]) => {
    const leftIndex = channelOrder.indexOf(left);
    const rightIndex = channelOrder.indexOf(right);
    return (leftIndex === -1 ? channelOrder.length : leftIndex) - (rightIndex === -1 ? channelOrder.length : rightIndex);
  });
}

import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { BenchRun, TaskGroup, TaskPromptInfo, TokenEvent } from "../domain/benchmark";
import {
  analyzeThinkingComments,
  commentSignalIsFlagged,
  formatCommentSignal
} from "../domain/comments";
import {
  groupedTaskDurationLabel,
  groupSequentialPasses,
  passRangeLabel
} from "../domain/passes";
import { buildInstructionPromptFallback } from "../domain/prompts";
import { recordTaskResultsRenderMeasurement, textByteLength } from "../domain/performanceMetrics";
import { formatAssert, pct, runPassCount } from "../domain/runs";
import { orderedChannelOutput } from "../domain/tasks";

export function TaskResults({
  taskGroups,
  selectedRun,
  tokensByAttempt,
  promptInfoByAttempt,
  expanded,
  selectedPassByTask,
  commentSignalThreshold,
  setExpanded,
  setSelectedPassByTask
}: {
  taskGroups: TaskGroup[];
  selectedRun: BenchRun | null;
  tokensByAttempt: Map<string, TokenEvent[]>;
  promptInfoByAttempt: Map<string, TaskPromptInfo>;
  expanded: Record<string, boolean>;
  selectedPassByTask: Record<string, number>;
  commentSignalThreshold: number;
  setExpanded: (updater: (previous: Record<string, boolean>) => Record<string, boolean>) => void;
  setSelectedPassByTask: (updater: (previous: Record<string, number>) => Record<string, number>) => void;
}) {
  const performanceMetricsEnabled = typeof window !== "undefined" && Boolean(window.humanEvalPerformanceMetrics);
  let detailPanelCount = 0;
  let visiblePreTextBytes = 0;
  let attemptViewBuildDurationMilliseconds = 0;
  return (
    <section className="results-panel">
      <div className="pane-head">Tasks</div>
      {taskGroups.length ? taskGroups.map((group) => {
        const runningAttempt = group.attempts.find((attempt) => attempt.status === "running");
        const passTotal = Math.max(runPassCount(selectedRun), ...group.attempts.map((attempt) => attempt.passTotal || 1));
        const attemptViewBuildStartedAt = performanceMetricsEnabled ? performance.now() : 0;
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
        if (performanceMetricsEnabled) attemptViewBuildDurationMilliseconds += performance.now() - attemptViewBuildStartedAt;
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
            : group.attempts.some((attempt) => attempt.status === "fail")
              ? "fail"
              : "error";
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
        if (performanceMetricsEnabled && isOpen) {
          detailPanelCount += 1;
          visiblePreTextBytes += textByteLength(instructionPrompt || "Prompt pending.");
          visiblePreTextBytes += textByteLength(originalPrompt || "Task prompt pending.");
          visiblePreTextBytes += textByteLength(testPrompt || "Tests pending.");
          visiblePreTextBytes += liveOutput.reduce((totalBytes, [channel, text]) => totalBytes + textByteLength(`${channel}\n\n${text}`), 0);
          if (result?.modelError) visiblePreTextBytes += textByteLength(result.modelError);
          if (result?.tests.length) {
            visiblePreTextBytes += result.tests.reduce((totalBytes, test) => totalBytes + textByteLength(formatAssert(test)), 0);
          }
          if (thinkingInComments) visiblePreTextBytes += textByteLength(formatCommentSignal(commentSignal, commentSignalThreshold));
          if (result?.thinkingOutput) visiblePreTextBytes += textByteLength(result.thinkingOutput);
          if (result?.rawOutput) visiblePreTextBytes += textByteLength(result.rawOutput);
          if (result?.extractedCode) visiblePreTextBytes += textByteLength(result.extractedCode);
          if (result?.traceback || result?.error || result?.harnessStderr) {
            visiblePreTextBytes += textByteLength(result.traceback || result.error || result.harnessStderr || "No harness error.");
          }
        }
        if (performanceMetricsEnabled && group === taskGroups[taskGroups.length - 1]) {
          recordTaskResultsRenderMeasurement({
            runId: selectedRun?.id ?? null,
            taskRowCount: taskGroups.length,
            detailPanelCount,
            visiblePreTextBytes,
            attemptViewBuildDurationMilliseconds
          });
        }
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
                {isRunning ? " · in progress" : result ? ` · ${groupedTaskDurationLabel(activePassGroup.attempts)}` : ""}
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
                              ? `${attemptAssertsPassed}/${attempt.result.tests.length} asserts · ${groupedTaskDurationLabel(tabGroup.attempts)}`
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
                {result ? <details open><summary>Assert ledger</summary>{result.tests.length ? result.tests.map((test, index) => <pre key={index} className={test.passed ? "assert-pass" : "assert-fail"}>{formatAssert(test)}</pre>) : <pre className={row.status === "error" ? "assert-error" : undefined}>No assertions ran.</pre>}</details> : null}
                <details open><summary>Prompt sent to model</summary><pre>{instructionPrompt || "Prompt pending."}</pre></details>
                <details><summary>Original HumanEval task</summary><pre>{originalPrompt || "Task prompt pending."}</pre></details>
                {result ? <details><summary>Thinking</summary><pre>{result.thinkingOutput || "No separate thinking stream captured."}</pre></details> : null}
                {result ? <details><summary>Raw output</summary><pre>{result.rawOutput}</pre></details> : null}
                {result ? <details><summary>Extracted code</summary><pre>{result.extractedCode}</pre></details> : null}
                <details><summary>HumanEval tests</summary><pre>{testPrompt || "Tests pending."}</pre></details>
                {result ? <details open={row.status === "error"}><summary>Traceback / harness</summary><pre className={row.status === "error" ? "harness-error" : undefined}>{result.traceback || result.error || result.modelError || result.harnessStderr || (row.status === "error" ? "Harness failed without recording diagnostic details (legacy result)." : "No harness error.")}</pre></details> : null}
              </div>
            ) : null}
          </article>
        );
      }) : <p className="empty-copy">Tasks will appear as soon as they start.</p>}
    </section>
  );
}

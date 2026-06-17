import { Bell, BellOff, ClipboardCopy } from "lucide-react";
import type { BenchRun } from "../domain/benchmark";
import { assertionStats, completedMetricLines, normalizeCommentSignalThreshold, pct, statusIsInProgress } from "../domain/runs";
import { Metric, MetricLines } from "./Metric";

export function MetricsPanel({
  selectedRun,
  selectedThinkingStats,
  commentSignalThreshold,
  selectedLiveEstimate,
  selectedSpeedStats,
  selectedRunNotificationsEnabled,
  setCommentSignalThreshold,
  onCopyNumbers,
  onCopyThinkingNumbers,
  onToggleNotifications
}: {
  selectedRun: BenchRun | null;
  selectedThinkingStats: { flagged: number; total: number };
  commentSignalThreshold: number;
  selectedLiveEstimate: { remaining: string; endTime: string } | null;
  selectedSpeedStats: { averageTask: string; bench: string };
  selectedRunNotificationsEnabled: boolean;
  setCommentSignalThreshold: (value: number) => void;
  onCopyNumbers: (passed: boolean) => void;
  onCopyThinkingNumbers: (flagged: boolean) => void;
  onToggleNotifications: (run: BenchRun) => void;
}) {
  return (
    <section className="bench-metrics">
      <Metric label="Completed" value={<MetricLines lines={completedMetricLines(selectedRun)} />} />
      <Metric label="Passed" value={String(selectedRun?.passed ?? 0)} tone="passed">
        <button className="metric-action" type="button" onClick={() => onCopyNumbers(true)} disabled={!selectedRun?.results.length}>
          <ClipboardCopy size={14} /> Copy passed
        </button>
      </Metric>
      <Metric label="Failed" value={String(selectedRun?.failed ?? 0)} tone="failed">
        <button className="metric-action" type="button" onClick={() => onCopyNumbers(false)} disabled={!selectedRun?.results.length}>
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
          <button className="metric-action" type="button" onClick={() => onCopyThinkingNumbers(true)} disabled={!selectedRun?.results.length}>
            <ClipboardCopy size={14} /> Copy detected
          </button>
          <button className="metric-action" type="button" onClick={() => onCopyThinkingNumbers(false)} disabled={!selectedRun?.results.length}>
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
              onClick={() => onToggleNotifications(selectedRun)}
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
  );
}

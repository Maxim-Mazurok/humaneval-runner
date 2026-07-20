import type { BenchRun } from "../domain/benchmark";
import type { CurrentPassTiming } from "../domain/passTiming";
import { passGroupTimeLabel } from "../domain/passTiming";
import {
  groupSequentialChartPasses,
  passPossibleScoreRange,
  passRangeLabel,
  passVariabilityStats
} from "../domain/passes";
import { pct } from "../domain/runs";

export function PassVariabilityChart({ run, currentPass }: { run: BenchRun | null; currentPass: CurrentPassTiming | null }) {
  const stats = passVariabilityStats(run);
  const chartPassGroups = groupSequentialChartPasses(stats.passRows);
  const scoreSwing = stats.maxScore - stats.minScore;
  const hasSpread = stats.spreadPassCount > 0;
  const spreadLabel = hasSpread
    ? stats.minScore === stats.maxScore
      ? pct(stats.minScore)
      : `${pct(stats.minScore)}-${pct(stats.maxScore)}`
    : "n/a";
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
            <strong>{spreadLabel}</strong>
            <small>{stats.spreadPassCount > 1 ? `${pct(scoreSwing)} swing` : "Needs completed passes"}</small>
          </div>
          <div>
            <span>Mixed tasks</span>
            <strong>{stats.taskCounts.mixed}/{stats.taskCounts.total || 0}</strong>
            <small>At least one pass and one fail</small>
          </div>
          <div>
            <span>Completed passes</span>
            <strong>{stats.completedPassCount}/{stats.passTotal}</strong>
            <small>{hasMultiplePasses ? "Per-pass score below" : "Run with 2+ passes"}</small>
          </div>
        </div>

        {run && hasMultiplePasses ? (
          <div
            className="pass-chart"
            role="img"
            aria-label={hasSpread
              ? `Pass scores range from ${pct(stats.minScore)} to ${pct(stats.maxScore)} across completed passes.`
              : "Pass scores are pending completed passes."
            }
          >
            {chartPassGroups.map((group) => {
              const isCurrentPass = currentPass
                && currentPass.passNumber >= group.startPass
                && currentPass.passNumber <= group.endPass;
              const possibleRange = isCurrentPass && group.row.completed > 0 && !group.row.fullyCompleted
                ? passPossibleScoreRange(group.row, stats.tasksPerPass)
                : null;
              const possibleRangeLabel = possibleRange
                ? `Possible range: ${pct(possibleRange.worst)}-${pct(possibleRange.best)}`
                : undefined;

              return (
                <div className="pass-chart-row" key={group.key}>
                  <span>{passRangeLabel(group.startPass, group.endPass, stats.passTotal)}</span>
                  <div className="pass-bar-track" aria-hidden="true">
                    <i style={{ width: `${group.row.score * 100}%` }} />
                  </div>
                  <b
                    className={possibleRange ? "pass-chart-score-in-progress" : undefined}
                    title={possibleRangeLabel}
                  >
                    {group.row.completed ? pct(group.row.score) : "pending"}
                  </b>
                  <small>{group.row.completed ? `${group.row.passed}/${group.row.completed}` : "0/0"}</small>
                  <small className="pass-chart-time">{passGroupTimeLabel(group, currentPass)}</small>
                </div>
              );
            })}
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

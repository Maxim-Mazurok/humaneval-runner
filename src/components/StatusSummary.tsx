import type { BenchRun } from "../domain/benchmark";
import { pct, runTotal } from "../domain/runs";

export function StatusSummary({
  selectedRun,
  selectedScoreRange,
  selectedProgressSegments
}: {
  selectedRun: BenchRun | null;
  selectedScoreRange: { worst: number; best: number };
  selectedProgressSegments: { failed: number; passed: number; remaining: number };
}) {
  return (
    <>
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
    </>
  );
}

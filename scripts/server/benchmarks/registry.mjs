import {
  bbehFullBenchmark,
  bbehFullOfficialBenchmark,
  bbehMiniBenchmark,
  bbehMiniOfficialBenchmark
} from "./bbeh.mjs";
import { humanEvalBenchmark } from "./humaneval.mjs";

export const benchmarks = new Map([
  [humanEvalBenchmark.id, humanEvalBenchmark],
  [bbehMiniBenchmark.id, bbehMiniBenchmark],
  [bbehMiniOfficialBenchmark.id, bbehMiniOfficialBenchmark],
  [bbehFullBenchmark.id, bbehFullBenchmark],
  [bbehFullOfficialBenchmark.id, bbehFullOfficialBenchmark]
]);

export function getBenchmark(benchmarkId) {
  const id = String(benchmarkId || "humaneval");
  const benchmark = benchmarks.get(id);
  if (!benchmark) {
    throw new Error(`Unknown benchmark "${id}". Available: ${[...benchmarks.keys()].join(", ")}.`);
  }
  return benchmark;
}

export function benchmarkSummaries() {
  return [...benchmarks.values()].map((benchmark) => ({
    id: benchmark.id,
    label: benchmark.label,
    kind: benchmark.kind,
    dataRevision: benchmark.dataRevision || null,
    defaultSystemPrompt: benchmark.defaultSystemPrompt,
    defaultPromptTemplate: benchmark.defaultPromptTemplate
  }));
}

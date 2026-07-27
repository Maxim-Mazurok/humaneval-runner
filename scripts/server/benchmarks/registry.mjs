import { bbehFullBenchmark, bbehMiniBenchmark } from "./bbeh.mjs";
import { humanEvalBenchmark } from "./humaneval.mjs";

export const benchmarks = new Map([
  [humanEvalBenchmark.id, humanEvalBenchmark],
  [bbehMiniBenchmark.id, bbehMiniBenchmark],
  [bbehFullBenchmark.id, bbehFullBenchmark]
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
    defaultSystemPrompt: benchmark.defaultSystemPrompt,
    defaultPromptTemplate: benchmark.defaultPromptTemplate
  }));
}

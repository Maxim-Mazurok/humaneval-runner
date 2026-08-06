import {
  bbehFullBenchmark,
  bbehFullOfficialBenchmark,
  bbehMiniBenchmark,
  bbehMiniOfficialBenchmark
} from "./bbeh.mjs";
import { humanEvalBenchmark } from "./humaneval.mjs";
import { loadBenchmarkPacks } from "./packs.mjs";

const builtInBenchmarks = [
  humanEvalBenchmark,
  bbehMiniBenchmark,
  bbehMiniOfficialBenchmark,
  bbehFullBenchmark,
  bbehFullOfficialBenchmark
];

// Top-level await keeps `getBenchmark` synchronous for every caller: importing
// this module resolves the optional packs before anything can ask for a
// benchmark.
export const benchmarkPacks = await loadBenchmarkPacks();

export const benchmarks = new Map(builtInBenchmarks.map((benchmark) => [benchmark.id, benchmark]));

for (const pack of benchmarkPacks) {
  for (const benchmark of pack.benchmarks) {
    if (benchmarks.has(benchmark.id)) {
      throw new Error(`Benchmark pack "${pack.name}" redefines benchmark id "${benchmark.id}".`);
    }
    benchmarks.set(benchmark.id, benchmark);
  }
}

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
    scoring: benchmark.scoring || "binary",
    dataRevision: benchmark.dataRevision || null,
    defaultSystemPrompt: benchmark.defaultSystemPrompt,
    defaultPromptTemplate: benchmark.defaultPromptTemplate
  }));
}

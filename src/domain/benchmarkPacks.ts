import type { BenchmarkOption } from "./benchmark";

// Frontend half of the optional benchmark packs installed under packs/ (see
// scripts/server/benchmarks/packs.mjs for the server half). A pack's
// pack.client.ts exports a `benchmarkOptions` array; with no packs installed
// the glob is empty and the workbench offers the built-in benchmarks alone.
const packModules = import.meta.glob<{ benchmarkOptions?: unknown }>("/packs/*/pack.client.ts", {
  eager: true
});

function packOptions(path: string, exported: unknown): BenchmarkOption[] {
  if (!Array.isArray(exported)) {
    throw new Error(`Benchmark pack "${path}" must export a \`benchmarkOptions\` array.`);
  }
  return exported as BenchmarkOption[];
}

export const packBenchmarkOptions: BenchmarkOption[] = Object.keys(packModules)
  .sort()
  .flatMap((path) => packOptions(path, packModules[path].benchmarkOptions));

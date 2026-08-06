// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkPacks } from "./packs.mjs";

let cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => {})));
  cleanups = [];
});

async function makePacksDir() {
  const packsDir = await fs.mkdtemp(join(tmpdir(), "benchmark-packs-"));
  cleanups.push(() => fs.rm(packsDir, { recursive: true, force: true }));
  return packsDir;
}

const stubBenchmark = `{
  id: "stub",
  label: "Stub",
  kind: "qa",
  loadProblems: () => [],
  problemSummary: () => ({}),
  problemReference: () => "",
  extractArtifact: (output) => output,
  evaluate: () => ({ passed: true, tests: [] })
}`;

describe("loadBenchmarkPacks", () => {
  it("returns nothing when the packs directory is absent or empty", async () => {
    expect(await loadBenchmarkPacks(join(tmpdir(), "no-such-packs-dir"))).toEqual([]);
    expect(await loadBenchmarkPacks(await makePacksDir())).toEqual([]);
  });

  it("skips a pack directory without an entry point, so an uninitialised submodule is not an error", async () => {
    const packsDir = await makePacksDir();
    await fs.mkdir(join(packsDir, "not-checked-out"));
    expect(await loadBenchmarkPacks(packsDir)).toEqual([]);
  });

  it("imports each pack's benchmarks in directory order", async () => {
    const packsDir = await makePacksDir();
    for (const name of ["zebra", "alpha"]) {
      await fs.mkdir(join(packsDir, name));
      await fs.writeFile(
        join(packsDir, name, "pack.server.mjs"),
        `export const label = "${name} pack";\n`
          + `export const benchmarks = [{ ...${stubBenchmark}, id: "${name}-stub" }];\n`
      );
    }
    const packs = await loadBenchmarkPacks(packsDir);
    expect(packs.map((pack) => pack.name)).toEqual(["alpha", "zebra"]);
    expect(packs.map((pack) => pack.label)).toEqual(["alpha pack", "zebra pack"]);
    expect(packs.flatMap((pack) => pack.benchmarks.map((benchmark) => benchmark.id)))
      .toEqual(["alpha-stub", "zebra-stub"]);
  });

  it("rejects a pack that exports no benchmarks array or an incomplete benchmark", async () => {
    const missingArray = await makePacksDir();
    await fs.mkdir(join(missingArray, "broken"));
    await fs.writeFile(join(missingArray, "broken", "pack.server.mjs"), "export const label = 'broken';\n");
    await expect(loadBenchmarkPacks(missingArray)).rejects.toThrow(/must export a `benchmarks` array/);

    const incomplete = await makePacksDir();
    await fs.mkdir(join(incomplete, "partial"));
    await fs.writeFile(
      join(incomplete, "partial", "pack.server.mjs"),
      'export const benchmarks = [{ id: "partial", loadProblems: () => [] }];\n'
    );
    await expect(loadBenchmarkPacks(incomplete)).rejects.toThrow(/is missing problemSummary\(\)/);
  });
});

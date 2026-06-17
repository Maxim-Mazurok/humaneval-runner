import { promises as fs } from "node:fs";
import { join } from "node:path";
import { persistedRunState, runDirName } from "./domain.mjs";

export function ensureRunDir(run, runsDir) {
  if (!run.dir) run.dir = join(runsDir, runDirName(run));
  return run.dir;
}

export async function writeRunArtifacts(run, runsDir) {
  if (run.deleted) return;
  ensureRunDir(run, runsDir);
  await fs.mkdir(run.dir, { recursive: true });
  await Promise.all([
    fs.writeFile(join(run.dir, "run.json"), JSON.stringify(persistedRunState(run), null, 2)),
    fs.writeFile(join(run.dir, "results.json"), JSON.stringify(run.results, null, 2))
  ]);
}

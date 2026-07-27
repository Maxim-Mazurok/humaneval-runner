import { promises as fs } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { defaultPromptTemplate, defaultSystemPrompt, extractCodeFromOutput } from "../domain.mjs";
import { executeTests } from "../testHarness.mjs";

const humanEvalUrl = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz";

async function loadProblems({ cacheDir, fetchImplementation = fetch }) {
  const humanEvalPath = join(cacheDir, "HumanEval.jsonl");
  try {
    await fs.access(humanEvalPath);
  } catch {
    await fs.mkdir(cacheDir, { recursive: true });
    const response = await fetchImplementation(humanEvalUrl);
    if (!response.ok) {
      throw new Error(`Failed to download HumanEval data: HTTP ${response.status}`);
    }
    const compressed = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(humanEvalPath, gunzipSync(compressed));
  }

  const raw = await fs.readFile(humanEvalPath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export const humanEvalBenchmark = {
  id: "humaneval",
  label: "HumanEval",
  kind: "code",
  taskIdPattern: /HumanEval\/(\d+)$/i,
  defaultSystemPrompt,
  defaultPromptTemplate,
  loadProblems,
  problemSummary(problem) {
    return { taskId: problem.task_id, entryPoint: problem.entry_point };
  },
  // The reference material shown alongside a task in the UI (test code here).
  problemReference(problem) {
    return problem.test;
  },
  extractArtifact(output, problem) {
    return extractCodeFromOutput(output, problem.prompt);
  },
  async evaluate({ problem, artifact, timeoutSeconds }) {
    return await executeTests(problem, artifact, timeoutSeconds);
  }
};

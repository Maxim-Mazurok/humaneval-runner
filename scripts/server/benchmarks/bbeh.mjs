import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { evaluateCorrectness, preprocessReference, preprocessSample } from "./bbehEvaluate.mjs";

const bbehRawBase = "https://raw.githubusercontent.com/google-deepmind/bbeh/main/bbeh";

// The 23 benchmark task directories in the official repository.
export const bbehTaskNames = [
  "bbeh_boardgame_qa",
  "bbeh_boolean_expressions",
  "bbeh_buggy_tables",
  "bbeh_causal_understanding",
  "bbeh_disambiguation_qa",
  "bbeh_dyck_languages",
  "bbeh_geometric_shapes",
  "bbeh_hyperbaton",
  "bbeh_linguini",
  "bbeh_movie_recommendation",
  "bbeh_multistep_arithmetic",
  "bbeh_nycc",
  "bbeh_object_counting",
  "bbeh_object_properties",
  "bbeh_sarc_triples",
  "bbeh_shuffled_objects",
  "bbeh_spatial_reasoning",
  "bbeh_sportqa",
  "bbeh_temporal_sequence",
  "bbeh_time_arithmetic",
  "bbeh_web_of_lies",
  "bbeh_word_sorting",
  "bbeh_zebra_puzzles"
];

export const bbehDefaultSystemPrompt = [
  "You are solving a hard reasoning problem.",
  "Think through the problem step by step before answering.",
  "Keep your reasoning concise and end with your final answer."
].join("\n");

export const bbehDefaultPromptTemplate = [
  "%problem%",
  "",
  "When you are done, finish your response with a final line formatted exactly as:",
  "The answer is: <answer>"
].join("\n");

async function downloadWithRetry(url, fetchImplementation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(url);
      if (!response.ok) {
        throw new Error(`Failed to download BBEH data from ${url}: HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

async function downloadToCache(cachePath, url, fetchImplementation) {
  await fs.mkdir(dirname(cachePath), { recursive: true });
  const body = await downloadWithRetry(url, fetchImplementation);
  const parsed = JSON.parse(body);
  // Write via a temp file and rename so an interrupted write can never leave
  // a truncated cache file behind.
  const temporaryPath = `${cachePath}.download-${process.pid}`;
  await fs.writeFile(temporaryPath, body);
  await fs.rename(temporaryPath, cachePath);
  return parsed;
}

async function fetchJsonCached(cachePath, url, fetchImplementation) {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch {
    // Missing or corrupted cache (for example a truncated earlier download):
    // refetch and replace it.
    return await downloadToCache(cachePath, url, fetchImplementation);
  }
}

function toProblem(example, taskId, subtask) {
  return {
    task_id: taskId,
    prompt: example.input,
    target: String(example.target),
    subtask
  };
}

async function loadFullProblems({ cacheDir, fetchImplementation = fetch }) {
  const bbehCacheDir = join(cacheDir, "bbeh");
  await fs.mkdir(bbehCacheDir, { recursive: true });
  const problems = [];
  for (const taskName of bbehTaskNames) {
    const data = await fetchJsonCached(
      join(bbehCacheDir, `${taskName}.json`),
      `${bbehRawBase}/benchmark_tasks/${taskName}/task.json`,
      fetchImplementation
    );
    const subtask = taskName.replace(/^bbeh_/, "");
    for (const [exampleIndex, example] of data.examples.entries()) {
      problems.push(toProblem(example, `${taskName}/${exampleIndex}`, subtask));
    }
  }
  return problems;
}

async function loadMiniProblems({ cacheDir, fetchImplementation = fetch }) {
  const bbehCacheDir = join(cacheDir, "bbeh");
  await fs.mkdir(bbehCacheDir, { recursive: true });
  const data = await fetchJsonCached(
    join(bbehCacheDir, "mini.json"),
    `${bbehRawBase}/mini/data.json`,
    fetchImplementation
  );
  // The published mini data has no reliable per-example subtask labels (one
  // stray "subtask" key exists in 460 examples), so label all examples "mini".
  return data.examples.map((example, exampleIndex) => (
    toProblem(example, `bbeh_mini/${exampleIndex}`, "mini")
  ));
}

function createBbehBenchmark(id, label, loadProblems) {
  return {
    id,
    label,
    kind: "qa",
    taskIdPattern: null,
    defaultSystemPrompt: bbehDefaultSystemPrompt,
    defaultPromptTemplate: bbehDefaultPromptTemplate,
    loadProblems,
    problemSummary(problem) {
      return { taskId: problem.task_id, subtask: problem.subtask };
    },
    problemReference(problem) {
      return `Expected answer: ${problem.target}`;
    },
    extractArtifact(output) {
      return preprocessSample(String(output || ""));
    },
    async evaluate({ problem, rawOutput }) {
      const prediction = preprocessSample(String(rawOutput || ""));
      const expected = preprocessReference(problem.target);
      const passed = evaluateCorrectness(String(rawOutput || ""), problem.target);
      return {
        passed,
        tests: [{
          source: "final answer matches target (official BBEH fuzzy match)",
          passed,
          actual: prediction,
          expected,
          operator: "fuzzy=="
        }],
        expectedAnswer: problem.target,
        prediction
      };
    }
  };
}

export const bbehFullBenchmark = createBbehBenchmark("bbeh-full", "BBEH (full)", loadFullProblems);
export const bbehMiniBenchmark = createBbehBenchmark("bbeh-mini", "BBEH Mini", loadMiniProblems);

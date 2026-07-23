export const BENCH_API = "http://localhost:8787";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "humaneval.sidebar.collapsed";

export const DEFAULT_SYSTEM_PROMPT = `You are completing a Python programming task.

Implement the requested function exactly as described by the prompt. Prioritize functional correctness above all else. Performance is secondary unless the prompt gives explicit limits.

Use straightforward, readable Python and avoid clever syntax or unnecessary abstractions. Use only the Python standard library. Preserve the required function names, signatures, and return types.

Return only the requested code. Do not include explanations.
`;

export const DEFAULT_PROMPT_TEMPLATE = `Goal:
- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.
- Return Python code that can be executed by a test harness.

Response format:
- Output one markdown multiline code block with python syntax.
- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).
- Preserve the function name(s), arguments, and return behavior implied by the prompt.

Task prompt:
\`\`\`python
%problem_code%
\`\`\`
`;

export const DEFAULT_FORM_VALUES = {
  baseUrl: "http://localhost:8000/v1",
  apiKey: "",
  model: "",
  maxTokens: 2048,
  timeoutSeconds: 15,
  parallelTasks: 1,
  passCount: 1,
  commentSignalThreshold: 50,
  sampleLimit: 0,
  startIndex: 0,
  testNumbers: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraBody: "{\n  \"top_p\": 1\n}"
};

export type BenchResult = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index: number;
  entryPoint: string;
  passed: boolean;
  tests: Array<{
    source: string;
    passed: boolean;
    error?: string;
    traceback?: string;
    actual?: string;
    expected?: string;
    operator?: string;
  }>;
  instructionPrompt?: string;
  prompt: string;
  test: string;
  rawOutput: string;
  thinkingOutput?: string;
  rawTranscript?: string;
  rawSse?: string;
  extractedCode: string;
  error?: string | null;
  traceback?: string | null;
  modelError?: string;
  generationMs?: number;
  activeDurationMilliseconds?: number;
  evaluationDurationMilliseconds?: number;
  harnessStdout?: string;
  harnessStderr?: string;
  usage?: Record<string, unknown> | null;
};

export type BenchRun = {
  id: string;
  status: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  liveScore: number;
  finalScore?: number | null;
  assertionsPassed: number;
  assertionsTotal: number;
  assertionScore: number;
  currentTaskId: string | null;
  logDir?: string;
  selectedIndices?: number[];
  config?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    systemPrompt?: string;
    promptTemplate?: string;
    testNumbers?: string;
    maxTokens?: number;
    timeoutSeconds?: number;
    parallelTasks?: number;
    passCount?: number;
    sampleLimit?: number;
    startIndex?: number;
    extraBody?: Record<string, unknown>;
  };
  activeTaskIds?: string[];
  results: BenchResult[];
};

export type TokenEvent = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index?: number;
  channel: string;
  text: string;
};

export type EventEnvelope = {
  id?: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

export type StartedTask = {
  taskId: string;
  attemptId?: string;
  passNumber: number;
  passTotal: number;
  passOrdinal?: number;
  index: number;
  entryPoint: string;
  prompt?: string;
  test?: string;
};

export type TaskRow = StartedTask & {
  key: string;
  status: "running" | "pass" | "fail" | "error";
  result?: BenchResult;
};

export type TaskGroup = {
  taskId: string;
  index: number;
  entryPoint: string;
  attempts: TaskRow[];
};

export type PassTabGroup = {
  key: string;
  startPass: number;
  endPass: number;
  status: TaskRow["status"];
  attempts: TaskRow[];
  representative: TaskRow;
};

export type ChartPassGroup = {
  key: string;
  startPass: number;
  endPass: number;
  row: PassVariabilityStats["passRows"][number];
  rows: PassVariabilityStats["passRows"];
  averagePassDurationMilliseconds: number | null;
  completedPassCount: number;
};

export type TaskPromptInfo = {
  prompt?: string;
  instructionPrompt?: string;
  test?: string;
};

export type CommentLineStats = {
  commentLines: number;
  codeLines: number;
  blankLines: number;
  leadingCommentLines: number;
};

export type ThinkingCommentSignal = {
  commentLines: number;
  codeLines: number;
  originalCommentLines: number;
  generatedCommentLines: number;
  generatedCodeLines: number;
  addedCommentLines: number;
  leadingCommentLines: number;
  commentRatio: number;
};

export type PassVariabilityStats = {
  passRows: Array<{
    passNumber: number;
    completed: number;
    passed: number;
    failed: number;
    score: number;
    passDurationMilliseconds: number | null;
    fullyCompleted: boolean;
  }>;
  passTotal: number;
  tasksPerPass: number;
  completedPassCount: number;
  minScore: number;
  maxScore: number;
  spreadPassCount: number;
  taskCounts: {
    total: number;
    allPass: number;
    mixed: number;
    allFail: number;
  };
};

export type BenchRoute = {
  view: "new";
} | {
  view: "run";
  id: string;
};

export function parseBenchRoute(pathname: string): BenchRoute {
  const runMatch = pathname.match(/^\/run\/([^/]+)\/?$/);
  if (runMatch) return { view: "run", id: decodeURIComponent(runMatch[1]) };
  return { view: "new" };
}

export function readBenchRoute(): BenchRoute {
  if (typeof window === "undefined") return { view: "new" };
  return parseBenchRoute(window.location.pathname);
}

export function routePath(route: BenchRoute) {
  return route.view === "run" ? `/run/${encodeURIComponent(route.id)}` : "/new";
}

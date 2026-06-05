import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ClipboardCopy,
  Code2,
  FileText,
  KeyRound,
  Play,
  Server,
  Settings2,
  TerminalSquare
} from "lucide-react";

const BENCH_API = "http://localhost:8787";
const DEFAULT_SYSTEM_PROMPT = `You are completing a Python programming task.

Prioritize functional correctness above all else. Performance is secondary unless the prompt gives explicit limits. Use straightforward, readable Python and avoid clever syntax or unnecessary abstractions.

Before writing the final code:
1. Restate the key requirements and assumptions from the prompt.
2. Identify edge cases, especially boundary values, empty/small inputs, exact equality cases, duplicates, negative values, and cases mentioned indirectly by the constraints.
3. Choose an approach whose correctness follows directly from the requirements.
4. Mentally test the approach on the examples and at least several edge cases.
5. Check that all invariants required by the algorithm are preserved, especially after special cases like zero, equality, or empty input.

When implementing:
- Use only allowed libraries.
- Preserve the required function names, signatures, and return types.
- Prefer explicit conditionals over compact but fragile expressions.
- Handle exact special cases directly before entering iterative or recursive logic.
- Avoid relying on accidental behavior.

Return only the requested code. Do not include explanations.
`;
const DEFAULT_PROMPT_TEMPLATE = `Goal:
- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.
- Return Python code that can be executed by a test harness.

Response format:
- Output only Python code, wrapped in markdown multiline codeblock with python syntax: function implementation, no tests, no thoughts, no summaries.
- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).
- Preserve the function name(s), arguments, and return behavior implied by the prompt.

Task prompt:
\`\`\`python
%problem_code%
\`\`\`
`;

type BenchResult = {
  taskId: string;
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
  harnessStdout?: string;
  harnessStderr?: string;
  usage?: Record<string, unknown> | null;
};

type BenchRun = {
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
    systemPrompt?: string;
    promptTemplate?: string;
    testNumbers?: string;
    maxTokens?: number;
    timeoutSeconds?: number;
    sampleLimit?: number;
    startIndex?: number;
    extraBody?: Record<string, unknown>;
  };
  results: BenchResult[];
};

type TokenEvent = {
  taskId: string;
  index?: number;
  channel: string;
  text: string;
};

type EventEnvelope = {
  id?: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

function pct(value?: number | null) {
  return `${Math.round((value || 0) * 1000) / 10}%`;
}

function formatMs(value?: number) {
  if (!value) return "n/a";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatTime(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function assertionStats(results: BenchResult[] = []) {
  const total = results.reduce((sum, result) => sum + result.tests.length, 0);
  const passed = results.reduce((sum, result) => sum + result.tests.filter((test) => test.passed).length, 0);
  return { passed, total, score: total ? passed / total : 0 };
}

function formatAssert(test: BenchResult["tests"][number]) {
  const lines = [`${test.passed ? "PASS" : "FAIL"} ${test.source}`];
  if (!test.passed && (test.expected !== undefined || test.actual !== undefined)) {
    lines.push(`expected: ${test.expected ?? "n/a"}`);
    lines.push(`actual:   ${test.actual ?? "n/a"}`);
    if (test.operator) lines.push(`operator: ${test.operator}`);
  }
  if (!test.passed && test.error) lines.push(`error: ${test.error}`);
  return lines.join("\n");
}

function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra request body must be a JSON object.");
  }
  return parsed;
}

function statusIsLive(status?: string) {
  return status === "running" || status === "queued";
}

function resultNumbers(run: BenchRun | null, passed: boolean) {
  return (run?.results ?? [])
    .filter((result) => result.passed === passed)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}

function mergeRun(previous: BenchRun | undefined, next: BenchRun) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    results: next.results.length ? next.results : previous.results
  };
}

function mergeRunList(previous: BenchRun[], nextRuns: BenchRun[]) {
  return nextRuns.map((next) => mergeRun(previous.find((run) => run.id === next.id), next));
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [maxTokens, setMaxTokens] = useState(2048);
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [sampleLimit, setSampleLimit] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  const [testNumbers, setTestNumbers] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
  const [extraBody, setExtraBody] = useState("{\n  \"top_p\": 1\n}");
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenEvent[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sourcesRef = useRef<Map<string, EventSource>>(new Map());
  const selectedRunIdRef = useRef<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((candidate) => candidate.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  const currentOutput = useMemo(() => {
    const grouped = new Map<string, string>();
    for (const token of tokens) {
      grouped.set(token.channel, `${grouped.get(token.channel) || ""}${token.text}`);
    }
    const channelOrder = ["thinking", "output", "refusal"];
    return [...grouped.entries()].sort(([left], [right]) => {
      const leftIndex = channelOrder.indexOf(left);
      const rightIndex = channelOrder.indexOf(right);
      const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.localeCompare(right);
    });
  }, [tokens]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  async function loadRuns(selectLatest = false) {
    const response = await fetch(`${BENCH_API}/api/humaneval/runs`);
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed to load runs");
    const nextRuns = json.runs as BenchRun[];
    setRuns((previous) => mergeRunList(previous, nextRuns));
    if (selectLatest || !selectedRunId || !nextRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(nextRuns[0]?.id ?? null);
    }
    for (const run of nextRuns.filter((candidate) => statusIsLive(candidate.status))) {
      connectEvents(run.id);
    }
  }

  useEffect(() => {
    loadRuns(true).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => {
      for (const source of sourcesRef.current.values()) source.close();
      sourcesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setTokens([]);
      setEvents([]);
      return;
    }
    fetch(`${BENCH_API}/api/humaneval/runs/${selectedRunId}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Failed to load run");
        setRuns((previous) => [mergeRun(previous.find((run) => run.id === json.id), json), ...previous.filter((run) => run.id !== json.id)]);
        if (statusIsLive(json.status)) connectEvents(json.id);
        const tokenEvents = (json.events as EventEnvelope[] | undefined)?.filter((event) => event.type === "token") ?? [];
        setEvents((json.events as EventEnvelope[] | undefined)?.slice(-400) ?? []);
        setTokens(tokenEvents.map((event) => event.data as unknown as TokenEvent).slice(-6000));
      })
      .catch((runError) => setError(runError instanceof Error ? runError.message : String(runError)));
  }, [selectedRunId]);

  async function startRun() {
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/humaneval/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          model,
          maxTokens,
          timeoutSeconds,
          sampleLimit,
          startIndex,
          testNumbers,
          systemPrompt,
          promptTemplate,
          temperature: 0,
          extraBody: parseJsonObject(extraBody)
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to start run");
        setRuns((previous) => [mergeRun(previous.find((run) => run.id === json.id), json), ...previous.filter((run) => run.id !== json.id)]);
      setSelectedRunId(json.id);
      setTokens([]);
      setEvents([]);
      connectEvents(json.id);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  }

  function connectEvents(runId: string) {
    if (sourcesRef.current.has(runId)) return;
    const source = new EventSource(`${BENCH_API}/api/humaneval/runs/${runId}/events`);
    sourcesRef.current.set(runId, source);
    const handle = (message: MessageEvent) => {
      const event = JSON.parse(message.data) as EventEnvelope;
      const maybeSummary = event.data.summary as BenchRun | undefined;
      if (maybeSummary) {
        setRuns((previous) => [mergeRun(previous.find((run) => run.id === maybeSummary.id), maybeSummary), ...previous.filter((run) => run.id !== maybeSummary.id)]);
      }
      const currentSelectedRunId = selectedRunIdRef.current;
      if (runId === currentSelectedRunId || (!currentSelectedRunId && maybeSummary?.id === runId)) {
        setEvents((prev) => [...prev.slice(-400), event]);
        if (event.type === "task-started") setTokens([]);
        if (event.type === "token") {
          const data = event.data as unknown as TokenEvent;
          setTokens((prev) => [...prev.slice(-6000), data]);
        }
        if (event.type === "task-finished") {
          fetch(`${BENCH_API}/api/humaneval/runs/${runId}`)
            .then(async (response) => {
              const json = await response.json();
              if (response.ok) {
                setRuns((previous) => [mergeRun(previous.find((run) => run.id === json.id), json), ...previous.filter((run) => run.id !== json.id)]);
              }
            })
            .catch(() => undefined);
        }
      }
      if (event.type === "done" || event.type === "error") {
        source.close();
        sourcesRef.current.delete(runId);
        loadRuns().catch(() => undefined);
      }
    };
    for (const name of ["run-started", "task-started", "prompt", "token", "raw-delta", "code-extracted", "task-finished", "done", "error"]) {
      source.addEventListener(name, handle);
    }
    source.onerror = () => {
      source.close();
      sourcesRef.current.delete(runId);
    };
  }

  async function cancelRun() {
    if (!selectedRun || !statusIsLive(selectedRun.status)) return;
    await fetch(`${BENCH_API}/api/humaneval/runs/${selectedRun.id}/cancel`, { method: "POST" });
    await loadRuns();
  }

  async function copyNumbers(passed: boolean) {
    const text = resultNumbers(selectedRun, passed);
    await navigator.clipboard.writeText(text);
  }

  return (
    <main className="bench-shell">
      <aside className="bench-sidebar">
        <div className="bench-title">
          <TerminalSquare size={34} />
          <div>
            <p>HumanEval</p>
            <h1>Code benchmark workbench</h1>
          </div>
        </div>
        <label className="field">
          <span><Server size={14} /> Base URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" />
        </label>
        <label className="field">
          <span><KeyRound size={14} /> API key</span>
          <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="optional" />
        </label>
        <label className="field">
          <span>Model</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model-name" />
        </label>
        <div className="bench-number-grid">
          <label className="field">
            <span>Max tokens</span>
            <input value={maxTokens} min={256} step={256} type="number" onChange={(event) => setMaxTokens(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Timeout</span>
            <input value={timeoutSeconds} min={1} type="number" onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Start</span>
            <input value={startIndex} min={0} max={163} type="number" onChange={(event) => setStartIndex(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Limit</span>
            <input value={sampleLimit} min={0} max={164} type="number" onChange={(event) => setSampleLimit(Number(event.target.value))} />
          </label>
        </div>
        <label className="field">
          <span><FileText size={14} /> Test numbers</span>
          <textarea
            value={testNumbers}
            onChange={(event) => setTestNumbers(event.target.value)}
            rows={3}
            placeholder="0, 1, 2 or 10-25. Empty uses start/limit."
          />
        </label>
        <label className="field">
          <span><Settings2 size={14} /> System prompt</span>
          <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} />
        </label>
        <label className="field">
          <span><FileText size={14} /> Prompt template</span>
          <textarea
            value={promptTemplate}
            onChange={(event) => setPromptTemplate(event.target.value)}
            rows={11}
            placeholder="Use %problem_code% where the HumanEval function stub should be inserted."
          />
        </label>
        <label className="field">
          <span><Settings2 size={14} /> Extra request body</span>
          <textarea value={extraBody} onChange={(event) => setExtraBody(event.target.value)} rows={5} />
        </label>
        <div className="bench-warning">
          Executes model-generated Python locally. Use a dedicated sandbox for untrusted endpoints.
        </div>
        <div className="bench-actions">
          <button className="primary-action" type="button" onClick={startRun} disabled={!model.trim()}>
            <Play size={17} /> Start run
          </button>
          <button className="secondary-action" type="button" onClick={cancelRun} disabled={!statusIsLive(selectedRun?.status)}>
            <CircleStop size={17} /> Stop selected
          </button>
        </div>
        {error ? <p className="bench-error">{error}</p> : null}
      </aside>

      <section className="bench-main">
        <section className="run-strip">
          <div className="pane-head">Benchmarks</div>
          <div className="run-list">
            {runs.length ? runs.map((candidate) => (
              <button
                className={candidate.id === selectedRun?.id ? "run-tab active" : "run-tab"}
                key={candidate.id}
                type="button"
                onClick={() => setSelectedRunId(candidate.id)}
              >
                <span className={`status-dot ${statusIsLive(candidate.status) ? "live" : ""}`} />
                <strong>{candidate.model || "model"}</strong>
                <small>{candidate.status} · {candidate.completed}/{candidate.total || candidate.selectedIndices?.length || 164} · {formatTime(candidate.createdAt)}</small>
              </button>
            )) : <p className="empty-copy">No benchmark runs recorded yet.</p>}
          </div>
        </section>

        <header className="bench-status">
          <div>
            <p>{selectedRun ? selectedRun.status : "idle"}</p>
            <h2>{selectedRun ? selectedRun.model : "Ready for an OpenAI-compatible model"}</h2>
          </div>
          <div className="bench-score">
            <strong>{selectedRun ? pct(selectedRun.liveScore) : "0%"}</strong>
            <span>{selectedRun ? `${selectedRun.passed}/${selectedRun.completed || 0} passing live` : "pass@1 live score"}</span>
          </div>
        </header>
        <div className="progress-rail">
          <span style={{ width: `${selectedRun?.total ? (selectedRun.completed / selectedRun.total) * 100 : 0}%` }} />
        </div>
        <section className="bench-metrics">
          <Metric label="Completed" value={selectedRun ? `${selectedRun.completed}/${selectedRun.total || 164}` : "0/164"} />
          <Metric label="Passed" value={String(selectedRun?.passed ?? 0)} />
          <Metric label="Failed" value={String(selectedRun?.failed ?? 0)} />
          <Metric
            label="Assertions"
            value={
              selectedRun
                ? `${selectedRun.assertionsPassed ?? assertionStats(selectedRun.results).passed}/${selectedRun.assertionsTotal ?? assertionStats(selectedRun.results).total} (${pct(selectedRun.assertionScore ?? assertionStats(selectedRun.results).score)})`
                : "0/0 (0%)"
            }
          />
          <Metric label="Current" value={selectedRun?.currentTaskId ?? "n/a"} />
        </section>

        <section className="copy-panel">
          <button className="secondary-action" type="button" onClick={() => copyNumbers(false)} disabled={!selectedRun?.results.length}>
            <ClipboardCopy size={16} /> Copy failed numbers
          </button>
          <button className="secondary-action" type="button" onClick={() => copyNumbers(true)} disabled={!selectedRun?.results.length}>
            <ClipboardCopy size={16} /> Copy passed numbers
          </button>
          <span>{selectedRun?.logDir ? `Logs: ${selectedRun.logDir}` : "Logs are written after a run starts."}</span>
        </section>

        <section className="live-grid">
          <article className="live-stream">
            <div className="pane-head"><Activity size={16} /> Raw stream</div>
            {currentOutput.length ? currentOutput.map(([channel, text]) => (
              <details key={channel} open>
                <summary>{channel}</summary>
                <pre>{text}</pre>
              </details>
            )) : <p className="empty-copy">Streaming tokens will appear here for the selected run.</p>}
          </article>
          <article className="event-log">
            <div className="pane-head"><Code2 size={16} /> Event log</div>
            <div className="event-list">
              {events.slice(-80).reverse().map((event, index) => (
                <div key={`${event.at}-${event.id ?? index}`}>
                  <b>{event.type}</b>
                  <span>{new Date(event.at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="results-panel">
          <div className="pane-head">Task results</div>
          {(selectedRun?.results ?? []).map((result) => {
            const isOpen = expanded[result.taskId] ?? false;
            const assertsPassed = result.tests.filter((test) => test.passed).length;
            const assertScore = result.tests.length ? assertsPassed / result.tests.length : 0;
            return (
              <article className="result-row" key={result.taskId}>
                <button type="button" onClick={() => setExpanded((prev) => ({ ...prev, [result.taskId]: !isOpen }))}>
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className={result.passed ? "pass-pill" : "fail-pill"}>{result.passed ? "pass" : "fail"}</span>
                  <strong>{result.taskId}</strong>
                  <small>#{result.index} · {result.entryPoint} · {formatMs(result.generationMs)} · {assertsPassed}/{result.tests.length} asserts · {pct(assertScore)}</small>
                </button>
                {isOpen ? (
                  <div className="result-detail">
                    {result.modelError ? <pre>{result.modelError}</pre> : null}
                    <details open><summary>Assert ledger</summary>{result.tests.map((test, index) => <pre key={index} className={test.passed ? "assert-pass" : "assert-fail"}>{formatAssert(test)}</pre>)}</details>
                    <details open><summary>Prompt sent to model</summary><pre>{result.instructionPrompt || result.prompt}</pre></details>
                    <details><summary>Original HumanEval task</summary><pre>{result.prompt}</pre></details>
                    <details><summary>Thinking</summary><pre>{result.thinkingOutput || "No separate thinking stream captured."}</pre></details>
                    <details><summary>Raw output</summary><pre>{result.rawOutput}</pre></details>
                    <details><summary>Extracted code</summary><pre>{result.extractedCode}</pre></details>
                    <details><summary>HumanEval tests</summary><pre>{result.test}</pre></details>
                    <details><summary>Traceback / harness</summary><pre>{result.traceback || result.error || result.harnessStderr || "No harness error."}</pre></details>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bench-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

type RunFixture = {
  id: string;
  status: string;
  model: string;
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
  selectedIndices?: number[];
  config?: Record<string, unknown>;
  activeTaskIds?: string[];
  results: Array<Record<string, unknown>>;
};

const baseRun = (overrides: Partial<RunFixture> = {}): RunFixture => ({
  id: "run-1",
  status: "queued",
  model: "demo-model",
  createdAt: "2026-06-16T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  total: 2,
  completed: 0,
  passed: 0,
  failed: 0,
  liveScore: 0,
  finalScore: null,
  assertionsPassed: 0,
  assertionsTotal: 0,
  assertionScore: 0,
  currentTaskId: null,
  activeTaskIds: [],
  results: [],
  ...overrides
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(message: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const message = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) || []) listener(message);
  }
}

function installNotificationMock() {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(async () => "granted" as NotificationPermission);

    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
  }
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  }));
}

describe("App notifications", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    });
    window.localStorage.clear();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FakeEventSource
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("notifies when an enabled run receives a done SSE event", async () => {
    const notificationCalls = installNotificationMock();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs") && init?.method === "POST") {
        return jsonResponse(baseRun({ status: "queued" }), 201);
      }
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse(baseRun({ events: [] } as Partial<RunFixture>));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0].emit("done", {
      type: "done",
      at: "2026-06-16T00:00:03.000Z",
      data: {
        summary: baseRun({
          status: "completed",
          completed: 2,
          passed: 2,
          liveScore: 1,
          finalScore: 1,
          finishedAt: "2026-06-16T00:00:03.000Z"
        })
      }
    });

    await waitFor(() => expect(notificationCalls).toHaveLength(1));
    expect(notificationCalls[0]).toMatchObject({
      title: "HumanEval run finished",
      options: { body: "demo-model · 2/2 passed · completed", tag: "run-1" }
    });
  });

  it("notifies after an SSE error when refresh finds an observed run completed", async () => {
    const notificationCalls = installNotificationMock();
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        listCalls += 1;
        const run = listCalls === 1
          ? baseRun({ status: "running", completed: 1, passed: 1, activeTaskIds: ["HumanEval/1"] })
          : baseRun({
              status: "completed",
              completed: 2,
              passed: 2,
              liveScore: 1,
              finalScore: 1,
              finishedAt: "2026-06-16T00:00:03.000Z"
            });
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...baseRun({ status: "running" }), events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0].onerror?.();

    await waitFor(() => expect(notificationCalls).toHaveLength(1));
    expect(notificationCalls[0].options?.body).toBe("demo-model · 2/2 passed · completed");
  });

  it("keeps new bench selected by default and resets parameters from a run tab", async () => {
    const runWithConfig = baseRun({
      status: "completed",
      model: "saved-model",
      config: {
        baseUrl: "http://saved.example/v1",
        model: "saved-model",
        maxTokens: 4096,
        timeoutSeconds: 60,
        parallelTasks: 8,
        sampleLimit: 12,
        startIndex: 9,
        testNumbers: "1, 2",
        systemPrompt: "saved system",
        promptTemplate: "saved template %problem_code%",
        extraBody: { top_p: 0.5 }
      }
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [runWithConfig] });
      }
      return jsonResponse({ ...runWithConfig, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(window.location.pathname).toBe("/new");

    const modelInput = await screen.findByPlaceholderText("provider/model-name");
    expect(modelInput).toHaveValue("");
    expect(screen.getByPlaceholderText("https://host/v1")).toHaveValue("http://localhost:8000/v1");

    await userEvent.click(screen.getByRole("button", { name: /completed.*saved-model|saved-model.*completed/i }));
    await waitFor(() => expect(modelInput).toHaveValue("saved-model"));
    expect(window.location.pathname).toBe("/run/run-1");
    expect(screen.getByPlaceholderText("https://host/v1")).toHaveValue("http://saved.example/v1");

    await userEvent.click(screen.getByRole("button", { name: /new bench/i }));
    expect(window.location.pathname).toBe("/new");
    expect(modelInput).toHaveValue("");
    expect(screen.getByPlaceholderText("https://host/v1")).toHaveValue("http://localhost:8000/v1");
    const extraBodyField = screen.getByText("Extra request body").closest("label")?.querySelector("textarea");
    expect(extraBodyField).toHaveValue("{\n  \"top_p\": 1\n}");
  });

  it("posts the normalized benchmark configuration when starting a run", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs") && init?.method === "POST") {
        return jsonResponse(baseRun({ status: "queued", config: { model: "configured-model" } }), 201);
      }
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse({ ...baseRun({ status: "queued" }), events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "configured-model");
    await userEvent.clear(screen.getByLabelText("Parallel"));
    await userEvent.type(screen.getByLabelText("Parallel"), "99");
    await userEvent.clear(screen.getByLabelText("Passes"));
    await userEvent.type(screen.getByLabelText("Passes"), "101");
    await userEvent.clear(screen.getByLabelText("System prompt"));
    await userEvent.type(screen.getByLabelText("System prompt"), "system");
    await userEvent.clear(screen.getByLabelText("Prompt template"));
    await userEvent.type(screen.getByLabelText("Prompt template"), "prompt %problem_code%");
    fireEvent.change(screen.getByLabelText("Extra request body"), { target: { value: "{\"top_p\":0.25}" } });

    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      model: "configured-model",
      parallelTasks: 64,
      passCount: 100,
      systemPrompt: "system",
      promptTemplate: "prompt %problem_code%",
      temperature: 0,
      extraBody: { top_p: 0.25 }
    });
  });

  it("does not post a run when extra request body is invalid", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse(baseRun({ events: [] } as Partial<RunFixture>));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "configured-model");
    fireEvent.change(screen.getByLabelText("Extra request body"), { target: { value: "[]" } });
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    await screen.findByText("Extra request body must be a JSON object.");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps start disabled until a model is entered", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ runs: [] })));

    render(<App />);
    const startButton = screen.getByRole("button", { name: /start run/i });
    expect(startButton).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");

    expect(startButton).toBeEnabled();
  });

  it("posts resume for an incomplete stopped run", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const stoppedRun = baseRun({
      status: "cancelled",
      total: 3,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 1,
      finalScore: null,
      finishedAt: "2026-06-16T00:00:10.000Z"
    });
    const resumedRun = baseRun({ ...stoppedRun, status: "running", finishedAt: null });
    const staleEvents = [
      {
        type: "task-started",
        at: "2026-06-16T00:00:01.000Z",
        data: {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 1,
          index: 0,
          entryPoint: "foo",
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1"
        }
      },
      {
        type: "token",
        at: "2026-06-16T00:00:02.000Z",
        data: {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          index: 0,
          channel: "output",
          text: "old stale output"
        }
      }
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, requestInit?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/humaneval/runs/run-1/resume") && requestInit?.method === "POST") {
        return jsonResponse(resumedRun);
      }
      if (requestUrl.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [stoppedRun] });
      }
      return jsonResponse({ ...stoppedRun, events: staleEvents });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const resumeButton = await screen.findByRole("button", { name: /resume/i });
    await screen.findByText(/old stale output/i);
    await waitFor(() => expect(resumeButton).toBeEnabled());
    await userEvent.click(resumeButton);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/humaneval/runs/run-1/resume",
      { method: "POST" }
    );
    await waitFor(() => expect(screen.queryByText(/old stale output/i)).not.toBeInTheDocument());
  });

  it("only shows the ETA metric for runs that are in progress", async () => {
    const completedRun = baseRun({
      status: "completed",
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      startedAt: "2026-06-16T00:00:00.000Z",
      finishedAt: "2026-06-16T00:00:30.000Z"
    });
    const runningRun = baseRun({
      id: "run-2",
      status: "running",
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [completedRun, runningRun] });
      }
      if (url.endsWith("/api/humaneval/runs/run-2")) {
        return jsonResponse({ ...runningRun, events: [] });
      }
      return jsonResponse({ ...completedRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("button", { name: /completed.*demo-model|demo-model.*completed/i });
    expect(screen.queryByText("ETA")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /running.*demo-model|demo-model.*running/i }));

    await waitFor(() => expect(screen.getByText("ETA")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /disable finish notification/i })).toBeInTheDocument();
  });

  it("keeps full live output and running task prompts after many tokens", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const runningRun = baseRun({
      status: "running",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"],
      config: {
        systemPrompt: "SYSTEM PROMPT",
        promptTemplate: "USER PROMPT\n%problem_code%"
      }
    } as Partial<RunFixture>);
    const taskPrompt = "def foo(x):\n    \"\"\"Return x.\"\"\"\n";
    const events = [
      {
        type: "task-started",
        at: "2026-06-16T00:00:01.000Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          entryPoint: "foo",
          prompt: taskPrompt,
          test: "assert foo(1) == 1"
        }
      },
      {
        type: "prompt",
        at: "2026-06-16T00:00:01.100Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: `USER PROMPT\n${taskPrompt}` }
          ]
        }
      },
      ...Array.from({ length: 6001 }, (_, index) => ({
        type: "token",
        at: "2026-06-16T00:00:02.000Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          channel: "thinking",
          text: `token-${index} `
        }
      }))
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("Live output");
    await waitFor(() => expect(container.textContent).toContain("token-6000"));
    expect(container.textContent).toContain("token-0");
    expect(container.textContent).toContain("SYSTEM:\nSYSTEM PROMPT");
    expect(container.textContent).toContain(`USER PROMPT\n${taskPrompt}`);
    expect(container.textContent).toContain(taskPrompt);
    expect(container.textContent).not.toContain("Prompt pending.");
    expect(container.textContent).not.toContain("Task prompt pending.");
  });

  it("merges equal adjacent passes in the variability chart without merging distinct task outputs", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const multiPassRun = baseRun({
      status: "completed",
      total: 4,
      completed: 4,
      passed: 3,
      failed: 1,
      liveScore: 0.75,
      finalScore: 0.75,
      config: { passCount: 4 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "pass one",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(2) == 2", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(2) == 2",
          rawOutput: "pass two",
          extractedCode: "def foo(x): return x",
          generationMs: 1100
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-3",
          passNumber: 3,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: false,
          tests: [{ source: "assert foo(3) == 3", passed: false, actual: "1", expected: "3", operator: "==" }],
          prompt: "def foo(x): pass",
          test: "assert foo(3) == 3",
          rawOutput: "pass three",
          extractedCode: "def foo(x): return 1",
          generationMs: 1200
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-4",
          passNumber: 4,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(4) == 4", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(4) == 4",
          rawOutput: "pass four",
          extractedCode: "def foo(x): return x",
          generationMs: 900
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [multiPassRun] });
      }
      return jsonResponse({ ...multiPassRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("HumanEval/0");
    const variabilityRegion = screen.getByRole("region", { name: /pass variability/i });
    expect(within(variabilityRegion).getByText("Pass variability")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("100% swing")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 1 - 2")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 3")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 4")).toBeInTheDocument();
    expect(screen.getAllByText("1/1").length).toBeGreaterThan(0);
    expect(screen.getByText("0/1")).toBeInTheDocument();
    expect(container.textContent).toMatch(/Mixed\s*1/);
    expect(screen.getAllByText("HumanEval/0")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 2/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 3/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 4/i })).toBeInTheDocument();
    expect(container.textContent).toContain("assert foo(1) == 1");

    await userEvent.click(screen.getByRole("tab", { name: /pass 3/i }));

    await waitFor(() => expect(container.textContent).toContain("assert foo(3) == 3"));
    expect(container.textContent).toContain("expected: 3");
  });

  it("merges sequential pending passes in the variability chart", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const pendingRun = baseRun({
      status: "running",
      total: 4,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.25,
      currentTaskId: "HumanEval/0",
      config: { passCount: 4 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "pass one",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        }
      ],
      events: [
        {
          type: "task-started",
          at: "2026-06-16T00:00:01.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, passTotal: 4, index: 0, entryPoint: "foo" }
        },
        {
          type: "task-started",
          at: "2026-06-16T00:00:02.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-3", passNumber: 3, passTotal: 4, index: 0, entryPoint: "foo" }
        },
        {
          type: "task-started",
          at: "2026-06-16T00:00:03.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-4", passNumber: 4, passTotal: 4, index: 0, entryPoint: "foo" }
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [pendingRun] });
      }
      return jsonResponse(pendingRun);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/0");
    const variabilityRegion = screen.getByRole("region", { name: /pass variability/i });
    const passSpreadMetric = within(variabilityRegion).getByText("Pass spread").closest("div") as HTMLElement;
    expect(within(passSpreadMetric).getByText("100%")).toBeInTheDocument();
    expect(within(passSpreadMetric).queryByText("100%-100%")).not.toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 1")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 2 - 4")).toBeInTheDocument();
  });

  it("merges task tabs when timing is the only difference and shows a time range", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const groupedTaskRun = baseRun({
      status: "completed",
      total: 2,
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      config: { passCount: 2 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1200
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [groupedTaskRun] });
      }
      return jsonResponse({ ...groupedTaskRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("HumanEval/0");
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1 - 2/i })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(container.textContent).toContain("1.0s - 1.2s");
  });

  it("merges a completed pass into an existing identical group after live output was present", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const runningRun = baseRun({
      status: "running",
      total: 2,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"],
      config: { passCount: 2 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        }
      ]
    } as Partial<RunFixture>);
    const completedRun = {
      ...runningRun,
      status: "completed",
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      finishedAt: "2026-06-16T00:00:03.000Z",
      currentTaskId: null,
      activeTaskIds: [],
      results: [
        ...runningRun.results,
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1200
        }
      ]
    };
    let detailFetches = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      detailFetches += 1;
      if (detailFetches === 1) {
        return jsonResponse({
          ...runningRun,
          events: [
            {
              type: "task-started",
              at: "2026-06-16T00:00:01.000Z",
              data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, passTotal: 2, index: 0, entryPoint: "foo" }
            },
            {
              type: "token",
              at: "2026-06-16T00:00:02.000Z",
              data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, index: 0, channel: "output", text: "temporary live output" }
            }
          ]
        });
      }
      return jsonResponse({ ...completedRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/0");
    expect(screen.getByRole("tab", { name: /pass 1/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 2/i })).toBeInTheDocument();

    FakeEventSource.instances[0].emit("task-finished", {
      type: "task-finished",
      at: "2026-06-16T00:00:03.000Z",
      data: { summary: completedRun }
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /HumanEval\/0/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1 - 2/i })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("shows speed total as a projected full benchmark duration while running", async () => {
    const startedAt = new Date(Date.now() - 25_000).toISOString();
    const runningRun = baseRun({
      status: "running",
      total: 4,
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 0.5,
      startedAt,
      currentTaskId: "HumanEval/2",
      activeTaskIds: ["HumanEval/2"],
      results: [
        {
          taskId: "HumanEval/0",
          index: 0,
          entryPoint: "task0",
          passed: true,
          tests: [],
          prompt: "",
          test: "",
          rawOutput: "",
          extractedCode: "",
          generationMs: 10_000
        },
        {
          taskId: "HumanEval/1",
          index: 1,
          entryPoint: "task1",
          passed: true,
          tests: [],
          prompt: "",
          test: "",
          rawOutput: "",
          extractedCode: "",
          generationMs: 10_000
        }
      ]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /running.*demo-model|demo-model.*running/i }));

    await screen.findByText("Speed");
    const speedMetric = screen.getByText("Speed").closest(".bench-metric") as HTMLElement;
    expect(within(speedMetric).getByText("Per task")).toBeInTheDocument();
    expect(within(speedMetric).getByText("10s")).toBeInTheDocument();
    expect(within(speedMetric).getByText("Total")).toBeInTheDocument();
    expect(within(speedMetric).getByText("~40s")).toBeInTheDocument();
  });

  it("does not notify for a run that was disabled from its ETA card", async () => {
    const notificationCalls = installNotificationMock();
    const runningRun = baseRun({
      status: "running",
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /running.*demo-model|demo-model.*running/i }));
    await userEvent.click(screen.getByRole("button", { name: /disable finish notification/i }));
    expect(screen.getByRole("button", { name: /enable finish notification/i })).toBeInTheDocument();

    FakeEventSource.instances[0].emit("done", {
      type: "done",
      at: "2026-06-16T00:00:03.000Z",
      data: {
        summary: {
          ...runningRun,
          status: "completed",
          completed: 2,
          passed: 2,
          liveScore: 1,
          finalScore: 1,
          finishedAt: "2026-06-16T00:00:03.000Z"
        }
      }
    });

    await waitFor(() => expect(FakeEventSource.instances[0].closed).toBe(true));
    expect(notificationCalls).toHaveLength(0);
  });

  it("selects a run from a /run/:id deep link", async () => {
    window.history.replaceState(null, "", "/run/run-2");
    const run = baseRun({
      id: "run-2",
      status: "completed",
      model: "deep-link-model",
      completed: 2,
      passed: 1,
      failed: 1,
      liveScore: 0.5,
      finalScore: 0.5
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [run] });
      }
      if (url.endsWith("/api/humaneval/runs/run-2")) {
        return jsonResponse({ ...run, events: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByPlaceholderText("provider/model-name")).toHaveValue("deep-link-model"));
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/run/run-2");
  });

  it("shows total and current pass completion in the completed metric", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const run = baseRun({
      status: "running",
      total: 4,
      completed: 3,
      passed: 2,
      failed: 1,
      liveScore: 2 / 3,
      config: { passCount: 2 }
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("Completed");
    const completedMetric = screen.getByText("Completed").closest(".bench-metric") as HTMLElement;
    expect(within(completedMetric).getByText("Total:")).toBeInTheDocument();
    expect(within(completedMetric).getByText("75% (3/4)")).toBeInTheDocument();
    expect(within(completedMetric).getByText("2nd pass:")).toBeInTheDocument();
    expect(within(completedMetric).getByText("50% (1/2)")).toBeInTheDocument();
  });

  it("keeps browser back and forward in sync with selected bench", async () => {
    const run = baseRun({
      id: "run-1",
      status: "completed",
      model: "history-model",
      config: { model: "history-model", baseUrl: "http://history.example/v1" }
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/humaneval/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const modelInput = await screen.findByPlaceholderText("provider/model-name");
    await userEvent.click(screen.getByRole("button", { name: /completed.*history-model|history-model.*completed/i }));
    await waitFor(() => expect(modelInput).toHaveValue("history-model"));
    expect(window.location.pathname).toBe("/run/run-1");

    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(modelInput).toHaveValue(""));
    expect(window.location.pathname).toBe("/new");

    window.history.forward();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(modelInput).toHaveValue("history-model"));
    expect(window.location.pathname).toBe("/run/run-1");
  });
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText("Per task")).toBeInTheDocument();
    expect(screen.getByText("10s")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("~40s")).toBeInTheDocument();
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

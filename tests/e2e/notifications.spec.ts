import { expect, test } from "@playwright/test";

const queuedRun = {
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
  results: []
};

test("notifies when a benchmark run completes", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __notificationCalls: unknown[] }).__notificationCalls = [];
    (window as unknown as { __eventSources: unknown[] }).__eventSources = [];

    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";

      constructor(title: string, options?: NotificationOptions) {
        (window as unknown as { __notificationCalls: unknown[] }).__notificationCalls.push({ title, options });
      }
    }

    class FakeEventSource extends EventTarget {
      url: string;
      closed = false;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        (window as unknown as { __eventSources: FakeEventSource[] }).__eventSources.push(this);
      }

      close() {
        this.closed = true;
      }

      emit(type: string, data: unknown) {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }

    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
  });

  await page.route("http://localhost:8787/api/humaneval/runs**", async (route, request) => {
    const url = request.url();
    if (request.method() === "POST" && url.endsWith("/api/humaneval/runs")) {
      await route.fulfill({ json: queuedRun, status: 201 });
      return;
    }
    if (request.method() === "GET" && url.endsWith("/api/humaneval/runs")) {
      await route.fulfill({ json: { runs: [] } });
      return;
    }
    await route.fulfill({ json: { ...queuedRun, events: [] } });
  });

  await page.goto("/");
  await page.getByPlaceholder("provider/model-name").fill("demo-model");
  await page.getByRole("button", { name: /start run/i }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __eventSources: unknown[] }).__eventSources.length
  ))).toBe(1);

  await page.evaluate((run) => {
    const source = (window as unknown as { __eventSources: Array<{ emit: (type: string, data: unknown) => void }> }).__eventSources[0];
    source.emit("done", {
      type: "done",
      at: "2026-06-16T00:00:03.000Z",
      data: {
        summary: {
          ...run,
          status: "completed",
          completed: 2,
          passed: 2,
          liveScore: 1,
          finalScore: 1,
          finishedAt: "2026-06-16T00:00:03.000Z"
        }
      }
    });
  }, queuedRun);

  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __notificationCalls: unknown[] }).__notificationCalls
  ))).toEqual([{
    title: "HumanEval run finished",
    options: {
      body: "demo-model · 2/2 passed · completed",
      tag: "run-1"
    }
  }]);
});

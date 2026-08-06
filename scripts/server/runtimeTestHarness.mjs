import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeServer } from "./runtime.mjs";

// Shared scaffolding for runtime integration tests, in this repository and in
// optional benchmark packs: a throwaway root directory, a fake
// OpenAI-compatible endpoint, a live runtime server, and run helpers. Every
// resource registers a cleanup, so a suite only has to call `cleanup()` once
// in afterEach.
export function createRuntimeTestHarness() {
  const cleanups = [];

  async function cleanup() {
    const pending = cleanups.splice(0, cleanups.length).reverse();
    await Promise.all(pending.map((entry) => Promise.resolve().then(entry).catch(() => undefined)));
  }

  async function makeRootDir(prefix = "runtime-harness-") {
    const rootDir = await fs.mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));
    await fs.mkdir(join(rootDir, ".cache"), { recursive: true });
    return rootDir;
  }

  async function makeTempDir(prefix) {
    const directory = await fs.mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
  }

  // Restores the variable (including "was unset") when the harness cleans up.
  function setEnvironmentVariable(name, value) {
    const original = process.env[name];
    process.env[name] = value;
    cleanups.push(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }

  // Serves an OpenAI-compatible /chat/completions endpoint. `handlers` are
  // consumed one per request; the last handler repeats for later requests.
  async function startModelServer(handlers) {
    let requestCount = 0;
    const requests = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      // An aborted or keep-alive probe request can arrive with an empty body;
      // parsing it would reject outside any test and poison unrelated files.
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, headers: req.headers, body });
      const handler = handlers[Math.min(requestCount, handlers.length - 1)];
      requestCount += 1;
      await handler(req, res, body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
  }

  async function startRuntime(rootDir, options = {}) {
    const app = createRuntimeServer({ rootDir, port: 0, ...options });
    await app.loadPersistedRuns();
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => app.server.close(resolve)));
    return { app, apiUrl: `http://127.0.0.1:${app.server.address().port}` };
  }

  async function createRun(apiUrl, modelBaseUrl, overrides = {}) {
    const response = await fetch(`${apiUrl}/api/humaneval/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: modelBaseUrl,
        model: "test-model",
        maxOutputTokens: 512,
        timeoutSeconds: 10,
        ...overrides
      })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "createRun failed");
    return json;
  }

  async function waitForStatus(apiUrl, runId, statuses, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const detail = await fetch(`${apiUrl}/api/humaneval/runs/${runId}`)
        .then((response) => response.json());
      if (statuses.includes(detail.status)) return detail;
      if (Date.now() > deadline) {
        throw new Error(`Run ${runId} stayed "${detail.status}", never reached ${statuses.join("/")}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    cleanup,
    createRun,
    makeRootDir,
    makeTempDir,
    setEnvironmentVariable,
    startModelServer,
    startRuntime,
    waitForStatus
  };
}

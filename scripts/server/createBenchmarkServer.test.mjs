// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBenchmarkServer } from "./createBenchmarkServer.mjs";

let servers = [];
let tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  servers = [];
  tempDirs = [];
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

describe("createBenchmarkServer", () => {
  it("runs a deterministic benchmark through HTTP and persists artifacts", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-runs-"));
    tempDirs.push(runsDir);
    const modelFetch = vi.fn(async () => new Response([
      "data: {\"choices\":[{\"delta\":{\"content\":\"```python\\ndef add_one(x):\\n    return x + 1\\n```\"}}]}",
      "data: [DONE]",
      ""
    ].join("\n\n")));
    const executeTests = vi.fn(async (_problem, code) => ({
      passed: code.includes("return x + 1"),
      tests: [{ source: "assert add_one(1) == 2", passed: code.includes("return x + 1") }]
    }));
    const { server } = createBenchmarkServer({
      runsDir,
      fetchImpl: modelFetch,
      executeTests,
      problems: [{
        task_id: "HumanEval/0",
        prompt: "def add_one(x):\n    pass\n",
        test: "def check(candidate):\n    assert candidate(1) == 2\n",
        entry_point: "add_one"
      }]
    });
    const baseUrl = await listen(server);

    const created = await fetch(`${baseUrl}/api/humaneval/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://model.test/v1",
        model: "demo-model",
        testNumbers: "0",
        passCount: 1
      })
    }).then((response) => response.json());

    await vi.waitFor(async () => {
      const detail = await fetch(`${baseUrl}/api/humaneval/runs/${created.id}`).then((response) => response.json());
      expect(detail.status).toBe("completed");
    });

    const detail = await fetch(`${baseUrl}/api/humaneval/runs/${created.id}`).then((response) => response.json());
    expect(detail.results[0]).toMatchObject({
      taskId: "HumanEval/0",
      passed: true,
      tests: [{ source: "assert add_one(1) == 2", passed: true }]
    });
    expect(detail.events.map((event) => event.type)).toContain("done");
    expect(modelFetch).toHaveBeenCalledWith("http://model.test/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(executeTests).toHaveBeenCalledWith(expect.objectContaining({ task_id: "HumanEval/0" }), expect.stringContaining("def add_one"), 15);

    const runJson = JSON.parse(await fs.readFile(join(runsDir, created.id, "run.json"), "utf8"));
    const resultsJson = JSON.parse(await fs.readFile(join(runsDir, created.id, "results.json"), "utf8"));
    expect(runJson).toMatchObject({ id: created.id, status: "completed", results: [] });
    expect(resultsJson[0]).toMatchObject({ taskId: "HumanEval/0", passed: true });
  });
});

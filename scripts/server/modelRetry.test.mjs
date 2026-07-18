// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fetchModelResponseWithRetry, throwIfRetryableModelOutput } from "./modelRetry.mjs";

describe("fetchModelResponseWithRetry", () => {
  it("retries fetch failed errors until the model responds", async () => {
    const modelFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok"));
    const retryEvents = [];

    const response = await fetchModelResponseWithRetry({
      fetchImplementation: modelFetch,
      requestUrl: "http://model.test/v1/chat/completions",
      requestOptions: { method: "POST" },
      initialRetryDelayMilliseconds: 0,
      maximumRetryDelayMilliseconds: 0,
      onRetry: (retryEvent) => retryEvents.push(retryEvent)
    });

    expect(await response.text()).toBe("ok");
    expect(modelFetch).toHaveBeenCalledTimes(2);
    expect(retryEvents).toEqual([{ attemptNumber: 1, errorMessage: "fetch failed", retryDelayMilliseconds: 0 }]);
  });

  it("retries HTTP 507 responses until the model responds", async () => {
    const firstMemoryError = "Cannot load Qwen3.6-27B-MLX-6bit: projected memory would exceed the memory ceiling.";
    const secondMemoryError = "Model 'Qwen3.6-27B-MLX-6bit' does not fit under the memory ceiling.";
    const modelFetch = vi.fn()
      .mockResolvedValueOnce(new Response(firstMemoryError, { status: 507 }))
      .mockResolvedValueOnce(new Response(secondMemoryError, { status: 507 }))
      .mockResolvedValueOnce(new Response("ok"));
    const retryEvents = [];

    const response = await fetchModelResponseWithRetry({
      fetchImplementation: modelFetch,
      requestUrl: "http://model.test/v1/chat/completions",
      requestOptions: { method: "POST" },
      initialRetryDelayMilliseconds: 0,
      maximumRetryDelayMilliseconds: 0,
      onRetry: (retryEvent) => retryEvents.push(retryEvent)
    });

    expect(await response.text()).toBe("ok");
    expect(modelFetch).toHaveBeenCalledTimes(3);
    expect(retryEvents).toEqual([
      {
        attemptNumber: 1,
        errorMessage: `Model request failed: HTTP 507 ${firstMemoryError}`,
        retryDelayMilliseconds: 0
      },
      {
        attemptNumber: 2,
        errorMessage: `Model request failed: HTTP 507 ${secondMemoryError}`,
        retryDelayMilliseconds: 0
      }
    ]);
  });

  it("retries responses when thinking or output contains Request aborted", async () => {
    const abortedThinking = "Partial thinking output.\n[Error: Request aborted: process memory limit exceeded.]";
    const abortedOutput = "Partial output.\nRequest aborted by the model server.";
    const modelFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ thinking: abortedThinking, output: "" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thinking: "", output: abortedOutput })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ thinking: "Complete thinking.", output: "complete output" })));
    const retryEvents = [];

    const output = await fetchModelResponseWithRetry({
      fetchImplementation: modelFetch,
      requestUrl: "http://model.test/v1/chat/completions",
      requestOptions: { method: "POST" },
      processResponse: async (response) => {
        const modelOutput = await response.json();
        throwIfRetryableModelOutput(modelOutput.thinking, modelOutput.output);
        return modelOutput.output;
      },
      initialRetryDelayMilliseconds: 0,
      maximumRetryDelayMilliseconds: 0,
      onRetry: (retryEvent) => retryEvents.push(retryEvent)
    });

    expect(output).toBe("complete output");
    expect(modelFetch).toHaveBeenCalledTimes(3);
    expect(retryEvents).toEqual([
      {
        attemptNumber: 1,
        errorMessage: "Model request failed: [Error: Request aborted: process memory limit exceeded.]",
        retryDelayMilliseconds: 0
      },
      {
        attemptNumber: 2,
        errorMessage: "Model request failed: Request aborted by the model server.",
        retryDelayMilliseconds: 0
      }
    ]);
  });
});
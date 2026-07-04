// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fetchModelResponseWithRetry } from "./modelRetry.mjs";

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
});
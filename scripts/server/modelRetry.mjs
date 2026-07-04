const defaultInitialRetryDelayMilliseconds = 1000;
const defaultMaximumRetryDelayMilliseconds = 30 * 1000;

export function modelErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableModelFetchError(error) {
  return modelErrorMessage(error).includes("fetch failed");
}

function createAbortError() {
  const error = new Error("Model request aborted.");
  error.name = "AbortError";
  return error;
}

async function waitForRetryDelay(retryDelayMilliseconds, signal) {
  if (retryDelayMilliseconds <= 0) return;
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
      return;
    }

    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, retryDelayMilliseconds);

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function fetchModelResponseWithRetry({
  fetchImplementation,
  requestUrl,
  requestOptions,
  signal,
  shouldStop = () => false,
  onRetry = () => {},
  initialRetryDelayMilliseconds = defaultInitialRetryDelayMilliseconds,
  maximumRetryDelayMilliseconds = defaultMaximumRetryDelayMilliseconds
}) {
  let attemptNumber = 1;
  let retryDelayMilliseconds = initialRetryDelayMilliseconds;

  while (true) {
    try {
      return await fetchImplementation(requestUrl, requestOptions);
    } catch (error) {
      if (signal?.aborted || shouldStop() || !isRetryableModelFetchError(error)) {
        throw error;
      }

      onRetry({
        attemptNumber,
        errorMessage: modelErrorMessage(error),
        retryDelayMilliseconds
      });
      await waitForRetryDelay(retryDelayMilliseconds, signal);
      attemptNumber += 1;
      retryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, maximumRetryDelayMilliseconds);
    }
  }
}
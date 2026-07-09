# Performance Measurements

This guide documents the performance instrumentation used to diagnose browser
memory pressure before changing benchmark behavior. It exists so future
optimization work starts from evidence instead of guessing.

The current issue this was added for is Safari showing:

```text
This webpage was reloaded because it was using significant memory.
```

## Intent

Use the measurements to answer four questions:

1. How large are selected-run responses?
2. How quickly does live SSE state grow while a run is streaming?
3. How much task-detail text does the browser retain and render?
4. Which interaction correlates with Safari memory growth?

Do not start by reducing payloads, trimming token state, virtualizing rows, or
adding new dependencies. First capture a baseline, identify the dominant source,
then make the smallest targeted fix.

## Enable Measurements

Start the benchmark server with server-side performance logs enabled:

```bash
HUMANEVAL_PERFORMANCE_LOG=1 npm run dev:bench
```

Start the UI normally:

```bash
npm run dev
```

Open the UI with the debug query parameter:

```text
http://localhost:5173?debug=performance
```

The browser toggle persists in local storage under:

```text
humaneval.performance.debug
```

To disable it, remove that key from local storage or run this in the browser
console:

```js
localStorage.removeItem("humaneval.performance.debug");
delete window.humanEvalPerformanceMetrics;
```

## Browser Metrics

When enabled, browser metrics are exposed on:

```js
window.humanEvalPerformanceMetrics
```

The object is debug-only. It is deleted in normal mode.

### Selected Run Fetches

`selectedRunFetches` keeps recent measurements for
`GET /api/humaneval/runs/{id}`.

Each entry includes:

- `runId` - selected run id.
- `durationMilliseconds` - request plus JSON parsing duration.
- `contentLengthBytes` - response header value when available.
- `payloadBytes` - byte length of the parsed JSON re-serialized in the
  browser.
- `resultCount` - number of results in the selected-run response.
- `eventCount` - number of replay events in the selected-run response.
- `tokenEventCount` - number of token replay events in the response.

Use this to test the hypothesis that selecting a completed or large historical
run pulls too much result data into the browser.

### SSE Event Source

`eventSource` tracks live Server-Sent Events received by the browser.

It includes:

- `runId` - run currently associated with the stream.
- `totalEventCount` - total SSE messages observed in debug mode.
- `totalBytes` - total incoming SSE message bytes.
- `eventTypes` - count and bytes by event type, such as `prompt`, `token`,
  `raw-delta`, `task-finished`, `done`, and `error`.
- `tokenChannels` - token counts and token text bytes by channel, such as
  `output`, `thinking`, or `refusal`.
- `lastTokenGapMilliseconds` - time between the two most recent token events.
- `maxTokenGapMilliseconds` - largest observed token gap.

Use this to test whether a live run grows token/event state fast enough to
explain the browser reload.

### Derived State

`state` records the latest selected-run state sizes after React derives task
data.

It includes:

- `runId` - selected run id.
- `eventCount` - retained event array length.
- `tokenCount` - retained token array length.
- `tokensByAttemptCount` - number of attempt groups with token data.
- `promptInfoByAttemptCount` - number of attempt groups with prompt info.
- `taskGroupCount` - rendered task group count.
- `attemptCount` - total attempts represented in task groups.
- `openTaskCount` - number of manually expanded task rows.

Use this to see whether state retained in React keeps growing after switching
runs, collapsing details, or returning to the New view.

### Task Results Render

`taskResultsRender` records the latest task-results render pressure sample.

It includes:

- `runId` - selected run id.
- `taskRowCount` - number of task rows in the task list.
- `detailPanelCount` - number of open detail panels.
- `visiblePreTextBytes` - approximate bytes of visible `<pre>` text.
- `attemptViewBuildDurationMilliseconds` - time spent building attempt views
  during the sampled render.

Use this to test whether opening task details creates too much visible text or
expensive render work.

## Server Logs

When `HUMANEVAL_PERFORMANCE_LOG=1` is set, the benchmark server writes
structured one-line JSON logs prefixed with `[PERF]`.

Example shape:

```text
[PERF] {"at":"2026-07-09T00:00:00.000Z","type":"json-response",...}
```

### JSON Response Logs

`type: "json-response"` entries include:

- `status` - HTTP status code.
- `responseBytes` - serialized JSON byte length.
- `serializationMilliseconds` - time spent serializing the response.
- `endpoint` - endpoint label when available, such as `list-runs`,
  `create-run`, or `get-run`.
- `runId` - run id for run-specific responses.
- `runCount`, `resultCount`, or `eventCount` - response shape counts when
  available.

Use `get-run` entries to compare selected-run payload size against Safari
memory checkpoints.

### Terminal Run Logs

`type: "run-terminal"` entries are emitted when a run reaches a terminal state.

They include:

- `runId` - benchmark run id.
- `status` - terminal run status.
- `totalEventCount` - total events appended by the server.
- `totalEventBytes` - total serialized event bytes.
- `replayEventCount` - events retained for replay.
- `resultCount` - completed result count.
- `largestEventType` and `largestEventTypeBytes` - event type contributing the
  most bytes.
- `tokenEventCount` and `tokenEventBytes` - token-specific event totals.
- `memoryRssBytes` and `memoryHeapUsedBytes` - Node process memory at terminal
  logging time.

Use terminal logs to decide whether backend event generation or replay size is
worth optimizing after browser-side evidence is collected.

## Baseline Procedure

Use a large historical run, and if possible a live streaming run. Capture both
the in-app metrics and Safari Web Inspector memory/timeline checkpoints.

Recommended checkpoints:

1. Initial page load.
2. After selecting a large completed run.
3. After expanding a task detail row.
4. After expanding several task detail rows.
5. During a live run after several task completions.
6. After collapsing task details.
7. After switching to another run.
8. After returning to New.

For each checkpoint, record:

- Selected run id and completed/total count.
- Selected-run response bytes and duration.
- Replay event count and bytes.
- Live SSE event count and bytes.
- Retained event and token counts.
- Token text bytes by channel.
- Visible task detail text bytes.
- Open detail panel count.
- Safari memory/timeline observation.

## Interpreting Results

Use the largest measured contributor to choose the next optimization:

- If selected-run response bytes dominate, shrink the default selected-run
  response and fetch heavy result details lazily.
- If SSE retained bytes dominate, bound token/event state and avoid full-run
  refetches on task completion.
- If visible detail text dominates, render heavy task details lazily, truncate
  large raw text by default, or virtualize rows.
- If server serialization dominates, compact response shapes or add dedicated
  detail endpoints.
- If Node memory dominates independently of browser memory, investigate run
  eviction or artifact loading separately.

## Notes And Constraints

- Metrics are disabled by default.
- Normal mode should not show debug UI or noisy console logs.
- Do not use `performance.memory` as the primary signal. Safari support is not
  dependable, and this investigation is Safari-driven. Use Safari Web Inspector
  for actual memory and the in-app counters to explain what likely caused it.
- Treat captured logs as potentially sensitive. Run ids, model names, endpoint
  names, event sizes, prompts, model output, and reasoning traces can reveal
  private benchmark context.
- Add tests for metric shape and safety, not exact timings or heap values.
export const PERFORMANCE_DEBUG_STORAGE_KEY = "humaneval.performance.debug";

type SelectedRunFetchMeasurement = {
  runId: string;
  durationMilliseconds: number;
  contentLengthBytes: number | null;
  payloadBytes: number;
  resultCount: number;
  eventCount: number;
  tokenEventCount: number;
};

type StateMeasurement = {
  runId: string | null;
  eventCount: number;
  tokenCount: number;
  tokensByAttemptCount: number;
  promptInfoByAttemptCount: number;
  taskGroupCount: number;
  attemptCount: number;
  openTaskCount: number;
};

type TaskResultsRenderMeasurement = {
  runId: string | null;
  taskRowCount: number;
  detailPanelCount: number;
  visiblePreTextBytes: number;
  attemptViewBuildDurationMilliseconds: number;
};

type EventTypeMeasurement = {
  count: number;
  bytes: number;
};

type ChannelMeasurement = {
  count: number;
  textBytes: number;
};

export type BrowserPerformanceMetrics = {
  enabled: true;
  startedAt: string;
  updatedAt: string;
  selectedRunFetches: SelectedRunFetchMeasurement[];
  eventSource: {
    runId: string | null;
    totalEventCount: number;
    totalBytes: number;
    eventTypes: Record<string, EventTypeMeasurement>;
    tokenChannels: Record<string, ChannelMeasurement>;
    lastTokenGapMilliseconds: number | null;
    maxTokenGapMilliseconds: number | null;
  };
  state: StateMeasurement | null;
  taskResultsRender: TaskResultsRenderMeasurement | null;
};

declare global {
  interface Window {
    humanEvalPerformanceMetrics?: BrowserPerformanceMetrics;
  }
}

const maxSelectedRunFetchMeasurements = 20;

export function performanceDebugIsEnabled(browserWindow: Window = window) {
  const url = new URL(browserWindow.location.href);
  if (url.searchParams.get("debug") === "performance") {
    browserWindow.localStorage.setItem(PERFORMANCE_DEBUG_STORAGE_KEY, "1");
    return true;
  }
  return browserWindow.localStorage.getItem(PERFORMANCE_DEBUG_STORAGE_KEY) === "1";
}

export function jsonByteLength(value: unknown) {
  return textByteLength(JSON.stringify(value));
}

export function textByteLength(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

export function initializeBrowserPerformanceMetrics(enabled: boolean, browserWindow: Window = window) {
  if (!enabled) {
    delete browserWindow.humanEvalPerformanceMetrics;
    return null;
  }
  const existingMetrics = browserWindow.humanEvalPerformanceMetrics;
  if (existingMetrics) return existingMetrics;
  const now = new Date().toISOString();
  const metrics: BrowserPerformanceMetrics = {
    enabled: true,
    startedAt: now,
    updatedAt: now,
    selectedRunFetches: [],
    eventSource: {
      runId: null,
      totalEventCount: 0,
      totalBytes: 0,
      eventTypes: {},
      tokenChannels: {},
      lastTokenGapMilliseconds: null,
      maxTokenGapMilliseconds: null
    },
    state: null,
    taskResultsRender: null
  };
  browserWindow.humanEvalPerformanceMetrics = metrics;
  return metrics;
}

export function recordSelectedRunFetchMeasurement(measurement: SelectedRunFetchMeasurement) {
  const metrics = window.humanEvalPerformanceMetrics;
  if (!metrics) return;
  metrics.selectedRunFetches = [...metrics.selectedRunFetches, measurement].slice(-maxSelectedRunFetchMeasurements);
  metrics.updatedAt = new Date().toISOString();
}

export function recordEventSourceMeasurement({
  runId,
  eventType,
  messageBytes,
  tokenChannel,
  tokenTextBytes,
  tokenGapMilliseconds
}: {
  runId: string;
  eventType: string;
  messageBytes: number;
  tokenChannel?: string;
  tokenTextBytes?: number;
  tokenGapMilliseconds?: number | null;
}) {
  const metrics = window.humanEvalPerformanceMetrics;
  if (!metrics) return;
  metrics.eventSource.runId = runId;
  metrics.eventSource.totalEventCount += 1;
  metrics.eventSource.totalBytes += messageBytes;
  const eventTypeMeasurement = metrics.eventSource.eventTypes[eventType] || { count: 0, bytes: 0 };
  metrics.eventSource.eventTypes[eventType] = {
    count: eventTypeMeasurement.count + 1,
    bytes: eventTypeMeasurement.bytes + messageBytes
  };
  if (tokenChannel) {
    const channelMeasurement = metrics.eventSource.tokenChannels[tokenChannel] || { count: 0, textBytes: 0 };
    metrics.eventSource.tokenChannels[tokenChannel] = {
      count: channelMeasurement.count + 1,
      textBytes: channelMeasurement.textBytes + (tokenTextBytes || 0)
    };
  }
  if (tokenGapMilliseconds !== undefined) {
    metrics.eventSource.lastTokenGapMilliseconds = tokenGapMilliseconds;
    metrics.eventSource.maxTokenGapMilliseconds = Math.max(
      metrics.eventSource.maxTokenGapMilliseconds ?? 0,
      tokenGapMilliseconds ?? 0
    );
  }
  metrics.updatedAt = new Date().toISOString();
}

export function recordStateMeasurement(measurement: StateMeasurement) {
  const metrics = window.humanEvalPerformanceMetrics;
  if (!metrics) return;
  metrics.state = measurement;
  metrics.updatedAt = new Date().toISOString();
}

export function recordTaskResultsRenderMeasurement(measurement: TaskResultsRenderMeasurement) {
  const metrics = window.humanEvalPerformanceMetrics;
  if (!metrics) return;
  metrics.taskResultsRender = measurement;
  metrics.updatedAt = new Date().toISOString();
}
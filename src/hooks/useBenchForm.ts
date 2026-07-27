import { useState } from "react";
import {
  benchmarkOption,
  DEFAULT_FORM_VALUES,
  type BenchmarkId,
  type BenchRun
} from "../domain/benchmark";
import {
  formatExtraBody,
  normalizeParallelTasks,
  normalizePassCount
} from "../domain/runs";

export function useBenchForm() {
  const [benchmark, setBenchmarkState] = useState<BenchmarkId>(DEFAULT_FORM_VALUES.benchmark);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_FORM_VALUES.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_FORM_VALUES.apiKey);
  const [model, setModel] = useState(DEFAULT_FORM_VALUES.model);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_FORM_VALUES.maxTokens);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_FORM_VALUES.timeoutSeconds);
  const [parallelTasks, setParallelTasks] = useState(DEFAULT_FORM_VALUES.parallelTasks);
  const [passCount, setPassCount] = useState(DEFAULT_FORM_VALUES.passCount);
  const [commentSignalThreshold, setCommentSignalThreshold] = useState(DEFAULT_FORM_VALUES.commentSignalThreshold);
  const [sampleLimit, setSampleLimit] = useState(DEFAULT_FORM_VALUES.sampleLimit);
  const [startIndex, setStartIndex] = useState(DEFAULT_FORM_VALUES.startIndex);
  const [testNumbers, setTestNumbers] = useState(DEFAULT_FORM_VALUES.testNumbers);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_FORM_VALUES.systemPrompt);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_FORM_VALUES.promptTemplate);
  const [extraBody, setExtraBody] = useState(DEFAULT_FORM_VALUES.extraBody);

  // Switching benchmarks swaps in that benchmark's default prompts and clears
  // dataset-specific task selections, which do not transfer between datasets.
  function setBenchmark(nextBenchmark: BenchmarkId) {
    const option = benchmarkOption(nextBenchmark);
    setBenchmarkState(option.id);
    setSystemPrompt(option.systemPrompt);
    setPromptTemplate(option.promptTemplate);
    setTestNumbers(DEFAULT_FORM_VALUES.testNumbers);
    setStartIndex(DEFAULT_FORM_VALUES.startIndex);
    setSampleLimit(DEFAULT_FORM_VALUES.sampleLimit);
  }

  function resetRunConfig() {
    setBenchmarkState(DEFAULT_FORM_VALUES.benchmark);
    setBaseUrl(DEFAULT_FORM_VALUES.baseUrl);
    setApiKey(DEFAULT_FORM_VALUES.apiKey);
    setModel(DEFAULT_FORM_VALUES.model);
    setMaxTokens(DEFAULT_FORM_VALUES.maxTokens);
    setTimeoutSeconds(DEFAULT_FORM_VALUES.timeoutSeconds);
    setParallelTasks(DEFAULT_FORM_VALUES.parallelTasks);
    setPassCount(DEFAULT_FORM_VALUES.passCount);
    setCommentSignalThreshold(DEFAULT_FORM_VALUES.commentSignalThreshold);
    setSampleLimit(DEFAULT_FORM_VALUES.sampleLimit);
    setStartIndex(DEFAULT_FORM_VALUES.startIndex);
    setTestNumbers(DEFAULT_FORM_VALUES.testNumbers);
    setSystemPrompt(DEFAULT_FORM_VALUES.systemPrompt);
    setPromptTemplate(DEFAULT_FORM_VALUES.promptTemplate);
    setExtraBody(DEFAULT_FORM_VALUES.extraBody);
  }

  function loadRunConfig(run: BenchRun) {
    const config = run.config ?? {};
    const option = benchmarkOption(config.benchmark ?? run.benchmark);
    setBenchmarkState(option.id);
    setBaseUrl(config.baseUrl ?? run.baseUrl ?? "");
    setModel(config.model ?? run.model ?? "");
    setMaxTokens(Number(config.maxTokens ?? 2048));
    setTimeoutSeconds(Number(config.timeoutSeconds ?? 15));
    setParallelTasks(normalizeParallelTasks(Number(config.parallelTasks ?? 1)));
    setPassCount(normalizePassCount(Number(config.passCount ?? 1)));
    setSampleLimit(Number(config.sampleLimit ?? 0));
    setStartIndex(Number(config.startIndex ?? 0));
    setTestNumbers(String(config.testNumbers ?? ""));
    setSystemPrompt(String(config.systemPrompt ?? option.systemPrompt));
    setPromptTemplate(String(config.promptTemplate ?? option.promptTemplate));
    setExtraBody(formatExtraBody(config.extraBody));
  }

  return {
    benchmark, baseUrl, apiKey, model, maxTokens, timeoutSeconds, parallelTasks,
    passCount, commentSignalThreshold, sampleLimit, startIndex, testNumbers,
    systemPrompt, promptTemplate, extraBody, setBenchmark, setBaseUrl, setApiKey, setModel,
    setMaxTokens, setTimeoutSeconds, setParallelTasks, setPassCount,
    setCommentSignalThreshold, setSampleLimit, setStartIndex, setTestNumbers,
    setSystemPrompt, setPromptTemplate, setExtraBody, resetRunConfig, loadRunConfig
  };
}

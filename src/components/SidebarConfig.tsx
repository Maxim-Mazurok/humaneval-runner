import {
  CircleStop,
  FileText,
  KeyRound,
  PanelLeftClose,
  Play,
  RotateCcw,
  Server,
  Settings2,
  TerminalSquare
} from "lucide-react";
import type { BenchRun } from "../domain/benchmark";
import { normalizeParallelTasks, normalizePassCount, runCanResume, statusIsLive } from "../domain/runs";

export type SidebarConfigProps = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutSeconds: number;
  parallelTasks: number;
  passCount: number;
  sampleLimit: number;
  startIndex: number;
  testNumbers: string;
  systemPrompt: string;
  promptTemplate: string;
  extraBody: string;
  selectedRun: BenchRun | null;
  error: string | null;
  onCollapse: () => void;
  onStartRun: () => void;
  onCancelRun: () => void;
  onResumeRun: () => void;
  setBaseUrl: (value: string) => void;
  setApiKey: (value: string) => void;
  setModel: (value: string) => void;
  setMaxTokens: (value: number) => void;
  setTimeoutSeconds: (value: number) => void;
  setParallelTasks: (value: number) => void;
  setPassCount: (value: number) => void;
  setSampleLimit: (value: number) => void;
  setStartIndex: (value: number) => void;
  setTestNumbers: (value: string) => void;
  setSystemPrompt: (value: string) => void;
  setPromptTemplate: (value: string) => void;
  setExtraBody: (value: string) => void;
};

export function SidebarConfig(props: SidebarConfigProps) {
  return (
    <aside className="bench-sidebar">
      <div className="bench-title-row">
        <div className="bench-title">
          <TerminalSquare size={34} />
          <div>
            <p>HumanEval</p>
            <h1>Code benchmark workbench</h1>
          </div>
        </div>
        <button
          aria-label="Collapse benchmark settings"
          className="sidebar-toggle"
          title="Collapse settings"
          type="button"
          onClick={props.onCollapse}
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      <label className="field">
        <span><Server size={14} /> Base URL</span>
        <input value={props.baseUrl} onChange={(event) => props.setBaseUrl(event.target.value)} placeholder="https://host/v1" />
      </label>
      <label className="field">
        <span><KeyRound size={14} /> API key</span>
        <input value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} type="password" placeholder="optional" />
      </label>
      <label className="field">
        <span>Model</span>
        <input value={props.model} onChange={(event) => props.setModel(event.target.value)} placeholder="provider/model-name" />
      </label>
      <div className="bench-number-grid">
        <label className="field">
          <span>Max tokens</span>
          <input value={props.maxTokens} min={256} step={256} type="number" onChange={(event) => props.setMaxTokens(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Timeout</span>
          <input value={props.timeoutSeconds} min={1} type="number" onChange={(event) => props.setTimeoutSeconds(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Parallel</span>
          <input value={props.parallelTasks} min={1} max={64} type="number" onChange={(event) => props.setParallelTasks(normalizeParallelTasks(Number(event.target.value)))} />
        </label>
        <label className="field">
          <span>Passes</span>
          <input value={props.passCount} min={1} max={100} type="number" onChange={(event) => props.setPassCount(normalizePassCount(Number(event.target.value)))} />
        </label>
        <label className="field">
          <span>Start</span>
          <input value={props.startIndex} min={0} max={163} type="number" onChange={(event) => props.setStartIndex(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Limit</span>
          <input value={props.sampleLimit} min={0} max={164} type="number" onChange={(event) => props.setSampleLimit(Number(event.target.value))} />
        </label>
      </div>
      <label className="field">
        <span><FileText size={14} /> Test numbers</span>
        <textarea
          value={props.testNumbers}
          onChange={(event) => props.setTestNumbers(event.target.value)}
          rows={3}
          placeholder="0, 1, 2 or 10-25. Empty uses start/limit."
        />
      </label>
      <label className="field">
        <span><Settings2 size={14} /> System prompt</span>
        <textarea value={props.systemPrompt} onChange={(event) => props.setSystemPrompt(event.target.value)} rows={5} />
      </label>
      <label className="field">
        <span><FileText size={14} /> Prompt template</span>
        <textarea
          value={props.promptTemplate}
          onChange={(event) => props.setPromptTemplate(event.target.value)}
          rows={11}
          placeholder="Use %problem_code% where the HumanEval function stub should be inserted."
        />
      </label>
      <label className="field">
        <span><Settings2 size={14} /> Extra request body</span>
        <textarea value={props.extraBody} onChange={(event) => props.setExtraBody(event.target.value)} rows={5} />
      </label>
      <div className="bench-warning">
        Executes model-generated Python locally. Use a dedicated sandbox for untrusted endpoints.
      </div>
      <div className="bench-actions">
        <button className="primary-action" type="button" onClick={props.onStartRun} disabled={!props.model.trim()}>
          <Play size={17} /> Start run
        </button>
        <button className="secondary-action" type="button" onClick={props.onResumeRun} disabled={!runCanResume(props.selectedRun)}>
          <RotateCcw size={17} /> Resume
        </button>
        <button className="secondary-action" type="button" onClick={props.onCancelRun} disabled={!statusIsLive(props.selectedRun?.status)}>
          <CircleStop size={17} /> Stop selected
        </button>
      </div>
      {props.error ? <p className="bench-error">{props.error}</p> : null}
    </aside>
  );
}

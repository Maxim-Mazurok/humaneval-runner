import { PanelLeftOpen } from "lucide-react";
import { MetricsPanel } from "./components/MetricsPanel";
import { PassVariabilityChart } from "./components/PassVariabilityChart";
import { RunStrip } from "./components/RunStrip";
import { SidebarConfig } from "./components/SidebarConfig";
import { StatusSummary } from "./components/StatusSummary";
import { TaskResults } from "./components/TaskResults";
import { useBenchmarkController } from "./hooks/useBenchmarkController";

export default function App() {
  const {
    baseUrl,
    apiKey,
    model,
    maxTokens,
    timeoutSeconds,
    parallelTasks,
    passCount,
    sampleLimit,
    startIndex,
    testNumbers,
    systemPrompt,
    promptTemplate,
    extraBody,
    runs,
    selectedRunId,
    selectedRun,
    selectedScoreRange,
    selectedProgressSegments,
    selectedThinkingStats,
    selectedRunNotificationsEnabled,
    selectedLiveEstimate,
    selectedSpeedStats,
    tokensByAttempt,
    promptInfoByAttempt,
    taskGroups,
    error,
    expanded,
    sidebarCollapsed,
    selectedPassByTask,
    commentSignalThreshold,
    setBaseUrl,
    setApiKey,
    setModel,
    setMaxTokens,
    setTimeoutSeconds,
    setParallelTasks,
    setPassCount,
    setSampleLimit,
    setStartIndex,
    setTestNumbers,
    setSystemPrompt,
    setPromptTemplate,
    setExtraBody,
    setExpanded,
    setSidebarCollapsed,
    setSelectedPassByTask,
    setCommentSignalThreshold,
    toggleNotificationsForRun,
    navigateTo,
    selectNewBench,
    startRun,
    cancelRun,
    deleteRun,
    copyNumbers,
    copyThinkingNumbers,
  } = useBenchmarkController();

  return (
    <main className={sidebarCollapsed ? "bench-shell sidebar-collapsed" : "bench-shell"}>
      {sidebarCollapsed ? (
        <button
          aria-label="Expand benchmark settings"
          className="sidebar-float-toggle"
          title="Expand settings"
          type="button"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeftOpen size={21} />
        </button>
      ) : (
        <SidebarConfig
          baseUrl={baseUrl}
          apiKey={apiKey}
          model={model}
          maxTokens={maxTokens}
          timeoutSeconds={timeoutSeconds}
          parallelTasks={parallelTasks}
          passCount={passCount}
          sampleLimit={sampleLimit}
          startIndex={startIndex}
          testNumbers={testNumbers}
          systemPrompt={systemPrompt}
          promptTemplate={promptTemplate}
          extraBody={extraBody}
          selectedRun={selectedRun}
          error={error}
          onCollapse={() => setSidebarCollapsed(true)}
          onStartRun={startRun}
          onCancelRun={cancelRun}
          setBaseUrl={setBaseUrl}
          setApiKey={setApiKey}
          setModel={setModel}
          setMaxTokens={setMaxTokens}
          setTimeoutSeconds={setTimeoutSeconds}
          setParallelTasks={setParallelTasks}
          setPassCount={setPassCount}
          setSampleLimit={setSampleLimit}
          setStartIndex={setStartIndex}
          setTestNumbers={setTestNumbers}
          setSystemPrompt={setSystemPrompt}
          setPromptTemplate={setPromptTemplate}
          setExtraBody={setExtraBody}
        />
      )}

      <section className="bench-main">
        <RunStrip
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectNew={selectNewBench}
          onNavigate={navigateTo}
          onDelete={deleteRun}
        />
        <StatusSummary
          selectedRun={selectedRun}
          selectedScoreRange={selectedScoreRange}
          selectedProgressSegments={selectedProgressSegments}
        />
        <MetricsPanel
          selectedRun={selectedRun}
          selectedThinkingStats={selectedThinkingStats}
          commentSignalThreshold={commentSignalThreshold}
          selectedLiveEstimate={selectedLiveEstimate}
          selectedSpeedStats={selectedSpeedStats}
          selectedRunNotificationsEnabled={selectedRunNotificationsEnabled}
          setCommentSignalThreshold={setCommentSignalThreshold}
          onCopyNumbers={copyNumbers}
          onCopyThinkingNumbers={copyThinkingNumbers}
          onToggleNotifications={toggleNotificationsForRun}
        />
        <PassVariabilityChart run={selectedRun} />
        <TaskResults
          taskGroups={taskGroups}
          selectedRun={selectedRun}
          tokensByAttempt={tokensByAttempt}
          promptInfoByAttempt={promptInfoByAttempt}
          expanded={expanded}
          selectedPassByTask={selectedPassByTask}
          commentSignalThreshold={commentSignalThreshold}
          setExpanded={setExpanded}
          setSelectedPassByTask={setSelectedPassByTask}
        />
      </section>
    </main>
  );
}

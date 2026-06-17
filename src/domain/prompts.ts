import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_SYSTEM_PROMPT, type BenchRun } from "./benchmark";

export function formatPromptMessages(messages: unknown) {
  if (!Array.isArray(messages)) return undefined;
  const formatted = messages.map((message) => {
    if (!message || typeof message !== "object") return "";
    const role = "role" in message ? String(message.role).toUpperCase() : "MESSAGE";
    const content = "content" in message ? String(message.content) : "";
    return `${role}:\n${content}`;
  }).filter(Boolean);
  return formatted.length ? formatted.join("\n\n") : undefined;
}

export function buildInstructionPromptFallback(run: BenchRun | null, originalPrompt?: string) {
  if (!originalPrompt) return undefined;
  const systemContent = run?.config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userTemplate = run?.config?.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
  const userContent = String(userTemplate || DEFAULT_PROMPT_TEMPLATE).replaceAll("%problem_code%", originalPrompt);
  return `SYSTEM:\n${systemContent}\n\nUSER:\n${userContent}`;
}

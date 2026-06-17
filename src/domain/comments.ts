import type { BenchResult, CommentLineStats, ThinkingCommentSignal } from "./benchmark";
import { normalizeCommentSignalThreshold, pct } from "./runs";

export function thresholdRatio(thresholdPercent: number) {
  return normalizeCommentSignalThreshold(thresholdPercent) / 100;
}

export function countPythonCommentLines(source: string): CommentLineStats {
  const lines = String(source || "").split(/\r?\n/);
  let commentLines = 0;
  let codeLines = 0;
  let blankLines = 0;
  let leadingCommentLines = 0;
  let seenCode = false;
  let tripleQuote: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines += 1;
      continue;
    }

    if (tripleQuote) {
      commentLines += 1;
      if (line.includes(tripleQuote)) tripleQuote = null;
      continue;
    }

    const docstringDelimiter = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
    if (docstringDelimiter) {
      commentLines += 1;
      if (!seenCode) leadingCommentLines += 1;
      if (trimmed.indexOf(docstringDelimiter, 3) === -1) tripleQuote = docstringDelimiter;
      continue;
    }

    let hasComment = false;
    let hasCodeBeforeComment = false;
    let cursor = 0;
    let lineContinuesString = Boolean(tripleQuote);
    let quote: string | null = null;
    let escaped = false;
    while (cursor < line.length) {
      if (tripleQuote) {
        const end = line.indexOf(tripleQuote, cursor);
        if (end === -1) break;
        cursor = end + 3;
        tripleQuote = null;
        lineContinuesString = false;
        continue;
      }

      const char = line[cursor];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        cursor += 1;
        continue;
      }

      const triple = line.slice(cursor, cursor + 3);
      if (triple === "'''" || triple === '"""') {
        const end = line.indexOf(triple, cursor + 3);
        if (end === -1) {
          tripleQuote = triple;
          lineContinuesString = true;
          break;
        }
        cursor = end + 3;
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        cursor += 1;
        continue;
      }

      if (char === "#") {
        hasComment = true;
        hasCodeBeforeComment = line.slice(0, cursor).trim().length > 0;
        break;
      }

      cursor += 1;
    }

    if (tripleQuote || lineContinuesString) {
      codeLines += 1;
      seenCode = true;
      continue;
    }

    if (hasComment) {
      commentLines += 1;
      if (hasCodeBeforeComment) {
        codeLines += 1;
        seenCode = true;
      } else if (!seenCode) {
        leadingCommentLines += 1;
      }
      continue;
    }

    codeLines += 1;
    seenCode = true;
  }

  return { commentLines, codeLines, blankLines, leadingCommentLines };
}

function normalizedPromptLine(line: string) {
  return line
    .trim()
    .replace(/'''/g, '"""')
    .replace(/\s+/g, " ");
}

function sourceFunctionName(source: string) {
  return source.match(/\bdef\s+([A-Za-z_]\w*)\s*\(/)?.[1] ?? null;
}

function promptHasFunctionDocstring(originalPrompt: string, functionName: string) {
  const lines = originalPrompt.split(/\r?\n/);
  const defIndex = lines.findIndex((line) => line.match(new RegExp(`\\bdef\\s+${functionName}\\s*\\(`)));
  if (defIndex === -1) return false;
  let cursor = defIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const firstBodyLine = lines[cursor]?.trim() || "";
  return firstBodyLine.startsWith('"""') || firstBodyLine.startsWith("'''");
}

function generatedTailAfterPromptDocstring(extractedCode: string, originalPrompt: string, entryPoint?: string) {
  const functionName = entryPoint || sourceFunctionName(originalPrompt);
  if (!functionName || !promptHasFunctionDocstring(originalPrompt, functionName)) {
    return null;
  }

  const lines = extractedCode.split(/\r?\n/);
  const defIndex = lines.findIndex((line) => line.match(new RegExp(`\\bdef\\s+${functionName}\\s*\\(`)));
  if (defIndex === -1) return null;

  let cursor = defIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const firstBodyLine = lines[cursor]?.trim() || "";
  const delimiter = firstBodyLine.startsWith('"""') ? '"""' : firstBodyLine.startsWith("'''") ? "'''" : null;
  if (!delimiter) return null;

  if (firstBodyLine.indexOf(delimiter, 3) !== -1) {
    return lines.slice(cursor + 1).join("\n");
  }

  cursor += 1;
  while (cursor < lines.length) {
    if (lines[cursor].includes(delimiter)) return lines.slice(cursor + 1).join("\n");
    cursor += 1;
  }

  return null;
}

export function generatedTail(extractedCode: string, originalPrompt: string, entryPoint?: string) {
  if (!extractedCode || !originalPrompt) return extractedCode;
  const tailAfterDocstring = generatedTailAfterPromptDocstring(extractedCode, originalPrompt, entryPoint);
  if (tailAfterDocstring !== null) return tailAfterDocstring;
  if (extractedCode.startsWith(originalPrompt)) return extractedCode.slice(originalPrompt.length);

  const promptLines = originalPrompt.split(/\r?\n/);
  const extractedLines = extractedCode.split(/\r?\n/);
  const comparablePromptLines = promptLines.filter((line) => normalizedPromptLine(line)).length;
  const maxMismatches = Math.max(2, Math.ceil(comparablePromptLines * 0.15));
  const minMatchRatio = 0.6;
  let promptIndex = 0;
  let extractedIndex = 0;
  let matched = 0;
  let mismatches = 0;
  let candidateEndLine = 0;
  let lastMatchedEndLine = 0;

  while (promptIndex < promptLines.length && extractedIndex < extractedLines.length) {
    const promptLine = normalizedPromptLine(promptLines[promptIndex]);
    const extractedLine = normalizedPromptLine(extractedLines[extractedIndex]);

    if (!promptLine) {
      promptIndex += 1;
      if (!extractedLine) {
        extractedIndex += 1;
        candidateEndLine = extractedIndex;
      }
      continue;
    }

    if (!extractedLine) {
      extractedIndex += 1;
      candidateEndLine = extractedIndex;
      continue;
    }

    if (promptLine === extractedLine) {
      promptIndex += 1;
      extractedIndex += 1;
      matched += 1;
      candidateEndLine = extractedIndex;
      lastMatchedEndLine = extractedIndex;
      continue;
    }

    if (mismatches < maxMismatches) {
      promptIndex += 1;
      extractedIndex += 1;
      mismatches += 1;
      candidateEndLine = extractedIndex;
      continue;
    }

    break;
  }

  const matchRatio = comparablePromptLines ? matched / comparablePromptLines : 0;
  if (promptIndex >= promptLines.length && matchRatio >= minMatchRatio) {
    return extractedLines.slice(candidateEndLine).join("\n");
  }
  if (matchRatio >= minMatchRatio) {
    return extractedLines.slice(lastMatchedEndLine).join("\n");
  }
  return extractedCode;
}

export function analyzeThinkingComments(result?: BenchResult): ThinkingCommentSignal | undefined {
  if (!result) return undefined;
  const originalPrompt = result.prompt || "";
  const extractedCode = result.extractedCode || "";
  const originalStats = countPythonCommentLines(originalPrompt);
  const generatedSegment = generatedTail(extractedCode, originalPrompt, result.entryPoint);
  const generatedStats = countPythonCommentLines(generatedSegment);
  const addedCommentLines = generatedStats.commentLines;
  const commentRatio = generatedStats.codeLines
    ? generatedStats.commentLines / generatedStats.codeLines
    : generatedStats.commentLines
      ? 1
      : 0;

  return {
    commentLines: generatedStats.commentLines,
    codeLines: generatedStats.codeLines,
    originalCommentLines: originalStats.commentLines,
    generatedCommentLines: generatedStats.commentLines,
    generatedCodeLines: generatedStats.codeLines,
    addedCommentLines,
    leadingCommentLines: generatedStats.leadingCommentLines,
    commentRatio
  };
}

export function commentSignalIsFlagged(signal: ThinkingCommentSignal | undefined, thresholdPercent: number) {
  if (!signal) return false;
  return signal.generatedCommentLines > 0 && signal.commentRatio >= thresholdRatio(thresholdPercent);
}

export function commentSignalReasons(signal: ThinkingCommentSignal, thresholdPercent: number) {
  if (!commentSignalIsFlagged(signal, thresholdPercent)) return [];
  return [
    `extra comment density meets threshold (${signal.generatedCommentLines}/${signal.generatedCodeLines || 0}, threshold ${normalizeCommentSignalThreshold(thresholdPercent)}%)`
  ];
}

export function thinkingInCommentsStats(results: BenchResult[] = [], thresholdPercent: number) {
  const flagged = results.filter((result) => commentSignalIsFlagged(analyzeThinkingComments(result), thresholdPercent)).length;
  return { flagged, total: results.length };
}

export function formatCommentSignal(signal: ThinkingCommentSignal | undefined, thresholdPercent: number) {
  if (!signal) return "No thinking-in-comments signal recorded for this result.";
  const flagged = commentSignalIsFlagged(signal, thresholdPercent);
  const reasons = commentSignalReasons(signal, thresholdPercent);
  const lines = [
    flagged ? "FLAGGED: generated comments look like thinking." : "OK: generated comments are below the threshold.",
    `Threshold: ${normalizeCommentSignalThreshold(thresholdPercent)}%`,
    `Original task comment lines: ${signal.originalCommentLines}`,
    `Extra comment lines: ${signal.generatedCommentLines}`,
    `Generated code lines: ${signal.generatedCodeLines}`,
    `Added comment lines: ${signal.addedCommentLines}`,
    `Extra comment/code ratio: ${pct(signal.commentRatio)}`
  ];
  if (reasons.length) {
    lines.push("", "Reasons:", ...reasons.map((reason) => `- ${reason}`));
  }
  return lines.join("\n");
}

export function thinkingResultNumbers(resultsRun: { results: BenchResult[] } | null, flagged: boolean, thresholdPercent: number) {
  return (resultsRun?.results ?? [])
    .filter((result) => commentSignalIsFlagged(analyzeThinkingComments(result), thresholdPercent) === flagged)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}

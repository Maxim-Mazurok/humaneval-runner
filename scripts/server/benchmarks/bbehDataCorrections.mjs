import { createHash } from "node:crypto";

export const bbehOfficialDataRevision = "80d12ca";
export const bbehDataRevision = `${bbehOfficialDataRevision}+linguini-single-blank-v1`;

const malformedLinguiniPromptFingerprint = "541170b4582e970f57a200368009849f0cb86f370f16bfaae83b01afdfd92948";
const malformedLinguiniSectionStart = "\n\nFill the blanks (1-10):\n\n";
const malformedLinguiniCorrections = new Map([
  ["bbeh_mini/14", { expectedTarget: "ahɨka", selectedPromptLine: "(9) | it is being sewn, woven" }],
  ["bbeh_mini/258", { expectedTarget: "it was opened", selectedPromptLine: "aplaʔ | (3)" }],
  ["bbeh_linguini/41", { expectedTarget: "pirinʼ", selectedPromptLine: "(5) | I saw (it)" }],
  ["bbeh_linguini/121", { expectedTarget: "I left", selectedPromptLine: "herʼoŋ | (1)" }],
  ["bbeh_linguini/139", { expectedTarget: "ahɨka", selectedPromptLine: "(9) | it is being sewn, woven" }],
  ["bbeh_linguini/146", { expectedTarget: "ʂurʼuy", selectedPromptLine: "(8) | I leap" }],
  ["bbeh_linguini/157", { expectedTarget: "kʼaaniʔ", selectedPromptLine: "(7) | it was trapped" }],
  ["bbeh_linguini/159", { expectedTarget: "it was opened", selectedPromptLine: "aplaʔ | (3)" }],
  ["bbeh_linguini/185", { expectedTarget: "ɨmpʼɨhanaʔ", selectedPromptLine: "(6) | I plant (it)" }]
]);

function calculatePromptFingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function applyBbehDataCorrection(problem) {
  const correction = malformedLinguiniCorrections.get(problem.task_id);
  if (!correction) return problem;

  if (problem.target !== correction.expectedTarget) {
    throw new Error(
      `BBEH correction for ${problem.task_id} expected target "${correction.expectedTarget}", `
      + `but found "${problem.target}".`
    );
  }
  if (calculatePromptFingerprint(problem.prompt) !== malformedLinguiniPromptFingerprint) {
    throw new Error(`BBEH correction source prompt changed for ${problem.task_id}.`);
  }

  const sectionStartIndex = problem.prompt.indexOf(malformedLinguiniSectionStart);
  if (sectionStartIndex < 0 || problem.prompt.indexOf(malformedLinguiniSectionStart, sectionStartIndex + 1) >= 0) {
    throw new Error("Malformed Linguini prompt does not contain exactly one expected fill-blanks section.");
  }
  if (problem.prompt.split(correction.selectedPromptLine).length !== 2) {
    throw new Error(`Malformed Linguini prompt does not contain exactly one selected row "${correction.selectedPromptLine}".`);
  }

  return {
    ...problem,
    prompt: [
      problem.prompt.slice(0, sectionStartIndex),
      "",
      "Fill the single blank:",
      "",
      correction.selectedPromptLine,
      "",
      "Return only the missing entry."
    ].join("\n")
  };
}
// Faithful JavaScript port of the official BBEH evaluation logic:
// https://github.com/google-deepmind/bbeh/blob/main/bbeh/evaluate.py

function stripLatex(response) {
  if (response.startsWith("$") && response.endsWith("$")) {
    response = response.slice(1, -1);
  }
  if (response.includes("boxed{") && response.endsWith("}")) {
    response = response.slice(0, -1).split("boxed{")[1];
  }
  if (response.includes("text{") && response.endsWith("}")) {
    response = response.slice(0, -1).split("text{")[1];
  }
  if (response.includes("texttt{") && response.endsWith("}")) {
    response = response.slice(0, -1).split("texttt{")[1];
  }
  return response;
}

export function extractAnswer(sample) {
  const answerPrefixes = [
    "The answer is:",
    "The final answer is ",
    "The final answer is: ",
    "The answer is "
  ];
  let answer = sample;
  for (const answerPrefix of answerPrefixes) {
    if (answer.includes(answerPrefix)) {
      const parts = answer.split(answerPrefix);
      answer = parts[parts.length - 1].trim();
    }
  }
  if (answer.endsWith(".")) {
    answer = answer.slice(0, -1);
  }
  if (answer.startsWith("<") && answer.endsWith(">")) {
    answer = answer.slice(1, -1).trim();
  }
  return stripLatex(answer);
}

// Mirrors Python float() acceptance for benchmark targets: optional sign,
// decimal or scientific notation, inf/infinity, PEP 515 underscore digit
// separators, Unicode decimal digits, and overflow to Infinity. Rejects empty
// strings and hex, which Number() would otherwise coerce surprisingly.
function parseNumber(value) {
  let trimmed = value.trim();
  const infinity = trimmed.match(/^([+-]?)(inf|infinity)$/i);
  if (infinity) return infinity[1] === "-" ? -Infinity : Infinity;
  // Fold Unicode decimal digits (any Nd) to ASCII, as Python float() accepts
  // them. Digits within a run map via their decimal digit value.
  trimmed = [...trimmed].map((character) => {
    if (/\p{Nd}/u.test(character)) {
      const digitValue = digitValueOf(character);
      if (digitValue !== null) return String(digitValue);
    }
    return character;
  }).join("");
  // PEP 515: underscores allowed only between digits.
  if (/\d_\d/.test(trimmed) && !/__|^_|_$|_[.eE]|[.eE+-]_/.test(trimmed)) {
    trimmed = trimmed.replaceAll("_", "");
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  // Python float() overflows large literals to inf instead of rejecting them.
  return Number.isNaN(parsed) ? null : parsed;
}

// Decimal digit value of a Unicode Nd character. Nd characters sit in
// zero-first runs of ten, so the offset from the run start is the value.
function digitValueOf(character) {
  const codePoint = character.codePointAt(0);
  for (let offset = 0; offset <= 9; offset += 1) {
    const previous = codePoint - offset - 1;
    if (previous < 0 || !/\p{Nd}/u.test(String.fromCodePoint(previous))) return offset;
  }
  return null;
}

export function fuzzyMatch(prediction, reference) {
  if (prediction === reference) return true;

  // (a) vs a — use code points, matching Python len()/indexing semantics.
  const predictionPoints = [...prediction];
  const referencePoints = [...reference];
  if (predictionPoints.length === 3 && predictionPoints[0] === "(" && predictionPoints[2] === ")") {
    return predictionPoints[1] === reference;
  }
  if (referencePoints.length === 3 && referencePoints[0] === "(" && referencePoints[2] === ")") {
    return referencePoints[1] === prediction;
  }

  // Numbers
  const predictionNumber = parseNumber(prediction);
  const referenceNumber = parseNumber(reference);
  if (predictionNumber !== null && referenceNumber !== null && predictionNumber === referenceNumber) {
    return true;
  }

  // quote issues
  if (prediction.replaceAll("'", "") === reference.replaceAll("'", "")) return true;

  // Bracket issues
  if (`[${reference}]` === prediction || `[${prediction}]` === reference) return true;

  // Question mark issues
  if (prediction.endsWith("?") && prediction.slice(0, -1) === reference) return true;

  return false;
}

export function preprocessSample(sample) {
  let prediction = extractAnswer(sample.trim()).toLowerCase();
  prediction = prediction.replaceAll(", ", ",").replaceAll("**", "");
  prediction = prediction.split("\n")[0];
  prediction = prediction.endsWith(".") ? prediction.slice(0, -1) : prediction;
  return prediction;
}

export function preprocessReference(reference) {
  return reference.trim().toLowerCase().replaceAll(", ", ",");
}

export function evaluateCorrectness(sample, reference) {
  const prediction = preprocessSample(sample);
  return fuzzyMatch(prediction, preprocessReference(reference));
}

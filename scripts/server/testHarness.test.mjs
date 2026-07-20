// @vitest-environment node
import { describe, expect, it } from "vitest";
import { executeTests } from "./testHarness.mjs";

const problem = {
  entry_point: "candidate",
  test: "def check(candidate):\n    assert candidate() == 1\n"
};

describe("HumanEval test harness", () => {
  it("records a timeout when the candidate never returns", async () => {
    const result = await executeTests(problem, "def candidate():\n    while True:\n        pass", 0.05);

    expect(result).toMatchObject({
      passed: false,
      tests: [],
      error: "Execution timed out after 0.05s",
      timeout: true
    });
  });

  it("returns assertion results for a completed candidate", async () => {
    const result = await executeTests(problem, "def candidate():\n    return 1", 1);

    expect(result).toMatchObject({
      passed: true,
      timeout: false,
      tests: [{ passed: true }],
      error: null
    });
  });
});

# Benchmark Run Analysis - 2026-07-28

## Scope

This report analyzes saved benchmark artifacts rather than only the curated
scores in `RESULTS.md`. For representative failures, it compares the task
prompt, hidden test ledger, generated code or answer, captured reasoning, and
the cached HumanEval canonical solution.

The primary complete HumanEval runs examined were:

| Model | Run ID | Attempts | Passed | Result |
| --- | --- | ---: | ---: | ---: |
| Qwen3.6-27B-MXFP4 | `he-mrs00907-tdlsv5` | 492 | 486 | 98.8% |
| gpt-oss-20b-MXFP4-Q8 | `he-mrxa805p-xohsmn` | 492 | 474 | 96.3% |
| google/gemma-4-12b | `he-mqgj5by3-94ae0h` | 164 | 162 | 98.8% |

The first two use three passes at temperature zero. Their task-level outcomes
were fully deterministic in the saved artifacts:

| Model | Always passed | Always failed | Mixed across three passes |
| --- | ---: | ---: | ---: |
| Qwen3.6-27B-MXFP4 | 162 | 2 | 0 |
| gpt-oss-20b-MXFP4-Q8 | 158 | 6 | 0 |

Therefore the three-pass runs did not provide a pass@k improvement. They
repeated the same task outcomes three times.

Cancelled or partial runs are not included in model rankings. For example,
the Gemma-4-26B QAT run completed 257 of 492 planned attempts, with 217 passes.
Its 84.4% live score describes completed work, while its 44.1% final score uses
all planned attempts as the denominator. These measure different things and
should not be presented as interchangeable accuracy figures.

## Extraction and Harness Check

The non-mutating output-only extraction audit was run with:

```bash
rtk npm run reanalyze:output-extraction -- --no-execute
```

It scanned 52 HumanEval run directories containing 17,534 stored attempts.
Of 17,341 attempts with enough saved data to re-extract, including 3,414 with a
separate thinking stream, zero extracted candidates changed and the aggregate
pass count remained 5,812. The examined HumanEval failures are consequently
model or task-interpretation failures, not evidence of thinking text being
accidentally executed as code.

The current harness is useful diagnostically: it preserves individual assertion
results, actual values, expected values, tracebacks, raw output, thinking output,
and extracted artifacts. No execution timeouts or harness-only errors occurred
in the two strongest complete runs above; all their misses reached assertions.

## HumanEval Failure Evidence

### Qwen3.6-27B-MXFP4

`HumanEval/134`, `check_if_last_char_is_a_letter`, failed all three passes.
The generated predicate required `len(txt) > 1`, so it returned `False` for
`"A"` even though the official test expects `True`. Its reasoning correctly
identified a final one-letter word as the intended case, but the implementation
only supported that case when a preceding space existed. This is a minimum-input
boundary omission.

`HumanEval/145`, `order_by_points`, also failed all three passes. The reasoning
noticed that the supplied example did not agree with an absolute-value digit sum,
then decided that the example was probably a dataset typo and implemented the
usual `sum(int(digit) for digit in str(abs(number)))` rule. The canonical task
uses a signed-digit sum: the sign is applied to the first digit before summing.
For example, `-12` has score `-1 + 2 = 1`. The supplied example and all official
tests use this convention. This is the clearest observed contract-override
failure: the model detected unusual behavior, then substituted a conventional
interpretation for the demonstrated behavior.

### gpt-oss-20b-MXFP4-Q8

All six failed tasks failed in every pass. Four are especially informative
because the captured reasoning had the right broad plan but the emitted code did
not implement it correctly.

| Task | Observed failure | Root cause |
| --- | --- | --- |
| `HumanEval/10` `make_palindrome` | `"x"` became `"xx"` | The suffix search accepted the empty suffix first, then appended the entire reversed input. This is an off-by-one boundary error. |
| `HumanEval/103` `rounded_avg` | `560, 851` produced binary 705 instead of 706 | The code used floor division. The canonical solution uses Python `round`, whose tie behavior explains both the visible `20, 33 -> 26` example and the hidden half-tie test. |
| `HumanEval/106` `f` | `f(5)` produced `[1, 2, 6, 8, 15]` instead of `[1, 2, 6, 24, 15]` | The running factorial was multiplied only at even indices, computing `2 * 4` instead of `1 * 2 * 3 * 4`. The reasoning itself explicitly stated that index 4 should be 24. |
| `HumanEval/127` `intersection` | `(-1, 1)` intersected with `(0, 4)` returned `YES` instead of `NO` | The code counted integer points with `right - left + 1`. The task's examples and canonical solution define interval length geometrically as `right - left`. |
| `HumanEval/145` `order_by_points` | Negative values were ranked using absolute digit sums | The model invented a descending-index tie breaker, but still missed the actual signed-digit scoring demonstrated by the example. |
| `HumanEval/147` `get_max_triples` | `n = 5` returned 4 instead of 1 | The modular derivation was broadly correct, but the code counted indices congruent to 2 modulo 3 as `n // 3`. There are two such indices in `1..5`, not one. The visible worked example would have caught the translation error. |

The recurring pattern is not lack of a plausible algorithm. It is a missing final
verification step:

- boundary inputs are not executed mentally after code is written;
- examples are sometimes overridden by a preferred standard interpretation;
- a correct derivation is not always carried through to the state update or
  counting formula in code.

### Gemma-4-12B

`HumanEval/140`, `fix_spaces`, treated the presence of any three-space run as a
global mode switch and replaced every space block with `-`. The expected behavior
replaces each run independently: the three leading spaces become `-`, while
single spaces elsewhere become `_`. The observed result was
`-Exa-1-2-2-mple` instead of `-Exa_1_2_2_mple`.

Its other miss was `HumanEval/145`, the same signed-digit convention that caught
Qwen and GPT-OSS. This makes it a useful prompt-design regression target across
models rather than an isolated implementation bug.

## BBEH Observations

BBEH evidence is currently diagnostic, not sufficient for a leaderboard claim.

The completed three-task BBEH Mini run at an 8,192-token limit produced:

- `bbeh_mini/0`: a genuine wrong answer. The model answered `unknown`; the
  target is `pen`. Its reasoning concluded that the triangular-grid position was
  unknowable, indicating a coordinate/path-tracking failure.
- `bbeh_mini/1`: an incomplete answer. The model used all 8,192 completion
  tokens in the reasoning channel, ended with `finishReason: "length"`, and
  emitted no final output. The target is `6`. This should be classified
  separately from a reasoned wrong answer.
- `bbeh_mini/2`: passed with answer `18`.

A later cancelled BBEH Mini run used a 16,384-token limit and completed 55
attempts. It had 10 passes, no empty outputs, no `length` finish reasons, and a
maximum observed completion length of 8,437 tokens. That does not establish
model quality because the run is incomplete, but it does show that the blank
answer above is sensitive to the configured output budget rather than an
intrinsic BBEH answer-extraction failure.

The BBEH result schema has a small diagnostics problem. The normalized answer is
persisted in the code-named `extractedCode` field and in `tests[0].actual`; the
evaluator's `prediction` value is not copied to the saved result object. Scoring
is still correct, but a benchmark-neutral `extractedArtifact` or explicit
`prediction` field would make analysis less error-prone.

## Recommendations

### 1. Run a prompt A/B before changing defaults

Use a short contract-verification instruction in a separate experiment:

```text
Treat every supplied example as an executable part of the specification.
When prose seems inconsistent with an example, implement the demonstrated
behavior instead of substituting a conventional interpretation. Before returning
code, dry-run it against every example and one minimal boundary case when the
solution indexes a sequence, maintains cumulative state, counts a range, or
rounds a value.
```

This directly targets the observed `HumanEval/10`, `103`, `106`, `127`, `134`,
`145`, and `147` failure modes. It is a hypothesis, not a verified improvement.
Tune it on a declared development split and reserve unseen tasks for the reported
comparison; otherwise the benchmark-specific failure analysis becomes prompt
overfitting.

### 2. Stop using repeated temperature-zero passes as a diversity strategy

For these Qwen and GPT-OSS runs, three passes added runtime but recovered zero
tasks. Retain one deterministic baseline pass. If pass@k is desired, use an
explicitly stochastic configuration supported by the endpoint, record the exact
sampling parameters, and report both pass@1 and task-level pass@k separately.

### 3. Add an opt-in verification or repair mode, but score it separately

Several misses would be caught by executing visible examples or a minimal
boundary check after candidate generation. An optional generate-verify-repair
workflow can improve practical task completion, but it is an agentic evaluation,
not a standard HumanEval pass@1 result. Keep its score, tokens, retries, and
latency separate from the baseline benchmark.

### 4. Improve incomplete-output diagnostics

Add a first-class `incomplete-output` result state when a response ends at the
token limit with non-empty reasoning and no final content. Show it separately
from wrong answers and model transport errors in the UI and run summary. Store
output and reasoning character counts with each result so this diagnosis does
not require reading raw transcripts.

For reasoning models, test provider-specific reasoning-budget fields through the
existing Extra request body rather than hard-coding one vendor's field into the
generic OpenAI-compatible runner. Compare a small BBEH slice before a full run.

### 5. Make score coverage impossible to misread

For cancelled runs, visually foreground `passed / completed / planned` and label
the two ratios as completed-attempt accuracy and planned-run coverage. Do not
place a planned-run denominator beside complete-run pass rates without a clear
label.

### 6. Add focused regression tests when the harness changes

- A BBEH response with `finishReason: "length"`, thinking text, and blank final
  output should be summarized as incomplete output.
- Saved BBEH results should persist an explicit normalized prediction field.
- Metrics and task rows should distinguish assertion failures, harness errors,
  and incomplete outputs.
- A cancelled run should render completed-attempt accuracy and planned coverage
  as different metrics.

## Suggested Next Experiments

1. Run one complete HumanEval pass for Qwen3.6-27B and GPT-OSS with the prompt
   A/B instruction above, holding model, quantization, token limit, and timeout
   constant. Compare task-level outcomes, not only attempt totals.
2. If the deterministic baseline improves, run a small, separately labelled
   stochastic pass@k experiment rather than repeating temperature-zero passes.
3. Run 25 to 50 BBEH Mini tasks at the proven 16,384-token budget. Track wrong
   answers, incomplete outputs, and output-format compliance separately.
4. Implement the result-state and metadata changes only after the next sample
   confirms that incomplete answers materially affect BBEH measurements.

## Bottom Line

The strongest HumanEval scores are credible with respect to output extraction:
the archive audit found no score-changing extraction contamination. The remaining
failures are concentrated in contract adherence, boundary handling, and the
last mile from reasoning to code. The highest-leverage next step is a controlled
example-first verification prompt experiment, followed by clearer harness
classification for reasoning-only BBEH truncations.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function pythonHarness(userCode, testCode, entryPoint) {
  return `
import ast, contextlib, io, json, os, sys, tempfile, traceback
os.environ["OMP_NUM_THREADS"] = "1"
USER_CODE = ${JSON.stringify(userCode)}
TEST_CODE = ${JSON.stringify(testCode)}
ENTRY_POINT = ${JSON.stringify(entryPoint)}
records = []

def __he_safe_repr(value):
    try:
        return repr(value)
    except BaseException as exc:
        return f"<repr failed: {exc}>"

def __he_record(source, passed, error=None, traceback_text=None, actual=None, expected=None, operator=None):
    record = {"source": source, "passed": bool(passed), "error": error, "traceback": traceback_text}
    if actual is not None:
        record["actual"] = actual
    if expected is not None:
        record["expected"] = expected
    if operator is not None:
        record["operator"] = operator
    records.append(record)

def __he_compare(left, right, operator):
    if operator == "==":
        return left == right
    if operator == "!=":
        return left != right
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    if operator == "is":
        return left is right
    if operator == "is not":
        return left is not right
    if operator == "in":
        return left in right
    if operator == "not in":
        return left not in right
    return bool(left)

def __he_record_comparison(source, left, right, operator):
    passed = __he_compare(left, right, operator)
    __he_record(source, passed, actual=__he_safe_repr(left), expected=__he_safe_repr(right), operator=operator)

def __he_record_truthy(source, value):
    __he_record(source, bool(value), actual=__he_safe_repr(value), expected="truthy")

class InstrumentAsserts(ast.NodeTransformer):
    _op_names = {
        ast.Eq: "==",
        ast.NotEq: "!=",
        ast.Lt: "<",
        ast.LtE: "<=",
        ast.Gt: ">",
        ast.GtE: ">=",
        ast.Is: "is",
        ast.IsNot: "is not",
        ast.In: "in",
        ast.NotIn: "not in",
    }

    def visit_Assert(self, node):
        source = ast.get_source_segment(TEST_CODE, node) or "assert ..."
        failed_call = ast.Expr(value=ast.Call(func=ast.Name(id="__he_record", ctx=ast.Load()), args=[ast.Constant(source), ast.Constant(False), ast.Call(func=ast.Name(id="str", ctx=ast.Load()), args=[ast.Name(id="__he_exc", ctx=ast.Load())], keywords=[]), ast.Call(func=ast.Attribute(value=ast.Name(id="traceback", ctx=ast.Load()), attr="format_exc", ctx=ast.Load()), args=[], keywords=[])], keywords=[]))

        if isinstance(node.test, ast.Compare) and len(node.test.ops) == 1 and len(node.test.comparators) == 1:
            operator = self._op_names.get(type(node.test.ops[0]), type(node.test.ops[0]).__name__)
            record_call = ast.Expr(value=ast.Call(
                func=ast.Name(id="__he_record_comparison", ctx=ast.Load()),
                args=[
                    ast.Constant(source),
                    node.test.left,
                    node.test.comparators[0],
                    ast.Constant(operator),
                ],
                keywords=[],
            ))
            return ast.Try(body=[record_call], handlers=[ast.ExceptHandler(type=ast.Name(id="BaseException", ctx=ast.Load()), name="__he_exc", body=[failed_call])], orelse=[], finalbody=[])

        record_call = ast.Expr(value=ast.Call(
            func=ast.Name(id="__he_record_truthy", ctx=ast.Load()),
            args=[ast.Constant(source), node.test],
            keywords=[],
        ))
        return ast.Try(body=[record_call], handlers=[ast.ExceptHandler(type=ast.Name(id="BaseException", ctx=ast.Load()), name="__he_exc", body=[failed_call])], orelse=[], finalbody=[])

def reliability_guard():
    import builtins, shutil, subprocess
    builtins.exit = None
    builtins.quit = None
    os.kill = None
    os.system = None
    os.remove = None
    os.removedirs = None
    os.rmdir = None
    os.rename = None
    os.renames = None
    os.truncate = None
    os.replace = None
    os.unlink = None
    shutil.rmtree = None
    shutil.move = None
    subprocess.Popen = None

try:
    reliability_guard()
    ns = {
        "__he_record": __he_record,
        "__he_record_comparison": __he_record_comparison,
        "__he_record_truthy": __he_record_truthy,
        "traceback": traceback,
    }
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(USER_CODE, ns)
        tree = ast.parse(TEST_CODE)
        tree = InstrumentAsserts().visit(tree)
        ast.fix_missing_locations(tree)
        exec(compile(tree, "<humaneval-tests>", "exec"), ns)
        candidate = ns[ENTRY_POINT]
        ns["check"](candidate)
    failed = [record for record in records if not record["passed"]]
    print(json.dumps({
        "passed": len(failed) == 0,
        "tests": records,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "error": None
    }))
except BaseException as exc:
    print(json.dumps({
        "passed": False,
        "tests": records,
        "stdout": locals().get("stdout").getvalue() if "stdout" in locals() else "",
        "stderr": locals().get("stderr").getvalue() if "stderr" in locals() else "",
        "error": str(exc),
        "traceback": traceback.format_exc()
    }))
`;
}

export async function executeTests(problem, code, timeoutSeconds) {
  const directory = await fs.mkdtemp(join(tmpdir(), "humaneval-"));
  const scriptPath = join(directory, "run.py");
  await fs.writeFile(scriptPath, pythonHarness(code, problem.test, problem.entry_point), "utf8");
  return await new Promise((resolveResult) => {
    const child = spawn("python3", [scriptPath], {
      cwd: directory,
      env: { PATH: process.env.PATH || "/usr/bin:/usr/local/bin", LANG: "en_US.UTF-8", HOME: directory }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (timedOut) {
        resolveResult({
          passed: false,
          tests: [],
          stdout,
          stderr,
          error: `Execution timed out after ${timeoutSeconds}s`,
          timeout: true,
          harnessStdout: stdout,
          harnessStderr: stderr
        });
        return;
      }
      const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
      if (!lastLine) {
        const exitDescription = signal ? `signal ${signal}` : `code ${exitCode ?? "unknown"}`;
        resolveResult({
          passed: false,
          tests: [],
          stdout,
          stderr,
          error: `Harness exited without a JSON result (${exitDescription})`,
          timeout: false,
          harnessStdout: stdout,
          harnessStderr: stderr
        });
        return;
      }
      try {
        const parsed = JSON.parse(lastLine);
        resolveResult({ ...parsed, timeout: false, harnessStdout: stdout, harnessStderr: stderr });
      } catch {
        resolveResult({ passed: false, tests: [], stdout, stderr, error: "Harness returned non-JSON output", timeout: false, harnessStdout: stdout, harnessStderr: stderr });
      }
    });
    child.on("error", async (error) => {
      clearTimeout(timeout);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      resolveResult({ passed: false, tests: [], stdout, stderr, error: error.message, timeout: false, harnessStdout: stdout, harnessStderr: stderr });
    });
  });
}

import { spawn } from "node:child_process";

// Spawn a child agent CLI, stream its output, capture the full text.
// Always shell: false — the prompt is one argv element, so no shell injection.
//
// opts:
//   bin      - executable name (resolved on PATH)
//   args     - argv array (already includes the prompt as one element)
//   cwd      - working directory for the child
//   timeout  - ms before we kill the child (0 / falsy = no timeout)
//   onData   - (chunk:string) => void, live stdout for streaming UIs
//
// Resolves to { ok, stdout, stderr, code, error } and never rejects, so the
// orchestrator can keep going and show a friendly message.
export function runAgent({ bin, args = [], cwd, timeout = 0, onData } = {}) {
  return new Promise((resolve) => {
    if (stopping) {
      resolve({ ok: false, stdout: "", stderr: "", code: null, error: "Run was stopped." });
      return;
    }
    let child;
    try {
      // stdin is closed: the prompt travels in argv, and a CLI that sees an
      // open stdin pipe (codex exec) waits on it forever.
      child = spawn(bin, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve(spawnFailure(bin, err));
      return;
    }
    active.add(child);
    // Decode as a stream so a multibyte char split across chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);
    }

    child.stdout.on("data", (text) => {
      stdout += text;
      if (onData) onData(text);
    });
    child.stderr.on("data", (text) => {
      stderr += text;
    });

    // ENOENT etc. arrive as an "error" event, not a throw.
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      active.delete(child);
      resolve(spawnFailure(bin, err));
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      active.delete(child);
      if (timedOut) {
        resolve({
          ok: false,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code,
          error: `Agent "${bin}" timed out after ${timeout} ms.`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
        error:
          code === 0
            ? null
            : `Agent "${bin}" ${
                signal ? `was stopped (${signal})` : `exited with code ${code}`
              }.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
      });
    });
  });
}

// The models an agent has installed, via its "listModels" command (ollama:
// `list`), which prints a header row then one model per line, name first.
// Empty when the agent cannot list models or the command fails.
export async function installedModels(adapter, runner = runAgent) {
  if (!adapter.listModels) return [];
  const res = await runner({ bin: adapter.bin, args: adapter.listModels, timeout: 30000 });
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// The model to use when a role names none, for agents that cannot run without
// one (ollama): the first model the agent's "listModels" command prints — a
// header row, then one model per line, name first. Throws if there is none.
export async function defaultModel(agent, adapter, runner = runAgent) {
  const [first] = await installedModels(adapter, runner);
  if (!first) {
    throw new Error(
      `Agent "${agent}" was given no model and has none installed to default to. ` +
        `Install one (for ollama: ollama pull qwen2.5-coder) or set a model.`
    );
  }
  return first;
}

// Preflight for agents with a "modelCheck" argv template (ollama: `show
// {model}`): does the agent actually have this model? Returns null when fine
// or when there is nothing to check, else a message saying what is missing.
export async function modelProblem(agent, adapter, model, runner = runAgent) {
  if (!adapter.modelCheck || !model) return null;
  const args = adapter.modelCheck.map((a) => a.split("{model}").join(model));
  const res = await runner({ bin: adapter.bin, args, timeout: 30000 });
  if (res.ok) return null;
  return (
    `Agent "${agent}" does not have model "${model}" ` +
    `(checked with: ${[adapter.bin, ...args].join(" ")}). ` +
    `Install it first — for ollama: ollama pull ${model}. ${res.error}`
  );
}

// Children currently running, so a stop can take them down with us.
const active = new Set();
let stopping = false;

// Stop the run: terminate every running agent and refuse to start new ones.
// Without this, killing sethji orphans the agent CLI, which keeps editing files.
// ponytail: SIGTERM to the direct child only; an agent that ignores it or has
// its own grandchildren survives — spawn detached + kill the process group if
// that shows up.
export function stopAgents() {
  stopping = true;
  for (const child of active) child.kill("SIGTERM");
}

// Turn a spawn-time error into a friendly, actionable result.
function spawnFailure(bin, err) {
  const notFound = err && err.code === "ENOENT";
  return {
    ok: false,
    stdout: "",
    stderr: "",
    code: null,
    error: notFound
      ? `"${bin}" not found on PATH. Install its CLI (or fix the "bin" in your crew config), then try again.`
      : `Could not start "${bin}": ${err && err.message ? err.message : err}`,
  };
}

// Create a fresh git work branch (sethji/run-<stamp>) so a bad crew run is
// one `git checkout -` away from clean. Best-effort by design: returns the
// branch name, or null when not in a git repo, git is missing, or we're
// already on a sethji/* branch (loop rounds must not stack branches).
export async function createWorkBranch(cwd = ".") {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = (args) => promisify(execFile)("git", args, { cwd });
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
    const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (stdout.trim().startsWith("sethji/")) return null;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15)
      .replace("T", "-");
    const suffix = Math.random().toString(36).slice(2, 6);
    const name = `sethji/run-${stamp}-${suffix}`;
    await git(["checkout", "-b", name]);
    return name;
  } catch {
    return null;
  }
}

// Is a CLI installed? Spawn `<bin> --version`; ENOENT => not found.
export function isInstalled(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["--version"], { shell: false });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

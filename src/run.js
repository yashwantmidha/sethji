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
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: false });
    } catch (err) {
      resolve(spawnFailure(bin, err));
      return;
    }

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

    child.stdout.on("data", (buf) => {
      const text = buf.toString();
      stdout += text;
      if (onData) onData(text);
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });

    // ENOENT etc. arrive as an "error" event, not a throw.
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve(spawnFailure(bin, err));
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
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
            : `Agent "${bin}" exited with code ${code}.${
                stderr.trim() ? ` ${stderr.trim()}` : ""
              }`,
      });
    });
  });
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

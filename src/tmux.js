import { spawn } from "node:child_process";
import { roleLogPath } from "./logs.js";

// Optional tmux "watch wall": one pane per role, each tailing that role's live
// log file. The orchestrator still spawns the agents and captures their output
// for the transcript — the panes are a read-only mirror, so nothing about the
// run depends on tmux being present.

// Run one tmux command; resolve { ok, code }. Never rejects.
function tmux(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("tmux", args, { shell: false });
    } catch {
      resolve({ ok: false, code: null });
      return;
    }
    child.on("error", () => resolve({ ok: false, code: null }));
    child.on("close", (code) => resolve({ ok: code === 0, code }));
  });
}

// Is tmux on PATH? (`tmux -V` prints a version and exits 0.)
export async function isTmuxAvailable() {
  return (await tmux(["-V"])).ok;
}

// Build a detached session named `session` with a tiled pane per role, each
// running `tail -f <role>.log`. Returns the attach command to show the user.
// Roles must be de-duplicated (one pane per name) before calling.
export async function startWatchWall(session, roles, dir) {
  // Replace any stale session of the same name from a previous run.
  await tmux(["kill-session", "-t", session]);

  // Show a role name above each pane so the wall is readable.
  await tmux(["set-option", "-t", session, "-g", "pane-border-status", "top"]);
  await tmux(["set-option", "-t", session, "-g", "pane-border-format", " #T "]);

  const first = roles[0];
  const created = await tmux([
    "new-session", "-d", "-s", session, "-n", "crew",
    `tail -f "${roleLogPath(dir, first)}"`,
  ]);
  if (!created.ok) return { ok: false };
  await tmux(["select-pane", "-t", session, "-T", first.toUpperCase()]);

  // One split per remaining role, re-tiling so all panes stay visible.
  for (const role of roles.slice(1)) {
    await tmux(["split-window", "-t", session, `tail -f "${roleLogPath(dir, role)}"`]);
    await tmux(["select-pane", "-t", session, "-T", role.toUpperCase()]);
    await tmux(["select-layout", "-t", session, "tiled"]);
  }

  return { ok: true, attach: `tmux attach -t ${session}` };
}

// Tear the wall down (best effort) once the run is done.
export async function stopWatchWall(session) {
  await tmux(["kill-session", "-t", session]);
}

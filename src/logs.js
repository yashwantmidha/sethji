import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Everything sethji writes for a run lives under <cwd>/.sethji/runs/<stamp>/:
//   <role>.log     live, appended as each role streams (tmux panes tail these)
//   transcript.md  the full relay channel, human-readable
//   result.json    { verdict, reason, rounds, roles, ... } the main can check
//
// A "logger" is the small sink the orchestrator calls; tests pass none and get
// the no-op, so logging never touches the unit tests or needs the filesystem.

// Make the run directory and return { dir, stamp }. `stamp` is filesystem-safe.
export function createRunDir(cwd = ".", now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(cwd, ".sethji", "runs", stamp);
  mkdirSync(dir, { recursive: true });
  return { dir, stamp };
}

// Path of a role's live log file (one per role name, appended across loops).
export function roleLogPath(dir, role) {
  return join(dir, `${role}.log`);
}

// A no-op logger: the default, so orchestrate() stays pure for tests.
export const NULL_LOGGER = {
  dir: null,
  roleChunk() {},
  note() {},
  finish() {},
};

// Build a real file-backed logger rooted at `dir`.
// Pre-creates an empty log per role so tmux panes have something to `tail -f`.
export function createLogger(dir, roles = []) {
  for (const role of roles) writeFileSync(roleLogPath(dir, role), "");
  const eventsPath = join(dir, "events.log");

  return {
    dir,
    // Live stream from a role — appended verbatim so panes mirror it.
    roleChunk(role, text) {
      appendFileSync(roleLogPath(dir, role), text);
    },
    // Orchestrator milestones (loop jumps, errors) for an at-a-glance timeline.
    note(text) {
      appendFileSync(eventsPath, text.replace(/\x1b\[[0-9;]*m/g, "") + "\n");
    },
    // Called once at the end: write the readable transcript + machine result.
    finish(result) {
      const md = ["# sethji run", "", `**Verdict:** ${result.verdict}` +
        (result.reason ? ` — ${result.reason}` : ""), `**Loop rounds:** ${result.rounds}`, ""]
        .concat(
          result.transcript.map((t) => `## ${t.role.toUpperCase()}\n\n${t.text}\n`)
        )
        .join("\n");
      writeFileSync(join(dir, "transcript.md"), md);
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify(
          {
            verdict: result.verdict,
            reason: result.reason,
            rounds: result.rounds,
            roles: result.transcript.map((t) => t.role),
          },
          null,
          2
        ) + "\n"
      );
    },
  };
}

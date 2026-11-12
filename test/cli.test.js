// Regression tests for the CLI layer and the failure paths around it.
// Everything runs against test/stub-agent.js — no network, no real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrate } from "../src/orchestrate.js";
import { runAgent } from "../src/run.js";
import { validateCrew } from "../src/config.js";

const STUB = fileURLToPath(new URL("./stub-agent.js", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const NODE = process.execPath;

const stubAdapter = (kind) => ({ bin: NODE, modes: { read: [STUB, kind, "{prompt}"] } });

// A crew whose coder and qa are stub agents of the given kinds.
function stubCrew(coderKind, qaKind) {
  return {
    agents: { coderbot: stubAdapter(coderKind), qabot: stubAdapter(qaKind) },
    roles: {
      coder: { agent: "coderbot", mode: "read", persona: "c" },
      qa: { agent: "qabot", mode: "read", persona: "q" },
    },
    workflow: ["coder", "qa"],
    loop: { from: "qa", to: "coder", maxRounds: 1 },
  };
}

// Fresh temp dir holding crew.json; removed when the test ends.
async function project(t, crew) {
  const dir = await mkdtemp(join(tmpdir(), "sethji-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (crew) await writeFile(join(dir, "crew.json"), JSON.stringify(crew));
  return dir;
}

// Run the CLI; resolve { code, stdout, stderr }. `onStdout` sees live chunks.
function cli(args, { cwd, stdin, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
      if (onStdout) onStdout(stdout, child);
    });
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin || "");
  });
}

// --- agent failure must never read as PASS ---------------------------------
test("orchestrate: a crashed agent ends the run as FAIL", async () => {
  const crew = stubCrew("boom", "pass");
  const result = await orchestrate({ task: "t", crew, color: false, write: () => {} });
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /exited with code 3/);
  // The run stops at the crash; QA never reviews work that was not done.
  assert.deepEqual(result.transcript.map((x) => x.role), ["coder"]);
});

test("orchestrate: a crashed QA is FAIL, not a missing-verdict PASS", async () => {
  const crew = stubCrew("code", "boom");
  const result = await orchestrate({ task: "t", crew, color: false, write: () => {} });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.rounds, 0);
});

test("cli run: missing agent binary exits 1 with ✗ FAIL", async (t) => {
  const crew = stubCrew("code", "pass");
  crew.agents.coderbot.bin = "definitely-not-a-real-bin-xyz";
  const dir = await project(t, crew);
  const res = await cli(["run", "task", "--no-branch", "--no-color"], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /✗ FAIL/);
  assert.match(res.stdout, /not found on PATH/);
});

// --- flag parsing ----------------------------------------------------------
test("cli run: a boolean flag before the task does not swallow it", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const res = await cli(["run", "--no-branch", "the task", "--no-color"], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /✓ PASS/);
});

test("cli run: a non-numeric --timeout is rejected", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const res = await cli(["run", "task", "--no-branch", "--timeout", "abc"], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--timeout/);
});

// --- output decoding -------------------------------------------------------
test("runAgent keeps a multibyte char split across chunks intact", async () => {
  const chunks = [];
  const res = await runAgent({ bin: NODE, args: [STUB, "split"], onData: (c) => chunks.push(c) });
  assert.equal(res.stdout, "✓ ok");
  assert.equal(chunks.join(""), "✓ ok\n");
});

// --- role names become file names and tmux commands ------------------------
test("validateCrew rejects role names that are not plain identifiers", () => {
  for (const bad of ["../escape", 'x"; rm -rf ~; "', "has space"]) {
    const crew = {
      roles: { [bad]: { agent: "claude", mode: "read", persona: "p" } },
      workflow: [bad],
    };
    assert.throws(() => validateCrew(crew), /Role name/, bad);
  }
});

// --- never clobber a crew file silently ------------------------------------
test("cli init: refuses to overwrite, --force overwrites", async (t) => {
  const dir = await project(t);
  const file = join(dir, "crew.json");
  await writeFile(file, "MINE");

  const refused = await cli(["init"], { cwd: dir });
  assert.equal(refused.code, 1);
  assert.equal(await readFile(file, "utf8"), "MINE");

  const forced = await cli(["init", "--force"], { cwd: dir });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(await readFile(file, "utf8"), /"workflow"/);
});

test("cli plan: answering N saves nothing; s saves without running", async (t) => {
  // `plan` drafts with the "claude" agent — point it at the stub drafter.
  const base = {
    agents: { claude: stubAdapter("draft") },
    roles: { solo: { agent: "claude", mode: "read", persona: "p" } },
    workflow: ["solo"],
  };
  const dir = await project(t);
  await writeFile(join(dir, "base.json"), JSON.stringify(base));
  const args = ["plan", "a need", "--crew", "base.json", "--out", "out.json"];

  const no = await cli(args, { cwd: dir, stdin: "n\n" });
  assert.equal(no.code, 0, no.stderr);
  assert.equal(existsSync(join(dir, "out.json")), false);

  const save = await cli(args, { cwd: dir, stdin: "s\n" });
  assert.equal(save.code, 0, save.stderr);
  const saved = JSON.parse(await readFile(join(dir, "out.json"), "utf8"));
  assert.equal(saved.task, "a need");
  assert.equal(existsSync(join(dir, ".sethji")), false, "s must not start a run");
});

// --- stop -----------------------------------------------------------------
test("cli run: SIGTERM stops the agent child and still writes the run log", async (t) => {
  const dir = await project(t, stubCrew("hang", "pass"));
  let pid = null;
  const res = await cli(["run", "task", "--no-branch", "--no-color"], {
    cwd: dir,
    onStdout: (out, child) => {
      const m = out.match(/PID (\d+)/);
      if (m && pid === null) {
        pid = Number(m[1]);
        child.kill("SIGTERM"); // what the menu-bar app's Stop button sends
      }
    },
  });
  assert.ok(pid, "stub agent started");
  assert.equal(res.code, 1);

  // The agent must be gone — not orphaned and still editing files.
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "agent child still running after stop");

  const runs = join(dir, ".sethji", "runs");
  const [stamp] = await readdir(runs);
  const result = JSON.parse(await readFile(join(runs, stamp, "result.json"), "utf8"));
  assert.equal(result.verdict, "FAIL");
});

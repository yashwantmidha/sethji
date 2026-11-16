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

// --- check: QA backed by a real command ------------------------------------
const quiet = { color: false, write: () => {} };
const roles = (result) => result.transcript.map((x) => x.role);

test("check passes: its output reaches QA, verdict stays QA's", async () => {
  const crew = { ...stubCrew("code", "pass"), check: [NODE, STUB, "plan"] };
  const result = await orchestrate({ task: "t", crew, ...quiet });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(roles(result), ["coder", "check", "qa"]);
  assert.match(result.transcript[1].text, /PLAN:[\s\S]*\[exit 0\]/);
});

test("check fails: loops back to the coder without asking QA, ends FAIL", async () => {
  const crew = { ...stubCrew("code", "pass"), check: [NODE, STUB, "boom"] };
  const result = await orchestrate({ task: "t", crew, ...quiet });
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /check failed/);
  assert.equal(result.rounds, 1);
  // QA said PASS in the stub — a failing check must override it by never asking.
  assert.deepEqual(roles(result), ["coder", "check", "coder", "check"]);
  assert.match(result.transcript[1].text, /stub failure[\s\S]*\[exit 3\]/);
});

test("check without a loop runs once at the end and gates the verdict", async () => {
  const crew = { ...stubCrew("code", "pass"), check: [NODE, STUB, "boom"] };
  delete crew.loop;
  const result = await orchestrate({ task: "t", crew, ...quiet });
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(roles(result), ["coder", "qa", "check"]);
});

test("check command that cannot start fails the run without looping", async () => {
  const crew = { ...stubCrew("code", "pass"), check: ["definitely-not-a-real-bin-xyz"] };
  const result = await orchestrate({ task: "t", crew, ...quiet });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.rounds, 0);
  assert.match(result.reason, /not found on PATH/);
  assert.deepEqual(roles(result), ["coder", "check"]);
});

test("validateCrew rejects a check that is not an argv array", () => {
  for (const bad of ["npm test", [], ["npm", 5], [""]]) {
    const crew = { ...stubCrew("code", "pass"), check: bad };
    assert.throws(() => validateCrew(crew), /"check"/, JSON.stringify(bad));
  }
});

test("cli run --check: a failing command exits 1", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const res = await cli(
    ["run", "task", "--no-branch", "--no-color", "--check", `${NODE} ${STUB} boom`],
    { cwd: dir }
  );
  assert.equal(res.code, 1);
  assert.match(res.stdout, /▌ CHECK/);
  assert.match(res.stdout, /✗ FAIL.*check failed/);
});

// --- stdin ----------------------------------------------------------------
test("runAgent gives the child a closed stdin (codex exec waits on an open one)", async () => {
  const res = await runAgent({ bin: NODE, args: [STUB, "stdin"], timeout: 3000 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stdout, "stdin closed");
});

test("cli run: --check without a command is an error, not a run", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const res = await cli(["run", "task", "--no-branch", "--check"], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--check needs a command/);
  assert.equal(existsSync(join(dir, ".sethji")), false);
});

// --- --check quoting -------------------------------------------------------
test("cli run --check: quoted arguments stay one argv element", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const check = `${NODE} -e "console.log('a  b'); process.exit(7)"`;
  const res = await cli(["run", "task", "--no-branch", "--no-color", "--check", check], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /a  b/);
  assert.match(res.stdout, /exited with code 7/);
});

test("cli run --check: an unclosed quote is rejected", async (t) => {
  const dir = await project(t, stubCrew("code", "pass"));
  const res = await cli(["run", "task", "--no-branch", "--check", 'npm "test'], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unclosed/);
});

// --- plan drafts a check ---------------------------------------------------
test("plan prompt asks the drafter for a check command", async () => {
  const { buildPlanPrompt } = await import("../src/plan.js");
  assert.match(buildPlanPrompt("need", "claude"), /check \(optional\)/);
});

test("generateCrew keeps a drafted check and rejects a malformed one", async () => {
  const { generateCrew } = await import("../src/plan.js");
  const draft = (check) => async () => ({
    ok: true,
    stdout: JSON.stringify({
      roles: { solo: { agent: "claude", mode: "read", persona: "p" } },
      workflow: ["solo"],
      check,
    }),
  });
  const crew = await generateCrew("x", { runner: draft(["npm", "test"]) });
  assert.deepEqual(crew.check, ["npm", "test"]);
  await assert.rejects(() => generateCrew("x", { runner: draft("npm test") }), /"check"/);
});

test("cli plan: shows the drafted check before asking to save", async (t) => {
  const base = {
    agents: { claude: stubAdapter("draft") },
    roles: { solo: { agent: "claude", mode: "read", persona: "p" } },
    workflow: ["solo"],
  };
  const dir = await project(t);
  await writeFile(join(dir, "base.json"), JSON.stringify(base));
  const res = await cli(["plan", "a need", "--crew", "base.json", "--out", "out.json"], {
    cwd: dir,
    stdin: "s\n",
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Check: npm test/);
  const saved = JSON.parse(await readFile(join(dir, "out.json"), "utf8"));
  assert.deepEqual(saved.check, ["npm", "test"]);
});

// --- built-in ollama (local models) ----------------------------------------
test("ollama: model goes between `run` and the prompt", async () => {
  const { buildInvocation } = await import("../src/adapters.js");
  const { bin, args } = buildInvocation("ollama", "read", "hi there", undefined, {
    model: "qwen2.5-coder",
  });
  assert.equal(bin, "ollama");
  assert.deepEqual(args, ["run", "--nowordwrap", "qwen2.5-coder", "hi there"]);
});

test("ollama: a model is required, and survives a bin override", async () => {
  const { buildInvocation, mergeAdapters } = await import("../src/adapters.js");
  assert.throws(() => buildInvocation("ollama", "read", "hi"), /needs a model/);
  const merged = mergeAdapters({ ollama: { bin: "/opt/ollama" } });
  assert.throws(() => buildInvocation("ollama", "read", "hi", merged), /needs a model/);
});

test("validateCrew: ollama role may omit the model but cannot be a writer", () => {
  const crew = (role) => ({ roles: { solo: { agent: "ollama", persona: "p", ...role } }, workflow: ["solo"] });
  assert.equal(validateCrew(crew({ model: "llama3.2" })), true);
  assert.equal(validateCrew(crew({})), true); // no model: the default is resolved at run time
  assert.throws(() => validateCrew(crew({ model: "llama3.2", mode: "write" })), /no mode "write"/);
});

test("cli ask --model reaches the agent", async (t) => {
  // Positional model like ollama's: argv becomes [stub, <model>, <prompt>],
  // so the stub's "kind" is whatever --model says.
  const crew = stubCrew("code", "pass");
  crew.agents.bot = { bin: NODE, modelFlag: ["{model}"], modes: { read: [STUB, "{prompt}"] } };
  const dir = await project(t, crew);
  const res = await cli(["ask", "bot", "hello", "--crew", "crew.json", "--model", "plan"], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^PLAN:/);
});

// --- model preflight (ollama would silently download a missing model) ------
// An agent whose "modelCheck" is the stub: model "pass" exits 0, "boom" exits 3.
function checkedCrew(model) {
  return {
    agents: {
      local: {
        bin: NODE,
        modelFlag: ["{model}"],
        modelCheck: [STUB, "{model}"],
        modes: { read: [STUB, "{prompt}"] },
      },
    },
    roles: { solo: { agent: "local", mode: "read", model, persona: "p" } },
    workflow: ["solo"],
  };
}

test("orchestrate: a model the agent does not have fails before any role runs", async () => {
  const result = await orchestrate({ task: "t", crew: checkedCrew("boom"), ...quiet });
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /does not have model "boom"/);
  assert.deepEqual(result.transcript, []);
});

test("orchestrate: a model that passes its check runs normally", async () => {
  const result = await orchestrate({ task: "t", crew: checkedCrew("pass"), ...quiet });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(roles(result), ["solo"]);
});

test("cli ask: a missing model is refused, not run", async (t) => {
  const dir = await project(t, checkedCrew("pass"));
  const res = await cli(["ask", "local", "hi", "--crew", "crew.json", "--model", "boom"], { cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not have model "boom"/);
});

test("built-in ollama checks the model with `ollama show`", async () => {
  const { BUILTIN_ADAPTERS, mergeAdapters } = await import("../src/adapters.js");
  assert.deepEqual(BUILTIN_ADAPTERS.ollama.modelCheck, ["show", "{model}"]);
  assert.deepEqual(mergeAdapters({ ollama: { bin: "/x" } }).ollama.modelCheck, ["show", "{model}"]);
});

// --- default model ---------------------------------------------------------
// An agent like ollama: needs a model, and can list the ones it has. The stub's
// "models" listing names "pass" first, so the default model is "pass".
function listingCrew(listKind) {
  return {
    agents: {
      local: {
        bin: NODE,
        modelFlag: ["{model}"],
        requiresModel: true,
        listModels: [STUB, listKind],
        modes: { read: [STUB, "{prompt}"] },
      },
    },
    roles: { solo: { agent: "local", mode: "read", persona: "p" } },
    workflow: ["solo"],
  };
}

test("orchestrate: a role with no model uses the agent's first installed one", async () => {
  let out = "";
  const result = await orchestrate({
    task: "t",
    crew: listingCrew("models"),
    color: false,
    write: (s) => (out += s),
  });
  assert.equal(result.verdict, "PASS");
  assert.match(result.transcript[0].text, /VERDICT: PASS/); // ran as model "pass"
  assert.match(out, /using .*pass/);
});

test("orchestrate: no model set and none installed fails before any role runs", async () => {
  const result = await orchestrate({ task: "t", crew: listingCrew("nomodels"), ...quiet });
  assert.equal(result.verdict, "FAIL");
  assert.match(result.reason, /no model/i);
  assert.deepEqual(result.transcript, []);
});

test("cli ask: no --model falls back to the default model", async (t) => {
  const dir = await project(t, listingCrew("models"));
  const res = await cli(["ask", "local", "hi", "--crew", "crew.json"], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /VERDICT: PASS/);
});

test("cli models: lists what the agent has installed, default first", async (t) => {
  const dir = await project(t, listingCrew("models"));
  const res = await cli(["models", "local", "--crew", "crew.json"], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, "pass\ncode\n");

  const cannot = await cli(["models", "claude"], { cwd: dir });
  assert.equal(cannot.code, 1);
});

// --- per-role mode override -------------------------------------------------
test("cli run --mode: sets a role's mode, and validation still applies", async (t) => {
  // The stub agents only offer "read", so a write override must be refused —
  // which also proves the flag reached the role.
  const dir = await project(t, stubCrew("code", "pass"));
  const base = ["run", "task", "--no-branch", "--no-color"];

  const ok = await cli([...base, "--mode", "coder=read"], { cwd: dir });
  assert.equal(ok.code, 0, ok.stderr);

  const refused = await cli([...base, "--mode", "coder=write"], { cwd: dir });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Role "coder" wants mode "write"/);

  const bogus = await cli([...base, "--mode", "coder=sideways"], { cwd: dir });
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /invalid mode/);
});

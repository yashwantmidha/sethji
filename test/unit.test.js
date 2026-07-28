import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildInvocation, mergeAdapters } from "../src/adapters.js";
import { parseVerdict, orchestrate } from "../src/orchestrate.js";
import { runAgent } from "../src/run.js";
import { validateCrew } from "../src/config.js";
import { extractJson, generateCrew } from "../src/plan.js";
import { createRunDir, createLogger } from "../src/logs.js";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = fileURLToPath(new URL("./stub-agent.js", import.meta.url));
const NODE = process.execPath;

// Build a stub adapter whose every mode runs `node stub-agent.js <kind> {prompt}`.
function stubAdapter(kind) {
  const modes = {
    read: [STUB, kind, "{prompt}"],
    write: [STUB, kind, "{prompt}"],
    yolo: [STUB, kind, "{prompt}"],
  };
  return { bin: NODE, modes };
}

// --- buildInvocation -------------------------------------------------------
test("buildInvocation substitutes {prompt} as one argv element", () => {
  const { bin, args } = buildInvocation("claude", "read", "hello world");
  assert.equal(bin, "claude");
  assert.ok(args.includes("hello world"));
  // The prompt must survive as a SINGLE element, not split on spaces.
  assert.equal(args.filter((a) => a === "hello world").length, 1);
});

test("buildInvocation rejects unknown agent", () => {
  assert.throws(() => buildInvocation("nope", "read", "x"), /Unknown agent/);
});

test("buildInvocation rejects unknown mode", () => {
  assert.throws(() => buildInvocation("claude", "sideways", "x"), /no mode/);
});

test("buildInvocation injects the model before the prompt", () => {
  const { args } = buildInvocation("codex", "write", "do it", undefined, { model: "o3" });
  const flagAt = args.indexOf("--model");
  assert.ok(flagAt !== -1, "model flag present");
  assert.equal(args[flagAt + 1], "o3");
  assert.ok(flagAt < args.indexOf("do it"), "model flag comes before the prompt");
});

test("buildInvocation injects a string effort flag (claude)", () => {
  const { args } = buildInvocation("claude", "read", "hi", undefined, { effort: "high" });
  const flagAt = args.indexOf("--effort");
  assert.ok(flagAt !== -1);
  assert.equal(args[flagAt + 1], "high");
});

test("buildInvocation expands an array effort template (codex)", () => {
  const { args } = buildInvocation("codex", "write", "go", undefined, {
    model: "o3",
    effort: "high",
  });
  assert.ok(args.includes("-c"));
  assert.ok(args.includes("model_reasoning_effort=high"));
});

test("buildInvocation without options adds no extra flags", () => {
  const { args } = buildInvocation("claude", "read", "hi");
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--effort"));
});

test("buildInvocation rejects a model for an adapter with no modelFlag", () => {
  const m = mergeAdapters({
    local: { bin: "ollama", modes: { read: ["run", "x", "{prompt}"] } },
  });
  assert.throws(
    () => buildInvocation("local", "read", "hi", m, { model: "llama3" }),
    /no "modelFlag"/
  );
});

test("buildInvocation rejects an effort for an adapter with no effortFlag", () => {
  assert.throws(
    () => buildInvocation("gemini", "read", "hi", undefined, { effort: "high" }),
    /no "effortFlag"/
  );
});

// --- createWorkBranch ------------------------------------------------------
test("createWorkBranch makes a sethji/run-* branch, then declines to stack", async (t) => {
  const { mkdtemp, rm, writeFile: wf } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { createWorkBranch } = await import("../src/run.js");

  const dir = await mkdtemp(join(tmpdir(), "sethji-branch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir });

  const name = await createWorkBranch(dir);
  assert.match(name, /^sethji\/run-/);
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  assert.equal(stdout.trim(), name);

  // Already on a sethji/* branch: no new branch.
  assert.equal(await createWorkBranch(dir), null);

  // Works with a dirty tree too (uncommitted files ride along).
  await run("git", ["checkout", "-q", "-"], { cwd: dir });
  await wf(join(dir, "dirty.txt"), "x");
  assert.match(await createWorkBranch(dir), /^sethji\/run-/);
});

test("createWorkBranch returns null outside a git repo", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createWorkBranch } = await import("../src/run.js");
  const dir = await mkdtemp(join(tmpdir(), "sethji-nogit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await createWorkBranch(dir), null);
});

// --- mergeAdapters (the "which AIs do I have" roster) ----------------------
test("mergeAdapters adds a custom agent with its own modes", () => {
  const m = mergeAdapters({
    local: { bin: "ollama", modes: { read: ["run", "x", "{prompt}"] } },
  });
  assert.equal(m.local.bin, "ollama");
  assert.ok(m.claude, "built-ins are preserved");
});

test("mergeAdapters overrides a built-in bin but inherits its modes", () => {
  const m = mergeAdapters({ claude: { bin: "my-claude" } });
  assert.equal(m.claude.bin, "my-claude");
  // Inherited modes still work for building an invocation.
  const { bin, args } = buildInvocation("claude", "read", "hi", m);
  assert.equal(bin, "my-claude");
  assert.ok(args.includes("hi"));
});

test("mergeAdapters rejects a custom agent with no modes", () => {
  assert.throws(() => mergeAdapters({ bad: { bin: "x" } }), /needs a "modes"/);
});

test("validateCrew accepts a role using a declared custom agent", () => {
  const crew = {
    agents: { local: { bin: "ollama", modes: { read: ["run", "x", "{prompt}"] } } },
    roles: { solo: { agent: "local", mode: "read", persona: "p" } },
    workflow: ["solo"],
  };
  assert.equal(validateCrew(crew), true);
});

test("validateCrew rejects a role whose agent is not declared", () => {
  const crew = {
    roles: { solo: { agent: "mystery", mode: "read", persona: "p" } },
    workflow: ["solo"],
  };
  assert.throws(() => validateCrew(crew), /not defined/);
});

// --- plan: extractJson + generateCrew --------------------------------------
test("extractJson pulls a crew object out of a fenced reply", () => {
  const reply = 'Here you go:\n```json\n{"workflow":["a"],"roles":{"a":{"agent":"claude"}}}\n```\nDone.';
  const crew = extractJson(reply);
  assert.deepEqual(crew.workflow, ["a"]);
});

test("extractJson tolerates prose around bare JSON", () => {
  const crew = extractJson('sure: {"workflow":["x"]} ok');
  assert.deepEqual(crew.workflow, ["x"]);
});

test("extractJson throws when there is no JSON", () => {
  assert.throws(() => extractJson("no json here"), /JSON object/);
});

test("generateCrew validates the drafted crew (stub drafter)", async () => {
  const draft = JSON.stringify({
    roles: { solo: { agent: "claude", mode: "read", persona: "p" } },
    workflow: ["solo"],
  });
  // Fake runner returns a model reply wrapping the draft in fences.
  const runner = async () => ({ ok: true, stdout: "```json\n" + draft + "\n```" });
  const crew = await generateCrew("do a thing", { runner });
  assert.deepEqual(crew.workflow, ["solo"]);
});

test("generateCrew surfaces a drafting failure", async () => {
  const runner = async () => ({ ok: false, error: "boom" });
  await assert.rejects(() => generateCrew("x", { runner }), /failed: boom/);
});

// --- logs: real run folder -------------------------------------------------
test("createLogger writes per-role logs, transcript.md and result.json", () => {
  const base = join(tmpdir(), "sethji-test-" + process.pid);
  const { dir } = createRunDir(base);
  const logger = createLogger(dir, ["coder"]);
  logger.roleChunk("coder", "hello from coder");
  logger.finish({
    verdict: "PASS",
    reason: "",
    rounds: 0,
    transcript: [{ role: "coder", text: "hello from coder" }],
  });
  assert.match(readFileSync(join(dir, "coder.log"), "utf8"), /hello from coder/);
  assert.match(readFileSync(join(dir, "transcript.md"), "utf8"), /## CODER/);
  assert.equal(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).verdict, "PASS");
});

// --- parseVerdict ----------------------------------------------------------
test("parseVerdict reads PASS", () => {
  assert.equal(parseVerdict("looks good\nVERDICT: PASS").verdict, "PASS");
});

test("parseVerdict reads FAIL with reason", () => {
  const v = parseVerdict("nope\nVERDICT: FAIL: broken tests");
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.reason, "broken tests");
});

test("parseVerdict treats unknown/missing as PASS", () => {
  assert.equal(parseVerdict("no verdict here").verdict, "PASS");
  assert.equal(parseVerdict("").verdict, "PASS");
});

test("parseVerdict takes the last verdict line", () => {
  assert.equal(parseVerdict("VERDICT: FAIL: x\nlater\nVERDICT: PASS").verdict, "PASS");
});

// --- runAgent --------------------------------------------------------------
test("runAgent returns trimmed stdout on success", async () => {
  const res = await runAgent({ bin: NODE, args: [STUB, "plan", "p"] });
  assert.equal(res.ok, true);
  assert.match(res.stdout, /^PLAN:/);
  assert.ok(!res.stdout.endsWith("\n"));
});

test("runAgent reports a missing bin helpfully", async () => {
  const res = await runAgent({ bin: "definitely-not-a-real-bin-xyz", args: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found on PATH/);
});

test("runAgent surfaces non-zero exit", async () => {
  const res = await runAgent({ bin: NODE, args: [STUB, "boom", "p"] });
  assert.equal(res.ok, false);
  assert.match(res.error, /exited with code 3/);
});

// --- orchestrate: pass path ------------------------------------------------
test("orchestrate pass path runs each role once, verdict PASS, rounds 0", async () => {
  const crew = {
    roles: {
      architect: { agent: "claude", mode: "read", persona: "arch" },
      coder: { agent: "codex", mode: "write", persona: "code" },
      qa: { agent: "gemini", mode: "read", persona: "qa" },
    },
    workflow: ["architect", "coder", "qa"],
    loop: { from: "qa", to: "coder", maxRounds: 2 },
  };
  const adapters = {
    claude: stubAdapter("plan"),
    codex: stubAdapter("code"),
    gemini: stubAdapter("pass"),
  };
  const result = await orchestrate({
    task: "do it",
    crew,
    adapters,
    color: false,
    write: () => {},
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.rounds, 0);
  assert.deepEqual(
    result.transcript.map((t) => t.role),
    ["architect", "coder", "qa"]
  );
});

// --- orchestrate: fail loop ------------------------------------------------
test("orchestrate fail loop: coder runs maxRounds+1 times, ends FAIL", async () => {
  const maxRounds = 2;
  const crew = {
    roles: {
      architect: { agent: "claude", mode: "read", persona: "arch" },
      coder: { agent: "codex", mode: "write", persona: "code" },
      qa: { agent: "gemini", mode: "read", persona: "qa" },
    },
    workflow: ["architect", "coder", "qa"],
    loop: { from: "qa", to: "coder", maxRounds },
  };
  const adapters = {
    claude: stubAdapter("plan"),
    codex: stubAdapter("code"),
    gemini: stubAdapter("fail"), // QA always FAIL
  };
  const result = await orchestrate({
    task: "do it",
    crew,
    adapters,
    color: false,
    write: () => {},
  });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.rounds, maxRounds);
  const coderRuns = result.transcript.filter((t) => t.role === "coder").length;
  assert.equal(coderRuns, maxRounds + 1);
});

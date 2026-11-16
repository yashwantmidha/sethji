#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BUILTIN_ADAPTERS, mergeAdapters, buildInvocation } from "../src/adapters.js";
import { runAgent, isInstalled, createWorkBranch, stopAgents, modelProblem, defaultModel, installedModels } from "../src/run.js";
import { DEFAULT_CREW, loadCrew, validateCrew } from "../src/config.js";
import { orchestrate } from "../src/orchestrate.js";
import { createRunDir, createLogger } from "../src/logs.js";
import { isTmuxAvailable, startWatchWall } from "../src/tmux.js";
import { generateCrew } from "../src/plan.js";

// --- tiny flag parser ------------------------------------------------------
// Splits argv into positionals + flags. Boolean flags never consume the next
// argument, so `run --no-branch "task"` keeps its task. Everything else
// (--crew, --cwd, --timeout, --mode, --out, --agent, --model, --effort) takes a value.
const BOOLEAN_FLAGS = new Set(["json", "tmux", "no-branch", "force"]);

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-color") {
      flags.color = false;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const HELP = `sethji — run AI coding CLIs as a role-based crew (architect · coder · QA)

Usage:
  sethji run "<task>" [--crew crew.json] [--cwd dir] [--tmux] [--no-color] [--timeout sec] [--json]
             [--no-branch]  runs on a fresh sethji/run-<stamp> git branch by default
             [--check "npm test"]  run this command before QA; a non-zero exit is a
             FAIL that loops back to the coder with the output (or "check" in crew.json).
             No shell: quotes group arguments, nothing else is interpreted
             [--agent role=cli,…] [--mode role=read|write|yolo,…]
             [--model role=name,…] [--effort role=level,…]
             per-role overrides; a bare value ("--model opus") applies to every
             role that can take it
  sethji plan "<what you need>" [--out crew.json] [--crew crew.json] [--cwd dir] [--timeout sec]
  sethji ask <agent> "<prompt>" [--mode read|write|yolo] [--model name] [--effort level]
             [--cwd dir] [--crew crew.json] [--timeout sec]
  sethji list [--crew crew.json]       show known agents (+ your declared ones) and install status
  sethji models [agent]                show the models an agent has installed (default: ollama)
  sethji init [--out crew.json] [--force]   write the default crew config to edit
  sethji help                          this message
  sethji version                       print version

plan: describe a need; an agent drafts a crew config (roles, loop, and a check command
     when the project has one), you review it, then run it.
run: drives the crew. Every run logs to .sethji/runs/<stamp>/ (transcript.md, result.json,
     per-role logs). --tmux opens one pane per role so you watch each agent live.

Modes (how much a delegated agent may touch):
  read   inspect only (default, safe)
  write  may edit files
  yolo   full access — use with care

Known agents: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}
  ollama runs local models: text only (read mode). Pick one with e.g.
  --agent qa=ollama --model qa=qwen2.5-coder; with no model it uses the first
  one "ollama list" shows
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (cmd) {
    case "run":
      return cmdRun(positionals, flags);
    case "plan":
      return cmdPlan(positionals, flags);
    case "ask":
      return cmdAsk(positionals, flags);
    case "list":
      return cmdList(flags);
    case "models":
      return cmdModels(positionals, flags);
    case "init":
      return cmdInit(flags);
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

// sethji run "<task>"
async function cmdRun(positionals, flags) {
  // Resolve the crew: explicit --crew wins; otherwise pick up ./crew.json in
  // the working dir (what `sethji plan` writes); otherwise the built-in default.
  const cwd = flags.cwd || ".";
  let crew;
  if (flags.crew) {
    crew = await loadCrew(flags.crew);
  } else if (existsSync(join(cwd, "crew.json"))) {
    crew = await loadCrew(join(cwd, "crew.json"));
    process.stdout.write("Using ./crew.json.\n");
  } else {
    crew = DEFAULT_CREW;
  }

  try {
    crew = applyRoleOverrides(crew, flags);
    if (flags.check !== undefined) {
      if (typeof flags.check !== "string") {
        throw new Error('--check needs a command. Example: --check "npm test"');
      }
      crew = { ...crew, check: splitCommand(flags.check) };
      validateCrew(crew);
    }
  } catch (err) {
    fail(err.message);
    return;
  }

  // Task: the argument, or fall back to the one `plan` stamped into the crew.
  const task = positionals[0] || crew.task;
  if (!task) {
    fail('run needs a task. Example: sethji run "add a /health endpoint"\n(or run "sethji plan" first to draft a crew with a task).');
    return;
  }
  const timeout = timeoutMs(flags);
  stopAgentsOnSignal();

  // Work on a fresh branch when possible so agent edits are easy to revert.
  // Skipped outside git repos, on sethji/* branches, or with --no-branch.
  if (!flags["no-branch"]) {
    const branch = await createWorkBranch(cwd);
    if (branch) process.stdout.write(`On new branch ${branch} (undo: git checkout -).\n`);
  }

  // Every run gets a log folder the main can review at the end.
  const { dir } = createRunDir(flags.cwd || ".");
  const roles = [...new Set(crew.workflow)]; // one log/pane per unique role
  const logger = createLogger(dir, roles);

  // Optional tmux "watch wall": a pane per role, each tailing its live log.
  if (flags.tmux) {
    if (await isTmuxAvailable()) {
      const wall = await startWatchWall("sethji", roles, dir);
      if (wall.ok) {
        process.stdout.write(`tmux wall up — watch live in another terminal:\n  ${wall.attach}\n`);
      } else {
        process.stdout.write("Could not start the tmux session; continuing inline.\n");
      }
    } else {
      process.stdout.write("tmux not found on PATH; continuing inline (install tmux for the watch wall).\n");
    }
  }

  const result = await orchestrate({
    task,
    crew,
    cwd: flags.cwd,
    color: flags.color !== false,
    timeout,
    logger,
  });

  if (flags.json) {
    process.stdout.write("\n" + JSON.stringify(result, null, 2) + "\n");
  } else {
    const tag = result.verdict === "PASS" ? "✓ PASS" : "✗ FAIL";
    process.stdout.write(
      `\n${tag} after ${result.rounds} loop round(s).` +
        (result.reason ? ` Reason: ${result.reason}` : "") +
        `\nLogs: ${dir}  (transcript.md · result.json · per-role logs)\n`
    );
  }
  if (result.verdict !== "PASS") process.exitCode = 1;
}

// sethji plan "<need>" — an agent drafts a crew config; you review, then run.
async function cmdPlan(positionals, flags) {
  const need = positionals[0];
  if (!need) {
    fail('plan needs a description. Example: sethji plan "build and test a REST API in Go"');
    return;
  }
  // A crew can be supplied just to tell the drafter which agents you have.
  let adapters = BUILTIN_ADAPTERS;
  if (flags.crew) {
    const base = await loadCrew(flags.crew);
    adapters = mergeAdapters(base.agents || {}, BUILTIN_ADAPTERS);
  }
  const timeout = timeoutMs(flags);

  process.stdout.write("Drafting a crew for your need…\n");
  let crew;
  try {
    crew = await generateCrew(need, { cwd: flags.cwd, timeout, adapters });
  } catch (err) {
    fail(err.message);
    return;
  }

  // Remember the need as the crew's default task, so a bare `sethji run` later
  // (which auto-loads ./crew.json) reuses it without re-typing the task.
  crew.task = need;

  const out = typeof flags.out === "string" ? flags.out : "crew.json";
  const json = JSON.stringify(crew, null, 2);
  process.stdout.write(`\n${json}\n\n`);
  process.stdout.write(
    `Roles: ${crew.workflow.join(" → ")}` +
      (crew.loop ? `  (loop ${crew.loop.from}→${crew.loop.to}, max ${crew.loop.maxRounds})` : "") +
      "\n"
  );
  // The drafter chose this command and a run will execute it — make it hard to miss.
  if (crew.check) {
    process.stdout.write(`Check: ${crew.check.join(" ")}  (this command runs on every round)\n`);
  }

  // Approve before saving/running. Default is No — nothing is written.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const warn = existsSync(out) ? ` (overwrites the existing ${out})` : "";
  const answer = (
    await rl.question(`Save to ${out}${warn}? [y = save & run / s = save only / N] `)
  )
    .trim()
    .toLowerCase();
  rl.close();

  const run = answer === "y" || answer === "yes";
  if (!run && answer !== "s" && answer !== "save") {
    process.stdout.write("Not saved.\n");
    return;
  }

  await writeFile(out, json + "\n", "utf8");
  process.stdout.write(`Saved ${out}.\n`);

  if (run) {
    return cmdRun([need], { ...flags, crew: out });
  }
  process.stdout.write(`When ready: sethji run "<task>" --crew ${out}\n`);
}

// sethji ask <agent> "<prompt>"
async function cmdAsk(positionals, flags) {
  const [agent, prompt] = positionals;
  if (!agent || !prompt) {
    fail('ask needs an agent and a prompt. Example: sethji ask claude "explain this repo"');
    return;
  }
  const mode = flags.mode || "read";
  // If a crew config is given, its "agents" roster can add/override agents.
  let adapters = BUILTIN_ADAPTERS;
  if (flags.crew) {
    const crew = await loadCrew(flags.crew);
    adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  }
  const timeout = timeoutMs(flags);
  stopAgentsOnSignal();
  let invocation;
  try {
    const adapter = adapters[agent];
    let model = typeof flags.model === "string" ? flags.model : undefined;
    // No --model on an agent that needs one (ollama): use its default.
    if (adapter && adapter.requiresModel && !model) {
      model = await defaultModel(agent, adapter);
      process.stderr.write(`No --model given, using ${agent} default ${model}.\n`);
    }
    invocation = buildInvocation(agent, mode, prompt, adapters, {
      model,
      effort: typeof flags.effort === "string" ? flags.effort : undefined,
    });
    const problem = await modelProblem(agent, adapter, model);
    if (problem) throw new Error(problem);
  } catch (err) {
    fail(err.message);
    return;
  }
  const res = await runAgent({
    bin: invocation.bin,
    args: invocation.args,
    cwd: flags.cwd,
    timeout,
    onData: (chunk) => process.stdout.write(chunk),
  });
  if (!res.ok) {
    fail(res.error);
    return;
  }
  process.stdout.write("\n");
}

// sethji list [--crew crew.json] — known agents + install status.
// With --crew, also include the AIs you declared in that crew's "agents" roster.
async function cmdList(flags) {
  let adapters = BUILTIN_ADAPTERS;
  if (flags.crew) {
    const crew = await loadCrew(flags.crew);
    adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  }
  const names = Object.keys(adapters);
  const checks = await Promise.all(
    names.map(async (name) => ({
      name,
      bin: adapters[name].bin,
      builtin: name in BUILTIN_ADAPTERS && adapters[name].bin === BUILTIN_ADAPTERS[name].bin,
      installed: await isInstalled(adapters[name].bin),
    }))
  );
  process.stdout.write("Known agents:\n");
  for (const c of checks) {
    const status = c.installed ? "installed" : "not found";
    const tag = c.builtin ? "" : " (custom)";
    process.stdout.write(`  ${c.name.padEnd(10)} (${c.bin})  ${status}${tag}\n`);
  }
}

// sethji models <agent> [--crew crew.json] — the models that agent has
// installed, one per line, first = the default. The menu-bar app reads this.
async function cmdModels(positionals, flags) {
  const agent = positionals[0] || "ollama";
  let adapters = BUILTIN_ADAPTERS;
  if (flags.crew) {
    const crew = await loadCrew(flags.crew);
    adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  }
  const adapter = adapters[agent];
  if (!adapter || !adapter.listModels) {
    fail(`Agent "${agent}" cannot list its models (only agents with "listModels", like ollama, can).`);
    return;
  }
  for (const name of await installedModels(adapter)) process.stdout.write(name + "\n");
}

// sethji init — write the default crew config
async function cmdInit(flags) {
  const out = typeof flags.out === "string" ? flags.out : "crew.json";
  if (existsSync(out) && !flags.force) {
    fail(`${out} already exists. Use --force to overwrite it, or --out <file> to write elsewhere.`);
    return;
  }
  await writeFile(out, JSON.stringify(DEFAULT_CREW, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote default crew to ${out}. Edit it, then: sethji run "<task>" --crew ${out}\n`);
}

async function cmdVersion() {
  // Read our own version without importing JSON (keeps things ESM-simple).
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(url, "utf8"));
  process.stdout.write(`${pkg.version}\n`);
}

// Apply --agent / --model / --effort overrides to a crew's roles.
// Spec: "coder=o3,qa=flash" targets roles by name; a bare "o3" applies to
// every workflow role that can take it. Re-validates the crew so a bad role
// name or unsupported agent fails fast with a friendly error.
function applyRoleOverrides(crew, flags) {
  const specs = [
    ["agent", null, flags.agent],
    ["mode", null, flags.mode],
    ["model", "modelFlag", flags.model],
    ["effort", "effortFlag", flags.effort],
  ];
  if (!specs.some(([, , v]) => typeof v === "string")) return crew;

  const adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  const roles = { ...crew.roles };
  const set = (role, field, value) => {
    roles[role] = { ...roles[role], [field]: value };
  };

  for (const [field, flagName, spec] of specs) {
    if (typeof spec !== "string") continue;
    for (const part of spec.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) {
        // Bare value: every workflow role that can take it.
        for (const role of new Set(crew.workflow)) {
          const def = roles[role];
          if (!def) continue;
          if (flagName && !(adapters[def.agent] && adapters[def.agent][flagName])) continue;
          set(role, field, part);
        }
      } else {
        const role = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (!roles[role]) {
          throw new Error(
            `--${field} targets unknown role "${role}". Roles: ${Object.keys(crew.roles).join(", ")}.`
          );
        }
        set(role, field, value);
      }
    }
  }

  const next = { ...crew, roles };
  validateCrew(next);
  return next;
}

// Split a --check string into argv without a shell: whitespace separates,
// "double" and 'single' quotes group (and may sit mid-word: --grep="a b").
// ponytail: no backslash escapes or nested quoting — for anything stranger,
// write "check" as an array in crew.json.
function splitCommand(text) {
  const argv = [];
  let word = "";
  let inWord = false;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`--check has an unclosed ${quote} quote.`);
  if (inWord) argv.push(word);
  return argv;
}

// --timeout <seconds> as ms (0 = none). A typo must not silently mean "no timeout".
function timeoutMs(flags) {
  if (flags.timeout === undefined) return 0;
  const sec = typeof flags.timeout === "string" ? Number(flags.timeout) : NaN;
  if (!Number.isFinite(sec) || sec < 0) {
    throw new Error(`--timeout needs a number of seconds, got "${flags.timeout}".`);
  }
  return sec * 1000;
}

// Ctrl-C, or the menu-bar app's Stop (SIGTERM), must take the running agent
// down with us; the run then ends as FAIL and still writes its logs.
function stopAgentsOnSignal() {
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stopAgents);
}

function fail(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});

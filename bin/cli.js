#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BUILTIN_ADAPTERS, mergeAdapters } from "../src/adapters.js";
import { runAgent, isInstalled } from "../src/run.js";
import { DEFAULT_CREW, loadCrew } from "../src/config.js";
import { buildInvocation } from "../src/adapters.js";
import { orchestrate } from "../src/orchestrate.js";
import { createRunDir, createLogger } from "../src/logs.js";
import { isTmuxAvailable, startWatchWall } from "../src/tmux.js";
import { generateCrew } from "../src/plan.js";

// --- tiny flag parser ------------------------------------------------------
// Splits argv into positionals + flags. Boolean flags: --no-color.
// Value flags: --crew, --cwd, --timeout, --mode, --out, --json.
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-color") {
      flags.color = false;
    } else if (a === "--json") {
      flags.json = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
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
  sethji plan "<what you need>" [--out crew.json] [--crew crew.json] [--cwd dir] [--timeout sec]
  sethji ask <agent> "<prompt>" [--mode read|write|yolo] [--cwd dir] [--crew crew.json] [--timeout sec]
  sethji list [--crew crew.json]       show known agents (+ your declared ones) and install status
  sethji init [--out crew.json]        write the default crew config to edit
  sethji help                          this message
  sethji version                       print version

plan: describe a need; an agent drafts a crew config, you review it, then run it.
run: drives the crew. Every run logs to .sethji/runs/<stamp>/ (transcript.md, result.json,
     per-role logs). --tmux opens one pane per role so you watch each agent live.

Modes (how much a delegated agent may touch):
  read   inspect only (default, safe)
  write  may edit files
  yolo   full access — use with care

Known agents: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}
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

  // Task: the argument, or fall back to the one `plan` stamped into the crew.
  const task = positionals[0] || crew.task;
  if (!task) {
    fail('run needs a task. Example: sethji run "add a /health endpoint"\n(or run "sethji plan" first to draft a crew with a task).');
    return;
  }
  const timeout = flags.timeout ? Number(flags.timeout) * 1000 : 0;

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
  const timeout = flags.timeout ? Number(flags.timeout) * 1000 : 0;

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

  // Approve before saving/running. Default is No.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Save to ${out} and run now? [y/N] `)).trim().toLowerCase();
  rl.close();

  await writeFile(out, json + "\n", "utf8");
  process.stdout.write(`Saved ${out}.\n`);

  if (answer === "y" || answer === "yes") {
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
  let invocation;
  try {
    invocation = buildInvocation(agent, mode, prompt, adapters);
  } catch (err) {
    fail(err.message);
    return;
  }
  const timeout = flags.timeout ? Number(flags.timeout) * 1000 : 0;
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

// sethji init — write the default crew config
async function cmdInit(flags) {
  const out = typeof flags.out === "string" ? flags.out : "crew.json";
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

function fail(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});

import { buildInvocation, BUILTIN_ADAPTERS, mergeAdapters } from "./adapters.js";
import { runAgent, modelProblem, defaultModel } from "./run.js";
import { NULL_LOGGER } from "./logs.js";

// Raw ANSI colors (no chalk). One per role header, cycled.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  colors: [
    "\x1b[36m", // cyan
    "\x1b[33m", // yellow
    "\x1b[35m", // magenta
    "\x1b[32m", // green
    "\x1b[34m", // blue
  ],
};

// Parse a QA verdict out of free text.
// Returns { verdict: "PASS" | "FAIL", reason } — unknown/missing counts as PASS
// so the review loop can never spin forever.
export function parseVerdict(text) {
  if (!text) return { verdict: "PASS", reason: "no verdict line (treated as PASS)" };
  const re = /^\s*VERDICT:\s*(PASS|FAIL)\s*(?::\s*(.*))?\s*$/gim;
  let match;
  let last = null;
  // Take the LAST verdict line in case the agent restated it.
  while ((match = re.exec(text)) !== null) last = match;
  if (!last) return { verdict: "PASS", reason: "no verdict line (treated as PASS)" };
  const verdict = last[1].toUpperCase();
  return { verdict, reason: (last[2] || "").trim() };
}

// Compose the prompt handed to a role each turn:
//   persona + task + full transcript so far + "respond as <ROLE>".
function buildTurnPrompt(roleName, persona, task, transcript) {
  const history =
    transcript.length === 0
      ? "(no prior turns yet)"
      : transcript.map((t) => `### ${t.role.toUpperCase()}\n${t.text}`).join("\n\n");
  return [
    persona,
    "",
    `# TASK\n${task}`,
    "",
    `# TRANSCRIPT SO FAR\n${history}`,
    "",
    `Now respond as ${roleName.toUpperCase()}.`,
  ].join("\n");
}

// Print a colored header for a role's turn (unless color disabled).
function printHeader(roleName, agent, mode, color, write) {
  const idx = Math.abs(hashish(roleName)) % ANSI.colors.length;
  const c = color ? ANSI.colors[idx] : "";
  const r = color ? ANSI.reset : "";
  const b = color ? ANSI.bold : "";
  const d = color ? ANSI.dim : "";
  write(`\n${c}${b}▌ ${roleName.toUpperCase()}${r}${c} (${d}${agent} · ${mode}${r}${c})${r}\n`);
}

// Tiny stable string hash so each role keeps the same color.
function hashish(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// How much check output to keep in the transcript (chars, from the end).
const CHECK_OUTPUT_MAX = 8000;

// Run the whole crew over a task.
//
// opts:
//   task     - the work to do (string)
//   crew     - validated crew config
//   adapters - agent adapter map (default: built-ins)
//   cwd      - working dir passed to each child
//   color    - colored headers (default true)
//   timeout  - ms per agent (0 = none)
//   write    - sink for live output (default process.stdout.write)
//   runner   - injectable runAgent (for tests); defaults to real runAgent
//
// Returns { transcript, verdict, reason, rounds }.
export async function orchestrate({
  task,
  crew,
  adapters,
  cwd,
  color = true,
  timeout = 0,
  write = (s) => process.stdout.write(s),
  runner = runAgent,
  logger = NULL_LOGGER,
} = {}) {
  // Tests inject `adapters` directly; real runs build them from the crew's
  // "agents" roster merged onto the built-ins.
  if (!adapters) adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  const transcript = [];
  const loop = crew.loop || null;
  const maxRounds = loop ? loop.maxRounds ?? 0 : 0;
  let rounds = 0;
  let verdict = "PASS";
  let reason = "";

  // Count a loop round, announce it, and return the index to resume from.
  const loopBack = () => {
    rounds++;
    const noteMsg = `↻ QA failed (round ${rounds}/${maxRounds}): ${
      reason || "no reason given"
    } — looping back to ${loop.to}.`;
    write(`\n${color ? ANSI.dim : ""}${noteMsg}${color ? ANSI.reset : ""}\n`);
    logger.note(noteMsg);
    return crew.workflow.indexOf(loop.to);
  };

  // Run the crew's "check" command (e.g. ["npm", "test"]) so the verdict rests
  // on a real result, not only on QA reading the code. The output joins the
  // transcript as a CHECK turn for QA and the coder to read.
  // Returns "pass", "fail" (ran, non-zero exit) or "error" (never produced an
  // exit code: missing, timed out, stopped). Sets verdict/reason unless "pass".
  const runCheck = async () => {
    const [bin, ...args] = crew.check;
    const label = crew.check.join(" ");
    printHeader("check", label, "run", color, write);
    const emit = (chunk) => {
      write(chunk);
      logger.roleChunk("check", chunk);
    };
    const res = await runner({ bin, args, cwd, timeout, onData: emit });
    // Test runners often report on stderr; it is not streamed, so show it now.
    if (res.stderr) emit(`\n${res.stderr}\n`);

    if (typeof res.code !== "number") {
      emit(`\n[error] ${res.error}\n`);
      transcript.push({ role: "check", text: `[error] ${res.error}` });
      verdict = "FAIL";
      reason = res.error;
      return "error";
    }
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n");
    // Failures print last, so keep the tail; the transcript is re-sent every turn.
    const shown =
      output.length > CHECK_OUTPUT_MAX
        ? `…(earlier output trimmed)\n${output.slice(-CHECK_OUTPUT_MAX)}`
        : output;
    transcript.push({ role: "check", text: `$ ${label}\n${shown}\n[exit ${res.code}]` });
    if (res.code === 0) return "pass";
    verdict = "FAIL";
    reason = `check failed: "${label}" exited with code ${res.code}`;
    return "fail";
  };

  // Before anything runs, settle every role's model. A role with none, on an
  // agent that needs one, gets that agent's default. And each model must
  // already be installed, or an agent like ollama would start a silent
  // multi-GB download mid-run.
  const roles = { ...crew.roles };
  const defaults = new Map(); // agent -> its default model, looked up once
  for (const roleName of new Set(crew.workflow)) {
    const def = roles[roleName];
    const adapter = adapters[def.agent];
    if (!adapter) continue; // reported as an unknown agent when the role runs
    let problem = null;
    try {
      if (adapter.requiresModel && !def.model) {
        if (!defaults.has(def.agent)) {
          defaults.set(def.agent, await defaultModel(def.agent, adapter, runner));
        }
        const model = defaults.get(def.agent);
        roles[roleName] = { ...def, model };
        write(`${roleName}: no model set, using ${def.agent} default ${model}.\n`);
      }
      problem = await modelProblem(def.agent, adapter, roles[roleName].model, runner);
    } catch (err) {
      problem = err.message;
    }
    if (problem) {
      write(`\n${problem}\n`);
      const result = { transcript, verdict: "FAIL", reason: problem, rounds };
      logger.finish(result);
      return result;
    }
  }

  // We walk the workflow by index so the loop can jump back to loop.to.
  let i = 0;
  while (i < crew.workflow.length) {
    const roleName = crew.workflow[i];

    // The check runs right before the reviewing role. A failing check is the
    // verdict: QA is not asked, and the coder gets the output as feedback.
    if (crew.check && loop && roleName === loop.from) {
      const outcome = await runCheck();
      if (outcome === "fail" && rounds < maxRounds) {
        i = loopBack();
        continue;
      }
      if (outcome !== "pass") break;
    }

    const def = roles[roleName];
    const mode = def.mode || "read";

    // Build this turn's prompt and the concrete CLI invocation.
    const prompt = buildTurnPrompt(roleName, def.persona || "", task, transcript);
    let invocation;
    try {
      invocation = buildInvocation(def.agent, mode, prompt, adapters, {
        model: def.model,
        effort: def.effort,
      });
    } catch (err) {
      write(`\n${err.message}\n`);
      transcript.push({ role: roleName, text: `[error] ${err.message}` });
      verdict = "FAIL";
      reason = err.message;
      break;
    }

    printHeader(roleName, def.agent, mode, color, write);

    const res = await runner({
      bin: invocation.bin,
      args: invocation.args,
      cwd,
      timeout,
      onData: (chunk) => {
        write(chunk);
        logger.roleChunk(roleName, chunk); // mirror to the role's live log file
      },
    });

    const text = res.ok ? res.stdout : `[error] ${res.error}`;
    if (!res.ok) {
      write(`\n${text}\n`);
      logger.roleChunk(roleName, `\n${text}\n`);
    }
    transcript.push({ role: roleName, text });

    // An agent that crashed, timed out, or was stopped did no work: the run
    // fails here. Carrying on would let a missing verdict read as PASS.
    if (!res.ok) {
      verdict = "FAIL";
      reason = res.error;
      break;
    }

    // If this is the loop's "from" role, check the verdict and maybe jump back.
    if (loop && roleName === loop.from) {
      const v = parseVerdict(res.stdout);
      verdict = v.verdict;
      reason = v.reason;
      if (verdict === "FAIL" && rounds < maxRounds) {
        i = loopBack();
        continue;
      }
    }

    i++;
  }

  // No loop to hang the check on: run it once after the last role.
  if (crew.check && !loop && verdict === "PASS") await runCheck();

  const result = { transcript, verdict, reason, rounds };
  logger.finish(result); // write transcript.md + result.json for the main to review
  return result;
}

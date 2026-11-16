import { buildInvocation, BUILTIN_ADAPTERS } from "./adapters.js";
import { runAgent } from "./run.js";
import { validateCrew } from "./config.js";

// `sethji plan "<need>"` — describe what you want; an agent drafts a crew config
// for you. We hand it the schema + a worked sample and ask for JSON only, then
// validate the result before showing it. You approve before anything runs.

// A compact, copy-pasteable example the drafting agent can imitate.
const SAMPLE = {
  agents: { claude: { bin: "claude" } },
  roles: {
    architect: { agent: "claude", mode: "read", persona: "ARCHITECT. Numbered plan + acceptance criteria. No code." },
    coder: { agent: "claude", mode: "write", persona: "CODER. Implement the plan in --cwd. Address QA feedback. Minimal." },
    qa: { agent: "claude", mode: "read", persona: "QA. Check vs criteria. End EXACTLY one line: VERDICT: PASS or VERDICT: FAIL: <reason>." },
  },
  workflow: ["architect", "coder", "qa"],
  loop: { from: "qa", to: "coder", maxRounds: 2 },
};

// The prompt that turns a free-text need into a crew config.
export function buildPlanPrompt(need, knownAgents) {
  return [
    "You design crews for `sethji`, a tool that runs AI coding CLIs as a role-based crew.",
    "",
    "Output ONLY a single JSON object — no prose, no markdown fences. It must match this schema:",
    "- agents: optional map of name -> { bin, modes? }. Reuse built-ins by name; you usually only need to list the ones you use.",
    "- roles: map of roleName -> { agent, mode (read|write|yolo), persona }.",
    "- workflow: array of role names, in run order (any number of roles).",
    "- loop (optional): { from, to, maxRounds }. The `from` role MUST end its reply with a line `VERDICT: PASS` or `VERDICT: FAIL: <reason>`.",
    '- check (optional): the command that proves the work, as an argv array — e.g. ["npm", "test"]. It runs before the loop\'s `from` role; a non-zero exit fails the round. Look in the working directory (package.json scripts, Makefile, pyproject.toml, go.mod, ...) for the project\'s real test or build command. Omit it if you cannot find one — never invent a command, and never use one that changes files, installs, deploys or deletes.',
    "",
    `Built-in agents available: ${knownAgents}.`,
    'Use `ollama` (local models) only if the user asks for a local model: its roles must be mode read; set "model" only if the user named one.',
    "Pick modes conservatively: default read; use write only for the role(s) that must edit files; avoid yolo.",
    "Tailor the roles and personas to the user's need below. Add roles (researcher, reviewer, security, docs, tester, ...) when they help.",
    "",
    "Here is a valid example to imitate the SHAPE of (not the content):",
    JSON.stringify(SAMPLE, null, 2),
    "",
    `# USER NEED`,
    need,
    "",
    "Return the crew JSON now.",
  ].join("\n");
}

// Pull a JSON object out of a model reply, tolerating ```json fences / stray prose.
export function extractJson(text) {
  if (!text) throw new Error("The drafting agent returned nothing.");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not find a JSON object in the drafting agent's reply.");
  }
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    throw new Error(`The drafted crew was not valid JSON: ${err.message}`);
  }
}

// Ask `agent` (default claude, read-only) to draft a crew for `need`.
// Returns the validated crew object. Throws a friendly error on any failure.
export async function generateCrew(
  need,
  { agent = "claude", cwd, timeout = 0, adapters = BUILTIN_ADAPTERS, runner = runAgent } = {}
) {
  const knownAgents = Object.keys(adapters).join(", ");
  const prompt = buildPlanPrompt(need, knownAgents);
  const { bin, args } = buildInvocation(agent, "read", prompt, adapters);

  const res = await runner({ bin, args, cwd, timeout });
  if (!res.ok) {
    throw new Error(`Drafting agent "${agent}" failed: ${res.error}`);
  }
  const crew = extractJson(res.stdout);
  validateCrew(crew); // throws a clear message if the draft is malformed
  return crew;
}

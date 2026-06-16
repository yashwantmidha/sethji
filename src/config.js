import { readFile } from "node:fs/promises";
import { MODES, mergeAdapters, BUILTIN_ADAPTERS } from "./adapters.js";

// The default crew: architect plans, coder implements, QA reviews & loops.
export const DEFAULT_CREW = {
  roles: {
    architect: {
      agent: "claude",
      mode: "read",
      persona:
        "You are the ARCHITECT. Produce a short, numbered implementation plan plus explicit acceptance criteria. Do NOT write full code — design only.",
    },
    coder: {
      agent: "codex",
      mode: "write",
      persona:
        "You are the CODER. Implement the architect's plan exactly. Address every point of QA feedback in the transcript. Make the changes; keep them minimal and correct.",
    },
    qa: {
      agent: "gemini",
      mode: "read",
      persona:
        "You are QA. Review the work against the acceptance criteria. Be concise. End your reply with EXACTLY one line: \"VERDICT: PASS\" or \"VERDICT: FAIL: <reason>\".",
    },
  },
  workflow: ["architect", "coder", "qa"],
  loop: { from: "qa", to: "coder", maxRounds: 2 },
};

// Load a crew config from a JSON file, validate it, and return it.
export async function loadCrew(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Crew file not found: ${path}. Run "sethji init" to create one.`);
    }
    throw new Error(`Could not read crew file ${path}: ${err.message}`);
  }
  let crew;
  try {
    crew = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Crew file ${path} is not valid JSON: ${err.message}`);
  }
  validateCrew(crew);
  return crew;
}

// Validate a crew object. Throws a friendly error listing what is wrong.
export function validateCrew(crew) {
  if (!crew || typeof crew !== "object") {
    throw new Error("Crew config must be a JSON object.");
  }
  if (!crew.roles || typeof crew.roles !== "object") {
    throw new Error('Crew config needs a "roles" object.');
  }
  if (!Array.isArray(crew.workflow) || crew.workflow.length === 0) {
    throw new Error('Crew config needs a non-empty "workflow" array of role names.');
  }

  // The optional "agents" roster is where the user declares the AIs they have.
  // Merge it onto the built-ins (mergeAdapters throws friendly errors) so we
  // know the full set of agents a role is allowed to reference.
  if (crew.agents && typeof crew.agents !== "object") {
    throw new Error('Crew config "agents" must be an object mapping name -> { bin, modes }.');
  }
  const adapters = mergeAdapters(crew.agents || {}, BUILTIN_ADAPTERS);
  const knownAgents = Object.keys(adapters).join(", ");

  // Every role used in the workflow must exist and be well-formed.
  for (const role of crew.workflow) {
    const def = crew.roles[role];
    if (!def) {
      throw new Error(`Workflow references unknown role "${role}".`);
    }
    if (!def.agent) {
      throw new Error(`Role "${role}" is missing an "agent".`);
    }
    if (!adapters[def.agent]) {
      throw new Error(
        `Role "${role}" uses agent "${def.agent}", which is not defined. ` +
          `Known agents: ${knownAgents}. Add it under "agents" in your crew config.`
      );
    }
    if (def.mode && !MODES.includes(def.mode)) {
      throw new Error(
        `Role "${role}" has invalid mode "${def.mode}". Use one of: ${MODES.join(", ")}.`
      );
    }
  }

  // The loop is optional, but if present it must point at real workflow roles.
  if (crew.loop) {
    const { from, to } = crew.loop;
    if (!crew.roles[from]) throw new Error(`loop.from points at unknown role "${from}".`);
    if (!crew.roles[to]) throw new Error(`loop.to points at unknown role "${to}".`);
    if (!crew.workflow.includes(from))
      throw new Error(`loop.from role "${from}" is not in the workflow.`);
    if (!crew.workflow.includes(to))
      throw new Error(`loop.to role "${to}" is not in the workflow.`);
  }

  return true;
}

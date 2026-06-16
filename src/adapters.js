// Adapters are data: how to invoke each agent CLI in each access mode.
// Each mode is an array of argv elements. The literal token "{prompt}" is
// replaced (as a single argv element) with the real prompt at call time, so
// prompt content can never be split into multiple args or hit a shell.

// Known headless invocations (verify with `<cli> --help`, they drift):
//   claude -p "<prompt>"            --allowedTools / --permission-mode / --dangerously-skip-permissions / --cwd
//   codex exec "<prompt>"           --sandbox read-only|workspace-write|danger-full-access  --skip-git-repo-check
//   gemini -p "<prompt>"            -y (auto-approve / yolo)
export const BUILTIN_ADAPTERS = {
  claude: {
    bin: "claude",
    modes: {
      read: ["-p", "{prompt}", "--allowedTools", "Read,Grep,Glob"],
      write: ["-p", "{prompt}", "--permission-mode", "acceptEdits"],
      yolo: ["-p", "{prompt}", "--dangerously-skip-permissions"],
    },
  },
  codex: {
    bin: "codex",
    modes: {
      read: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "{prompt}"],
      write: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{prompt}"],
      yolo: ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "{prompt}"],
    },
  },
  gemini: {
    bin: "gemini",
    modes: {
      // Gemini has no separate read/write sandbox flag; -y auto-approves tools.
      read: ["-p", "{prompt}"],
      write: ["-p", "{prompt}"],
      yolo: ["-p", "{prompt}", "-y"],
    },
  },
};

export const MODES = ["read", "write", "yolo"];

// Merge a crew's "agents" roster on top of the built-in adapters.
// This is how a user declares the AIs they actually have: a crew config can
// add brand-new agents or override the bin/modes of a built-in one.
//
// Each roster entry may be a full adapter ({ bin, modes }) or a shorthand:
//   { bin: "my-claude" }            -> reuse built-in "claude" modes if name matches
//   { bin: "x", modes: { read: [...] } }
// Returns a new map; never mutates the built-ins.
export function mergeAdapters(roster = {}, base = BUILTIN_ADAPTERS) {
  const merged = { ...base };
  for (const [name, entry] of Object.entries(roster)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Agent "${name}" in your roster must be an object with a "bin".`);
    }
    const fallback = base[name] || {};
    const bin = entry.bin || fallback.bin;
    if (!bin) {
      throw new Error(`Agent "${name}" needs a "bin" (the CLI command to run).`);
    }
    const modes = entry.modes || fallback.modes;
    if (!modes || typeof modes !== "object" || Object.keys(modes).length === 0) {
      throw new Error(
        `Agent "${name}" needs a "modes" map (e.g. {"read":["-p","{prompt}"]}) ` +
          `unless it overrides a built-in agent of the same name.`
      );
    }
    merged[name] = { bin, modes };
  }
  return merged;
}

// Replace every "{prompt}" token in an args template with the real prompt.
// Kept as its own argv element — no concatenation, no shell.
function substitute(args, prompt) {
  return args.map((a) => (a === "{prompt}" ? prompt : a));
}

// Build a concrete invocation for an agent + mode + prompt.
// Returns { bin, args }. Throws a friendly error for unknown agent/mode.
export function buildInvocation(agent, mode, prompt, adapters = BUILTIN_ADAPTERS) {
  const adapter = adapters[agent];
  if (!adapter) {
    const known = Object.keys(adapters).join(", ") || "(none)";
    throw new Error(`Unknown agent "${agent}". Known agents: ${known}.`);
  }
  const template = adapter.modes && adapter.modes[mode];
  if (!template) {
    const known = Object.keys(adapter.modes || {}).join(", ") || "(none)";
    throw new Error(
      `Agent "${agent}" has no mode "${mode}". Available modes: ${known}.`
    );
  }
  return { bin: adapter.bin, args: substitute(template, prompt) };
}

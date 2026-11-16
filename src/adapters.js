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
    modelFlag: "--model",
    effortFlag: "--effort",
    modes: {
      read: ["-p", "{prompt}", "--allowedTools", "Read,Grep,Glob"],
      write: ["-p", "{prompt}", "--permission-mode", "acceptEdits"],
      yolo: ["-p", "{prompt}", "--dangerously-skip-permissions"],
    },
  },
  codex: {
    bin: "codex",
    modelFlag: "--model",
    effortFlag: ["-c", "model_reasoning_effort={effort}"],
    modes: {
      read: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "{prompt}"],
      write: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{prompt}"],
      yolo: ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "{prompt}"],
    },
  },
  gemini: {
    bin: "gemini",
    modelFlag: "--model",
    modes: {
      // Gemini has no separate read/write sandbox flag; -y auto-approves tools.
      read: ["-p", "{prompt}"],
      write: ["-p", "{prompt}"],
      yolo: ["-p", "{prompt}", "-y"],
    },
  },
  // Local models: `ollama run <model> "<prompt>"`. Text in, text out — it has
  // no file tools, so it only offers "read". Use it for planning and review
  // roles and keep claude/codex as the writer.
  ollama: {
    bin: "ollama",
    modelFlag: ["{model}"],
    requiresModel: true,
    // A role that names no model gets the first one `ollama list` prints
    // (the most recently pulled or updated).
    listModels: ["list"],
    // `ollama run` silently downloads a model it lacks (several GB); `show`
    // only looks, so sethji asks first and refuses to start a download.
    modelCheck: ["show", "{model}"],
    modes: {
      // --nowordwrap: otherwise ollama re-draws wrapped words with cursor
      // escape codes, which land in the transcript as duplicated fragments.
      read: ["run", "--nowordwrap", "{prompt}"],
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
    const adapter = { bin, modes };
    for (const flag of ["modelFlag", "effortFlag", "requiresModel", "listModels", "modelCheck"]) {
      const value = entry[flag] !== undefined ? entry[flag] : fallback[flag];
      if (value) adapter[flag] = value;
    }
    merged[name] = adapter;
  }
  return merged;
}

// Replace every "{prompt}" token in an args template with the real prompt.
// Kept as its own argv element — no concatenation, no shell.
function substitute(args, prompt) {
  return args.map((a) => (a === "{prompt}" ? prompt : a));
}

// Expand a flag spec into concrete argv elements.
// A string spec ("--model") becomes [spec, value]; an array spec is a template
// whose "{model}"/"{effort}" placeholder is replaced with the value
// (e.g. ["-c", "model_reasoning_effort={effort}"]).
function flagArgs(spec, placeholder, value) {
  if (Array.isArray(spec)) {
    return spec.map((a) => a.split(placeholder).join(value));
  }
  return [spec, value];
}

// Build a concrete invocation for an agent + mode + prompt.
// Returns { bin, args }. Throws a friendly error for unknown agent/mode.
// Options { model, effort } are injected via the adapter's modelFlag /
// effortFlag before the prompt, so a role can pin the underlying model and
// reasoning effort (e.g. claude --model opus --effort high).
export function buildInvocation(agent, mode, prompt, adapters = BUILTIN_ADAPTERS, options = {}) {
  const adapter = adapters[agent];
  if (!adapter) {
    const known = Object.keys(adapters).join(", ") || "(none)";
    throw new Error(`Unknown agent "${agent}". Known agents: ${known}.`);
  }
  let template = adapter.modes && adapter.modes[mode];
  if (!template) {
    const known = Object.keys(adapter.modes || {}).join(", ") || "(none)";
    throw new Error(
      `Agent "${agent}" has no mode "${mode}". Available modes: ${known}.`
    );
  }
  const { model, effort } = options;
  if (adapter.requiresModel && !model) {
    throw new Error(
      `Agent "${agent}" needs a model (e.g. --model qwen2.5-coder, or "model" on the role).`
    );
  }
  const extra = [];
  if (model) {
    if (!adapter.modelFlag) {
      throw new Error(
        `Agent "${agent}" has no "modelFlag", so it cannot take a model. ` +
          `Add one to its adapter (e.g. "modelFlag": "--model").`
      );
    }
    extra.push(...flagArgs(adapter.modelFlag, "{model}", model));
  }
  if (effort) {
    if (!adapter.effortFlag) {
      throw new Error(
        `Agent "${agent}" has no "effortFlag", so it cannot take an effort. ` +
          `Add one to its adapter (e.g. "effortFlag": "--effort").`
      );
    }
    extra.push(...flagArgs(adapter.effortFlag, "{effort}", effort));
  }
  if (extra.length) {
    const at = template.indexOf("{prompt}");
    const insert = at === -1 ? template.length : at;
    template = [...template.slice(0, insert), ...extra, ...template.slice(insert)];
  }
  return { bin: adapter.bin, args: substitute(template, prompt) };
}

# sethji

Run several AI coding CLIs as a **role-based crew** from one terminal. One agent is the
**architect**, another the **coder**, another **QA**. `sethji` spawns each agent's CLI as a
child process, relays their outputs to one another through a shared transcript, and loops
QA → coder until the work passes.

- **Zero runtime dependencies.** Pure Node ≥ 18, ESM, raw ANSI for color.
- **Safe spawning.** Children run with `shell: false` and the prompt is always a single
  argv element, so prompt content can never trigger shell injection.
- **Bring your own agents.** Built-in adapters for `claude`, `codex`, and `gemini`; override
  or add agents in a crew config.

## Quickstart

```bash
npx sethji list                       # which agent CLIs are installed?
npx sethji init                       # write a crew.json you can edit
npx sethji run "add a /health endpoint and a test for it"
```

`run` drives the default crew (architect → coder → qa, looping back to coder on a QA fail).
You watch each agent live under a colored header like `▌ CODER (codex · write)`.

One-off, single agent:

```bash
npx sethji ask claude "explain what this repo does" --mode read
```

## Commands

| Command | What it does |
| --- | --- |
| `sethji run "<task>"` | Drive the crew over a task. Flags: `--crew crew.json` `--cwd dir` `--tmux` `--no-branch` `--no-color` `--timeout sec` `--json`, plus per-role overrides `--agent` `--model` `--effort` (`role=value,…`, or a bare value for every role that can take it) |
| `sethji plan "<need>"` | An agent drafts a crew config for your need; you review it, then save and/or run. Flags: `--out crew.json` `--crew crew.json` `--cwd dir` `--timeout sec` |
| `sethji ask <agent> "<prompt>"` | Run one agent once. Flags: `--mode read\|write\|yolo` `--cwd dir` `--crew crew.json` `--timeout sec` |
| `sethji list [--crew crew.json]` | Show known agents (+ ones you declared) and whether each CLI is on your PATH |
| `sethji init [--out crew.json] [--force]` | Write the default crew config to edit. Refuses to overwrite an existing file without `--force` |
| `sethji help` / `sethji version` | Help / version |

`run` uses `./crew.json` when present, logs every run to `.sethji/runs/<stamp>/`
(`transcript.md`, `result.json`, per-role logs), and in a git repo starts on a fresh
`sethji/run-<stamp>` branch unless you pass `--no-branch`. `--tmux` opens one pane per role.
It exits `0` on PASS and `1` on FAIL. Ctrl-C (or SIGTERM) stops the running agent too and
still writes the logs.

## Modes (how much a delegated agent may touch)

| Mode | Access | Maps to |
| --- | --- | --- |
| `read` | inspect only — **default, safe** | claude `--allowedTools Read,Grep,Glob` · codex `--sandbox read-only` · gemini `-p` |
| `write` | may edit files | claude `--permission-mode acceptEdits` · codex `--sandbox workspace-write` |
| `yolo` | full access | claude `--dangerously-skip-permissions` · codex `--sandbox danger-full-access` · gemini `-y` |

> **⚠️ Safety.** `write` lets an agent edit files in `--cwd`; `yolo` removes the agent's own
> guardrails entirely (full file + command access). Only use them in a repo you can revert
> (commit first), and never point `yolo` at a directory you can't afford to lose. Default to
> `read`. Headless flags for each CLI drift — confirm with `<cli> --help` before trusting them.

## Crew config

```json
{
  "roles": {
    "architect": { "agent": "claude", "mode": "read",  "persona": "..." },
    "coder":     { "agent": "codex",  "mode": "write", "persona": "..." },
    "qa":        { "agent": "gemini", "mode": "read",  "persona": "..." }
  },
  "workflow": ["architect", "coder", "qa"],
  "loop": { "from": "qa", "to": "coder", "maxRounds": 2 }
}
```

- **roles** — each maps a role name to an `agent` (adapter), a `mode`, and a `persona`
  (the system instruction for that role). Optional `model` and `effort` override the
  model and reasoning effort for that role (passed via the adapter's `modelFlag` /
  `effortFlag`; built-in claude takes both, codex maps effort to
  `-c model_reasoning_effort=…`, gemini takes neither).
  Role names may use only letters, digits, `_` and `-` (they become log file names).
- **workflow** — the order roles run in.
- **loop** — after `from` (QA) runs, its verdict is parsed. On `VERDICT: FAIL` with rounds
  left, control jumps back to `to` (coder) and continues. An **unknown or missing verdict
  counts as PASS**, so the loop can never spin forever.
- **agent errors** — if any agent crashes, times out, is stopped, or its CLI is missing,
  the run ends right there as **FAIL** with that error as the reason. A crew that did not
  actually run never reports PASS.

### Personas

- **architect** — writes a numbered plan + acceptance criteria, no full code.
- **coder** — implements the plan exactly and addresses QA feedback.
- **qa** — reviews and ends with EXACTLY one line: `VERDICT: PASS` or `VERDICT: FAIL: <reason>`.

Each turn's prompt is: role persona + the task + the full transcript so far +
"respond as `<ROLE>`". The transcript is the relay channel between agents.

### Declare the AIs you have — the `agents` roster

The optional **`agents`** block in your crew config is where you list the AIs available on
your machine. Add brand-new agents or override a built-in's `bin`/`modes`. Each entry is
pure data — `bin` plus a `modes` map whose arrays are argv templates; the literal `{prompt}`
token is replaced with the real prompt as one argv element. Optional `modelFlag` and
`effortFlag` are what let a role's `model`/`effort` fields be passed through — a string
becomes `<flag> <value>` (e.g. `"model": "opus"` → `--model opus`), an array is an argv
template with `{model}`/`{effort}` placeholders (codex's effort is
`["-c", "model_reasoning_effort={effort}"]`):

```json
{
  "agents": {
    "claude": { "bin": "claude" },
    "qwen": {
      "bin": "ollama",
      "modes": {
        "read":  ["run", "qwen2.5-coder", "{prompt}"],
        "write": ["run", "qwen2.5-coder", "{prompt}"],
        "yolo":  ["run", "qwen2.5-coder", "{prompt}"]
      }
    }
  },
  "roles": {
    "architect": { "agent": "claude", "mode": "read",  "persona": "..." },
    "coder":     { "agent": "qwen",   "mode": "write", "persona": "..." },
    "qa":        { "agent": "claude", "mode": "read",  "persona": "..." }
  },
  "workflow": ["architect", "coder", "qa"],
  "loop": { "from": "qa", "to": "coder", "maxRounds": 2 }
}
```

A role's `agent` must name either a built-in (`claude`, `codex`, `gemini`) or something you
declared here. Check what's wired up with `sethji list --crew crew.json` — your custom
agents show with a `(custom)` tag and an installed/not-found status.

#### Using a local model (ollama + qwen)

```bash
ollama serve &                                  # start the server
ollama pull qwen2.5-coder                       # install the model
sethji list --crew crew.json                    # confirm "ollama  installed"
sethji run "add /health endpoint" --crew crew.json
```

> **How collaboration actually works.** sethji is an *orchestrator*, not a router — it does
> not make Claude internally call qwen. It runs each CLI as a **separate child process** and
> relays text between them through the transcript: claude's plan → fed as the prompt to qwen
> → qwen's output → fed back to claude QA. They cooperate via passed text.
>
> **Caveat for local models as the *coder*.** `claude`/`codex` edit files themselves in
> `--cwd`. `ollama run qwen` only **prints to stdout** — it has no file-write tool, so a qwen
> "coder" emits code as text without writing it to disk. Keep local models in text roles
> (architect/QA) and let `claude`/`codex` be the writer, unless you wrap the model in your own
> apply-the-diff step.

## Menu-bar app (macOS)

A tiny native front-end in the single-file-swiftc style — no Xcode project, no deps:

```bash
./app/install_app.sh      # builds with swiftc → ~/Applications/sethji.app, launches it
./app/uninstall_app.sh    # removes it
```

A **sethji** wordmark appears in the menu bar — it pulses `●` while the crew runs
and shows `✓`/`✗` when it finishes. Click it: pick a project folder, type a task,
**Run crew**. The panel shows the crew pipeline as chips (`ARCHITECT → CODER → QA`)
that light up as each agent takes its turn, the same live stream as the terminal
with colored role headers, a runtime clock, a loop-round badge, and a verdict
banner — plus a notification when the run ends. `Logs` opens `.sethji/runs/` for
that folder. If `./crew.json` exists in the chosen folder it is used automatically
(and drawn as the pipeline), exactly like the CLI. **⚙ Crew setup** expands a
per-role row — pick the AI (built-ins plus any agents declared in `crew.json`),
a model (dropdown of suggestions, free text allowed), and an effort level.
Overrides are remembered per project folder and passed to the CLI as
`--agent`/`--model`/`--effort role=value,…` flags. The dropdown suggestions come
from `models.json` in the app bundle; put your own list at
`~/.config/sethji/models.json` to override it.

Requires the Xcode Command Line Tools (`swiftc`). The app runs `sethji` from your
PATH, falling back to this repo's `bin/cli.js` via `node` — the installer wires that
up. Right-click the wordmark for Logs/Quit. **Stop** sends SIGTERM to the CLI; an
agent mid-write may leave partial edits, so same rule as always: run in a repo you
can revert.

## Programmatic API

```js
import { orchestrate, DEFAULT_CREW } from "sethji";

const { transcript, verdict, rounds } = await orchestrate({
  task: "add a /health endpoint",
  crew: DEFAULT_CREW,
  cwd: process.cwd(),
});
```

## Develop

```bash
npm test     # node --test, no network, uses a stub agent
```

## License

[MIT](./LICENSE) © Yashwant Midha. Free to use, modify, and distribute — see the
[LICENSE](./LICENSE) file for the full text.

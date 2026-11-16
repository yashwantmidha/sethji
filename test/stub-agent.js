#!/usr/bin/env node
// A fake agent CLI for tests — no network, no real model.
// Usage: node stub-agent.js <kind> "<prompt>"
// It prints a canned response based on <kind> and exits 0.
//   plan -> a numbered plan
//   code -> a pretend implementation note
//   pass -> a QA review ending in VERDICT: PASS
//   fail -> a QA review ending in VERDICT: FAIL: <reason>
//   boom -> exit non-zero (to test error handling)
const kind = process.argv[2];
const prompt = process.argv[3] || "";

// `node --test` discovers every file under test/ and runs it. When this stub
// is run that way (no kind argument) it must be an inert, passing file.
if (kind === undefined) process.exit(0);

const canned = {
  plan: "PLAN:\n1. Do the thing.\n2. Verify the thing.\nAcceptance: thing works.",
  code: "Implemented the plan. Edited 2 files.",
  pass: "Reviewed the work. Looks correct.\nVERDICT: PASS",
  fail: "Found a problem with the work.\nVERDICT: FAIL: missing tests",
};

if (kind === "boom") {
  process.stderr.write("stub failure\n");
  process.exit(3);
}

if (kind === "split") {
  // A multibyte char ("✓" is 3 bytes) torn across two stdout chunks.
  const bytes = Buffer.from("✓ ok\n");
  process.stdout.write(bytes.subarray(0, 2));
  setTimeout(() => process.stdout.write(bytes.subarray(2)), 50);
} else if (kind === "stdin") {
  // Like `codex exec`: wait for stdin to end before answering.
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write("stdin closed\n"));
} else if (kind === "models" || kind === "nomodels") {
  // Shaped like `ollama list`: a header row, then one model per line.
  process.stdout.write("NAME    ID    SIZE\n");
  if (kind === "models") process.stdout.write("pass    aaa   1 GB\ncode    bbb   2 GB\n");
} else if (kind === "hang") {
  // Announce our pid, then never finish — for stop/signal tests.
  process.stdout.write(`PID ${process.pid}\n`);
  setInterval(() => {}, 1000);
} else if (kind === "draft") {
  // What a drafting agent would reply to `sethji plan`.
  process.stdout.write(
    JSON.stringify({
      roles: { solo: { agent: "claude", mode: "read", persona: "p" } },
      workflow: ["solo"],
      check: ["npm", "test"],
    }) + "\n"
  );
} else {
  const out = canned[kind];
  if (out === undefined) {
    process.stderr.write(`stub-agent: unknown kind "${kind}"\n`);
    process.exit(2);
  }
  process.stdout.write(out + "\n");
  process.exit(0);
}

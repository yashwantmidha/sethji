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

// Echo a marker so tests can confirm the prompt was passed through if needed.
const out = canned[kind];
if (out === undefined) {
  process.stderr.write(`stub-agent: unknown kind "${kind}"\n`);
  process.exit(2);
}
process.stdout.write(out + "\n");
process.exit(0);

// Main benchmark runner
// Runs all benchmarks and prints results; exits 1 if any budget is exceeded.

import { runDiffBenchmarks } from "./diff.bench.js";
import { runReplayBenchmark } from "./replay.bench.js";

const DIFF_BUDGET_MS = 2000;
const REPLAY_BUDGET_MS = 1000;

function fmt(ms: number): string {
  return ms.toFixed(1) + "ms";
}

function verdict(ms: number, budget: number): string {
  return ms < budget ? "PASS" : "FAIL";
}

// Run diff benchmarks
const { referenceMs, hirschbergMs } = runDiffBenchmarks();

// Run replay benchmark
const { replayMs } = runReplayBenchmark();

// Print results
console.log(
  `diff reference:   ${fmt(referenceMs).padStart(10)} (budget: <${DIFF_BUDGET_MS}ms) ${verdict(referenceMs, DIFF_BUDGET_MS)}`,
);
console.log(
  `diff hirschberg:  ${fmt(hirschbergMs).padStart(10)} (budget: <${DIFF_BUDGET_MS}ms) ${verdict(hirschbergMs, DIFF_BUDGET_MS)}`,
);
console.log(
  `replay 50 patches:${fmt(replayMs).padStart(10)} (budget: <${REPLAY_BUDGET_MS}ms) ${verdict(replayMs, REPLAY_BUDGET_MS)}`,
);

// Exit 1 if any budget exceeded
const allPass =
  referenceMs < DIFF_BUDGET_MS && hirschbergMs < DIFF_BUDGET_MS && replayMs < REPLAY_BUDGET_MS;

if (!allPass) {
  process.exit(1);
}

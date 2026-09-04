// Benchmark: diff algorithm (reference DP vs Hirschberg)
// Budget: both < 2000ms for 5000-token inputs with ~30% edit distance

import { diffReference, diffHirschberg } from "../src/core/diff.js";
import type { DiffScript } from "../src/core/diff.js";

// Build two 5000-token arrays from a 4-token alphabet with ~30% edit distance.
// Strategy: start with a base sequence, then for the second array swap ~30% of positions
// with a different token from the alphabet.
function buildInputs(size: number): { A: readonly string[]; B: readonly string[] } {
  const alphabet = ["alpha\n", "beta\n", "gamma\n", "delta\n"];
  const A: string[] = [];
  for (let i = 0; i < size; i++) {
    A.push(alphabet[i % alphabet.length]!);
  }

  // Build B with ~30% differences: replace tokens at positions divisible by ~3
  const B: string[] = [];
  for (let i = 0; i < size; i++) {
    if (i % 10 < 3) {
      // ~30% positions: pick a different token
      const base = i % alphabet.length;
      B.push(alphabet[(base + 1) % alphabet.length]!);
    } else {
      B.push(A[i]!);
    }
  }

  return { A, B };
}

export function runDiffBenchmarks(): {
  referenceMs: number;
  hirschbergMs: number;
} {
  const { A, B } = buildInputs(5000);

  // Warm up (small run to avoid JIT cold-start skewing the measurement)
  const warmA = A.slice(0, 100);
  const warmB = B.slice(0, 100);
  diffReference(warmA, warmB);
  diffHirschberg(warmA, warmB);

  // Benchmark diffReference
  const refStart = performance.now();
  const _refResult: DiffScript = diffReference(A, B);
  const referenceMs = performance.now() - refStart;

  // Benchmark diffHirschberg
  const hirStart = performance.now();
  const _hirResult: DiffScript = diffHirschberg(A, B);
  const hirschbergMs = performance.now() - hirStart;

  return { referenceMs, hirschbergMs };
}

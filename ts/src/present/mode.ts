// SNAP_COLOR / NO_COLOR / per-stream TTY auto color mode selection
// SPEC §7.11

export type ColorMode = "auto" | "always" | "never";

/**
 * Determine if color should be used for a given stream.
 * SPEC §7.11 SNAP_COLOR values:
 * - unset or "auto": terminal mode when that stream is a TTY, unless NO_COLOR is present
 * - "always": terminal mode on both streams, even when redirected; overrides NO_COLOR
 * - "never": plain mode on both streams
 */
export function colorMode(stream: NodeJS.WriteStream): boolean {
  const snapColor = process.env["SNAP_COLOR"];
  const noColor = "NO_COLOR" in process.env; // presence (even empty value) triggers

  if (snapColor === "always") {
    return true; // overrides NO_COLOR
  }

  if (snapColor === "never") {
    return false;
  }

  // "auto" (or unset)
  if (noColor) {
    return false; // NO_COLOR present → plain mode
  }

  // Check if stream is a TTY
  return stream.isTTY === true;
}

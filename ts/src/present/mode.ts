// SNAP_COLOR / NO_COLOR / per-stream TTY auto color mode selection

export type ColorMode = "auto" | "always" | "never";

// Determine effective color mode from SNAP_COLOR, NO_COLOR, and stream TTY status
export function colorMode(_stream: NodeJS.WriteStream): boolean {
  throw new Error("not implemented");
}

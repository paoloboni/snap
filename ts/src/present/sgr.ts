// S(n, text) ANSI SGR escape sequence formatting
// SPEC §7.11: S(n, text) = ESC[ + n + m + text + ESC[0m

/**
 * Apply SGR escape sequence n to text.
 * S(n, text) = "\x1b[" + n + "m" + text + "\x1b[0m"
 */
export function S(n: number, text: string): string {
  return `\x1b[${n}m${text}\x1b[0m`;
}

// Plain ↔ terminal renderer factories per output stream
// SPEC §7.11

import { colorMode } from "./mode.js";
import { S } from "./sgr.js";

export type Renderer = {
  /** Pass through unchanged */
  plain: (text: string) => string;
  /** SGR 1 bold */
  bold: (text: string) => string;
  /** SGR 2 dim */
  dim: (text: string) => string;
  /** SGR 31 red */
  red: (text: string) => string;
  /** SGR 32 green */
  green: (text: string) => string;
  /** SGR 33 yellow */
  yellow: (text: string) => string;
  /** SGR 35 magenta */
  magenta: (text: string) => string;
  /** SGR 36 cyan */
  cyan: (text: string) => string;
};

/**
 * Create a renderer for the given stream.
 * If color is enabled for that stream, uses SGR sequences; otherwise plain.
 */
export function makeRenderer(stream: NodeJS.WriteStream): Renderer {
  const useColor = colorMode(stream);

  if (!useColor) {
    return {
      plain: (text) => text,
      bold: (text) => text,
      dim: (text) => text,
      red: (text) => text,
      green: (text) => text,
      yellow: (text) => text,
      magenta: (text) => text,
      cyan: (text) => text,
    };
  }

  return {
    plain: (text) => text,
    bold: (text) => S(1, text),
    dim: (text) => S(2, text),
    red: (text) => S(31, text),
    green: (text) => S(32, text),
    yellow: (text) => S(33, text),
    magenta: (text) => S(35, text),
    cyan: (text) => S(36, text),
  };
}

// Plain ↔ terminal renderer factories per output stream
// SPEC §7.11

import { colorMode } from "./mode.js";
import { S } from "./sgr.js";

export type Renderer = {
  plain: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
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
      green: (text) => text,
      red: (text) => text,
    };
  }

  return {
    plain: (text) => text,
    bold: (text) => S(1, text),
    dim: (text) => S(2, text),
    green: (text) => S(32, text),
    red: (text) => S(31, text),
  };
}

// Plain ↔ terminal renderer factories per output stream

export type Renderer = {
  plain: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
};

// Create a renderer for the given stream (plain if no color, SGR if color)
export function makeRenderer(_stream: NodeJS.WriteStream): Renderer {
  throw new Error("not implemented");
}

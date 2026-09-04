// argv → discriminated Command union parser for the snap CLI

export type Command =
  | { cmd: "init"; path: string }
  | { cmd: "config"; key: string; value?: string }
  | { cmd: "add"; paths: readonly string[] }
  | { cmd: "diff"; oldSpec: string; newSpec?: string; repo?: string }
  | { cmd: "commit"; message: string }
  | { cmd: "log" }
  | { cmd: "merge"; url: string }
  | { cmd: "status" }
  | { cmd: "serve"; port: number }
  | { cmd: "version" };

// Parse argv (process.argv.slice(2)); throws SnapError on invalid command or arguments
export function parseArgs(_argv: readonly string[]): Command {
  throw new Error("not implemented");
}

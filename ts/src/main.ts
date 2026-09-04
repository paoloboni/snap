import { parseArgs } from "./cli/grammar.js";
import { dispatch, writeError } from "./cli/dispatch.js";
import { SnapError, errInternalError } from "./errors.js";

async function main(): Promise<void> {
  let exitCode: number;
  try {
    const cmd = parseArgs(process.argv.slice(2));
    exitCode = await dispatch(cmd, process.cwd());
  } catch (e) {
    if (e instanceof SnapError) {
      writeError(e.message);
      exitCode = e.exitCode;
    } else {
      const wrapped = errInternalError(e);
      writeError(wrapped.message);
      exitCode = 2;
    }
  }
  process.exit(exitCode);
}

void main();

import { parseArgs } from "./cli/grammar.js";
import { dispatch } from "./cli/dispatch.js";
import { SnapError, errInternalError } from "./errors.js";

async function main(): Promise<void> {
  let exitCode: number;
  try {
    const cmd = parseArgs(process.argv.slice(2));
    exitCode = await dispatch(cmd, process.cwd());
  } catch (e) {
    if (e instanceof SnapError) {
      process.stderr.write(e.message + "\n");
      exitCode = e.exitCode;
    } else {
      const wrapped = errInternalError(e);
      process.stderr.write(wrapped.message + "\n");
      exitCode = 2;
    }
  }
  process.exit(exitCode);
}

void main();

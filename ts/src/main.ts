import { parseArgs } from "./cli/grammar.js";
import { dispatch, reportError } from "./cli/dispatch.js";
import { errInternalError } from "./errors.js";
import { attemptAsync } from "./result.js";

async function main(): Promise<void> {
  // Snap itself never throws; this guard only catches genuine programming bugs
  // and maps them to the §7 "unexpected internal failure" contract (exit 2).
  const run = await attemptAsync(async () => {
    const cmd = parseArgs(process.argv.slice(2));
    if (!cmd.ok) {
      return reportError(cmd.error);
    }
    return await dispatch(cmd.value, process.cwd());
  }, errInternalError);

  process.exit(run.ok ? run.value : reportError(run.error));
}

void main();

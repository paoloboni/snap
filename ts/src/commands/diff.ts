// snap diff [<old> [<new>] [--repo <repo>]] — unified text diff between versions or working tree

// Run the diff command; returns exit code 0/1/2
export async function run(
  _oldSpec: string | undefined,
  _newSpec: string | undefined,
  _repo: string | undefined,
  _cwd: string,
): Promise<number> {
  throw new Error("not implemented");
}

// snap config [--global] contributor.id <id> — read or write contributor configuration

// Run the config command; returns exit code 0/1/2
export async function run(
  _key: string,
  _value: string | undefined,
  _global: boolean,
  _cwd: string,
): Promise<number> {
  throw new Error("not implemented");
}

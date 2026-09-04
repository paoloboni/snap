// §8 local-over-global configuration resolution for contributor ID

export type Config = { contributorId?: string };

// Read config: local (.snap/config.json) overrides global (~/.config/snap/config.json)
export async function readConfig(_repoDir: string): Promise<Config> {
  throw new Error("not implemented");
}

// Write local config to .snap/config.json
export async function writeLocalConfig(_repoDir: string, _config: Config): Promise<void> {
  throw new Error("not implemented");
}

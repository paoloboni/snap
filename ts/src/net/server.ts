// --serve snapshot server binding 127.0.0.1, serving GET /repository.json, exits on SIGTERM/SIGINT

// Start snapshot server on the given port; prints one line to stdout; exits 0 on SIGTERM/SIGINT
export async function serve(_repoDir: string, _port: number): Promise<never> {
  throw new Error("not implemented");
}

// Single validated HTTP GET for fetching a remote repository (no redirects, one request)

import type { Repository } from "../repo/model.js";

// Fetch a remote repository via HTTP GET (exactly one request); throws SnapError on redirect or HTTP error
export async function fetchRemote(_url: string): Promise<Repository> {
  throw new Error("not implemented");
}

// --serve snapshot server binding 127.0.0.1, serving GET /repository.json, exits on SIGTERM/SIGINT
// SPEC §7.9, §9

import * as http from "node:http";
import { readRepository } from "../repo/store.js";
import { serializeRepository } from "../repo/json.js";
import { errInternalError } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

/**
 * Start snapshot server on the given port.
 * - Reads and validates the repository at startup (error value on invalid repo)
 * - Binds to 127.0.0.1 only
 * - Serves GET/HEAD /repository.json with the startup snapshot (canonical JSON)
 * - Other paths → 404; other methods → 405 with Allow: GET, HEAD
 * - PLAN.md §7.5 rule 8: raw exact request-target match (?query → 404)
 * - Prints exactly one line to stdout: http://127.0.0.1:<port>/repository.json
 * - Exits 0 on SIGTERM or SIGINT
 */
export async function serve(repoDir: string, port: number): Promise<SnapResult<never>> {
  // Validate and snapshot the repository at startup
  const repo = await readRepository(repoDir);
  if (!repo.ok) return err(repo.error);

  const body = serializeRepository(repo.value);
  const bodyBuffer = Buffer.from(body, "utf8");

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    // req.url is the raw request-target including any query string
    const target = req.url ?? "/";

    // PLAN.md §7.5 rule 8: exact request-target match (query string → 404)
    if (target !== "/repository.json") {
      res.writeHead(404);
      res.end();
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": bodyBuffer.length,
    });

    if (method === "HEAD") {
      res.end();
    } else {
      res.end(bodyBuffer);
    }
  });

  // Bind. A listen failure resolves as an error value rather than rejecting.
  const listened = await new Promise<SnapResult<void>>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(ok(undefined));
    });
    server.on("error", (e: Error) => {
      resolve(err(errInternalError(e)));
    });
  });
  if (!listened.ok) return err(listened.error);

  const address = server.address();
  if (address === null || typeof address === "string") {
    return err(errInternalError(new Error("Failed to get server address")));
  }

  const actualPort = address.port;
  // Always print plain (SPEC §7.9, §7.11: "startup URL always remains plain")
  process.stdout.write(`http://127.0.0.1:${actualPort}/repository.json\n`);

  // Wait for SIGTERM or SIGINT, then exit 0
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => {
      server.close(() => resolve());
    });
    process.once("SIGINT", () => {
      server.close(() => resolve());
    });
  });

  process.exit(0);
}

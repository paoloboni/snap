// --serve snapshot server binding 127.0.0.1, serving GET /repository.json, exits on SIGTERM/SIGINT
// SPEC §7.9, §9

import * as http from "node:http";
import * as nodePath from "node:path";
import * as fs from "node:fs/promises";

/**
 * Start snapshot server on the given port.
 * - Binds to 127.0.0.1 only
 * - Serves GET/HEAD /repository.json with the startup snapshot
 * - Other paths → 404; other methods → 405 with Allow: GET, HEAD
 * - Prints exactly one line to stdout: http://127.0.0.1:<port>/repository.json
 * - Exits 0 on SIGTERM or SIGINT
 */
export async function serve(repoDir: string, port: number): Promise<never> {
  // Read the snapshot at startup
  const repoJsonPath = nodePath.join(repoDir, ".snap", "repository.json");
  const snapshot = await fs.readFile(repoJsonPath, "utf8");

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const target = req.url ?? "/";

    if (target !== "/repository.json") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain",
      });
      res.end("Method Not Allowed");
      return;
    }

    const body = Buffer.from(snapshot, "utf8");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
    });

    if (method === "HEAD") {
      res.end();
    } else {
      res.end(body);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
    server.on("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to get server address");
  }

  const actualPort = address.port;
  // Always print plain (SPEC §7.9: "startup URL always remains plain")
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

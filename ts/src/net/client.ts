// Single validated HTTP GET for fetching a remote repository (no redirects, one request)
// SPEC §9: "When a repository operand starts with http:// or https://, Snap performs
// one GET of that exact URL, requires status 200, parses the body as a repository value"

import * as https from "node:https";
import * as http from "node:http";
import type { Repository } from "../repo/model.js";
import { validateRepository } from "../repo/validate.js";
import { parseJSON } from "../repo/json.js";
import { errHttpRedirect, errInvalidJson } from "../errors.js";

/**
 * Fetch a remote repository via HTTP GET (exactly one request).
 * - Requires status 200
 * - Rejects redirects (3xx) with errHttpRedirect
 * - Parses body as JSON and validates as Repository
 */
export async function fetchRemote(url: string): Promise<Repository> {
  const body = await httpGet(url);
  let raw: unknown;
  try {
    raw = parseJSON(body);
  } catch {
    throw errInvalidJson();
  }
  return validateRepository(raw);
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const mod = isHttps ? https : http;

    const req = mod.get(url, (res) => {
      const statusCode = res.statusCode ?? 0;

      // Handle redirects (3xx)
      if (statusCode >= 300 && statusCode < 400) {
        req.destroy();
        reject(errHttpRedirect(statusCode));
        return;
      }

      // Any non-200 status is an error
      if (statusCode !== 200) {
        req.destroy();
        reject(errInvalidJson());
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body);
      });
      res.on("error", (err: Error) => {
        reject(err);
      });
    });

    req.on("error", (err: Error) => {
      reject(err);
    });
  });
}

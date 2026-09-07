// Single validated HTTP GET for fetching a remote repository (no redirects, one request)
// SPEC §9: "When a repository operand starts with http:// or https://, Snap performs
// one GET of that exact URL, requires status 200, parses the body as a repository value"

import * as https from "node:https";
import * as http from "node:http";
import type { Repository } from "../repo/model.js";
import { validateRepository } from "../repo/validate.js";
import { parseJSON } from "../repo/json.js";
import { errHttpRedirect, errInvalidJson, errInternalError } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

/**
 * Fetch a remote repository via HTTP GET (exactly one request).
 * - Requires status 200
 * - Rejects redirects (3xx) with errHttpRedirect
 * - Parses body as JSON and validates as Repository
 */
export async function fetchRemote(url: string): Promise<SnapResult<Repository>> {
  const body = await httpGet(url);
  if (!body.ok) return err(body.error);

  const raw = parseJSON(body.value);
  if (!raw.ok) {
    // Any parse failure on a remote body surfaces as plain invalid JSON.
    return err(errInvalidJson());
  }

  return validateRepository(raw.value);
}

/**
 * Perform the single GET. The returned promise always resolves — transport and
 * status failures come back as error values rather than rejections.
 */
function httpGet(url: string): Promise<SnapResult<string>> {
  return new Promise((resolve) => {
    const isHttps = url.startsWith("https://");
    const mod = isHttps ? https : http;

    const req = mod.get(url, (res) => {
      const statusCode = res.statusCode ?? 0;

      // Handle redirects (3xx)
      if (statusCode >= 300 && statusCode < 400) {
        req.destroy();
        resolve(err(errHttpRedirect(statusCode)));
        return;
      }

      // Any non-200 status is an error
      if (statusCode !== 200) {
        req.destroy();
        resolve(err(errInvalidJson()));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve(ok(Buffer.concat(chunks).toString("utf8")));
      });
      res.on("error", (e: Error) => {
        resolve(err(errInternalError(e)));
      });
    });

    req.on("error", (e: Error) => {
      resolve(err(errInternalError(e)));
    });
  });
}

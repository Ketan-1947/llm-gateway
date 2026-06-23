// API-key auth.
// Phase 5: supports hashed keys (production) and plaintext keys (dev), with a
// timing-safe comparison. Auth is disabled only when BOTH lists are empty.

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string compare (avoids leaking match length via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authEnabled(): boolean {
  return config.gatewayApiKeys.length > 0 || config.gatewayApiKeyHashes.length > 0;
}

function tokenAccepted(token: string): boolean {
  for (const k of config.gatewayApiKeys) if (safeEqual(token, k)) return true;
  const h = sha256Hex(token);
  for (const hash of config.gatewayApiKeyHashes) if (safeEqual(h, hash)) return true;
  return false;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers["authorization"];
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
}

export async function apiKeyAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!authEnabled()) return; // dev mode

  const token = bearerToken(req);
  if (!token || !tokenAccepted(token)) {
    reply.code(401).send({
      error: {
        code: "unauthorized",
        message: "Missing or invalid API key. Send 'Authorization: Bearer <key>'.",
      },
    });
  }
}

/** Stable, non-reversible id for the calling key (for per-key stats/limits).
 *  Never store or log the raw key. Returns "anonymous" when auth is off. */
export function requestKeyId(req: FastifyRequest): string {
  const token = bearerToken(req);
  if (!token) return "anonymous";
  return "key_" + sha256Hex(token).slice(0, 12);
}

// Entry point. Wires config -> adapters -> routes -> Fastify, serves the web UI
// at /, and maps GatewayError into the consistent error envelope.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ClaudeAdapter } from "./providers/claudeAdapter.js";
import { OpenAIAdapter } from "./providers/openaiAdapter.js";
import { ProviderManager } from "./providers/dispatch.js";
import { BudgetTracker } from "./services/budget.js";
import { RateLimiter } from "./services/rateLimit.js";
import { config } from "./config.js";
import { registerRoutes } from "./routes/routes.js";
import { registerOpenAICompatRoutes } from "./routes/openaiCompat.js";
import { InMemoryUsageStore } from "./services/usageStore.js";
import { GatewayError } from "./shared/types.js";

// Load the single-page UI (served at /). Looked up from cwd then module dir.
function loadUiHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    join(process.cwd(), "public", "index.html"),
    join(process.cwd(), "index.html"),
    join(here, "..", "public", "index.html"),
  ]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "<h1>LLM Gateway</h1><p>index.html not found next to the server.</p>";
}
const UI_HTML = loadUiHtml();

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // Consistent error envelope for everything that throws.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GatewayError) {
      reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message },
      });
      return;
    }
    if ((err as { validation?: unknown }).validation) {
      reply.code(400).send({
        error: { code: "invalid_request", message: (err as Error).message },
      });
      return;
    }
    app.log.error(err);
    reply.code(500).send({
      error: { code: "internal_error", message: "Unexpected server error." },
    });
  });

  const manager = new ProviderManager([
    new ClaudeAdapter(),
    new OpenAIAdapter(),
  ]);
  const usage = new InMemoryUsageStore();
  const limiter = new RateLimiter();
  const budget = new BudgetTracker();
  const services = { manager, usage, limiter, budget };
  registerRoutes(app, services);
  registerOpenAICompatRoutes(app, services); // OpenAI-compatible facade

  // Web UI (public, no auth).
  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(UI_HTML);
  });

  if (config.gatewayApiKeys.length === 0 && config.gatewayApiKeyHashes.length === 0) {
    app.log.warn(
      "No GATEWAY_API_KEYS or GATEWAY_API_KEY_HASHES set — API-key auth is DISABLED. Do not run like this in production.",
    );
  }
  if (!config.openaiApiKey) {
    app.log.warn(
      "OPENAI_API_KEY is empty — complexity analysis and OpenAI fallback routing will fail.",
    );
  }
  if (!config.anthropicApiKey) {
    app.log.warn(
      "ANTHROPIC_API_KEY is empty — using OpenAI-only routing targets.",
    );
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Web UI:  http://localhost:${config.port}/`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
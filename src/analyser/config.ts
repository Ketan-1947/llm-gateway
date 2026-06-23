import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export function loadEnvFile(path = ".env"): void {
  const candidatePaths = [
    resolve(path),
    resolve(currentDirectory, "../../.env"),
  ];

  const envPath = candidatePaths.find((candidatePath) => existsSync(candidatePath));

  if (!envPath) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = stripped.split("=");
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");

    if (!(key.trim() in process.env)) {
      process.env[key.trim()] = value;
    }
  }
}

loadEnvFile();

// Model used only for complexity classification.
export const CLASSIFIER_MODEL = "gpt-4.1-mini";
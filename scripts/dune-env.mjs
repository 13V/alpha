import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load .env.local then .env into process.env without pulling in a dependency. */
export function loadEnv(root = process.cwd()) {
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

const DUNE_API = "https://api.dune.com/api/v1";

export async function duneFetch(path, apiKey, init = {}) {
  const res = await fetch(`${DUNE_API}${path}`, {
    ...init,
    headers: {
      "X-Dune-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const message = body?.error ?? body?.message ?? `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return body;
}

export const EVM_CHAINS = ["base", "bnb", "ethereum", "arbitrum", "optimism", "polygon"];

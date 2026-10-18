// Shared by the sandbox scripts and the live test config.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The only names ever taken from .dev.vars. Anything else in the file is skipped
// without being stored.
const WANTED = ["PAYPAL_MODE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"];

export function loadSandboxEnv() {
  const env = {};
  const file = path.join(ROOT, ".dev.vars");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || !WANTED.includes(m[1])) continue;
      env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  for (const name of WANTED) if (process.env[name]) env[name] = process.env[name];
  return env;
}

export function sandboxReady(env = loadSandboxEnv()) {
  return env.PAYPAL_MODE === "sandbox" && Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

// The app's own client, compiled on the fly so scripts and app cannot drift.
export async function sandboxClient({ quiet = true } = {}) {
  const env = loadSandboxEnv();
  if (!sandboxReady(env)) {
    throw new Error("Set PAYPAL_MODE=sandbox, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .dev.vars first.");
  }
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [path.join(ROOT, "src/paypal/live.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  return new mod.LivePayPal({
    apiBase: mod.SANDBOX_API,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    log: quiet ? () => {} : undefined,
  });
}

// Replace everything that identifies an account or a transaction, keep the shape.
export function redact(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value !== "string") return value;
  if (/(^|_)(id|sig)$/.test(key) || key === "invoice_id") return key === "custom_id" || key === "reference_id" ? "BK-XXXXXX" : `<${key.toUpperCase()}>`;
  if (/email/.test(key)) return "<EMAIL>";
  if (/^(given_name|surname|full_name)$/.test(key)) return "<NAME>";
  if (/_time$/.test(key)) return "<TIME>";
  if (/phone|number|address_line|postal_code/.test(key)) return "<REDACTED>";
  return value
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<EMAIL>")
    .replace(/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{12,}\b/g, "<ID>");
}

export const shortRef = (id) => (typeof id === "string" && id.length > 6 ? `${id.slice(0, 2)}…${id.slice(-3)}` : "<none>");

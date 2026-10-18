// Registers the desk's PayPal webhook on the sandbox (or prints the one that is
// already there) and writes its id to .dev.vars. Usage:
//   node scripts/sandbox-webhook.mjs https://<public address>
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSandboxEnv, ROOT } from "./lib.mjs";

const API = "https://api-m.sandbox.paypal.com";
const EVENTS = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"];

const origin = process.argv[2]?.replace(/\/$/, "");
if (!origin) {
  console.error("give the public address of the deployed desk");
  process.exit(1);
}
const url = `${origin}/api/webhooks/paypal`;
const env = loadSandboxEnv();

const tokenRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"),
    "content-type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
const { access_token } = await tokenRes.json();
const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

const listed = await (await fetch(`${API}/v1/notifications/webhooks`, { headers })).json();
let hook = (listed.webhooks ?? []).find((w) => w.url === url);
if (hook) {
  console.log(`webhook already registered: ${hook.id}`);
} else {
  const res = await fetch(`${API}/v1/notifications/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  hook = body;
  console.log(`webhook created: ${hook.id}`);
}
console.log("events:", hook.event_types.map((e) => e.name).join(", "));

const file = path.join(ROOT, ".dev.vars");
const text = readFileSync(file, "utf8");
if (/^PAYPAL_WEBHOOK_ID=/m.test(text)) {
  writeFileSync(file, text.replace(/^PAYPAL_WEBHOOK_ID=.*$/m, `PAYPAL_WEBHOOK_ID=${hook.id}`));
} else {
  appendFileSync(file, `PAYPAL_WEBHOOK_ID=${hook.id}\n`);
}
console.log("id written to .dev.vars");

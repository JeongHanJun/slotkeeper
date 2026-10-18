import { LIVE_API, SANDBOX_API, type LiveConfig } from "./live";

// Decides which PayPal the app talks to, from environment values alone.
//
//   PAYPAL_MODE unset or "mock"  -> built-in stand-in, no network
//   PAYPAL_MODE "sandbox"        -> api-m.sandbox.paypal.com
//
// Anything else stops the app. Real-money mode exists only behind a second
// switch that has to be set on purpose and is not part of any documented setup.

export interface PayPalEnv {
  PAYPAL_MODE?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_WEBHOOK_SIMULATOR?: string;
  PAYPAL_LIVE_ACK?: string;
}

const LIVE_ACK = "real-money";

export type PayPalChoice = { mode: "mock" } | { mode: "sandbox" | "live"; config: LiveConfig };

export function resolvePayPal(env: PayPalEnv): PayPalChoice {
  const mode = env.PAYPAL_MODE ?? "mock";
  if (mode === "mock") return { mode };

  const live = mode === "live" && env.PAYPAL_LIVE_ACK === LIVE_ACK;
  if (mode !== "sandbox" && !live) {
    throw new Error(`PAYPAL_MODE must be "mock" or "sandbox" (got "${mode}")`);
  }
  const expected = live ? LIVE_API : SANDBOX_API;
  const apiBase = (env.PAYPAL_API_BASE ?? expected).replace(/\/$/, "");
  if (apiBase !== expected) {
    throw new Error(`PAYPAL_API_BASE must be ${expected} in ${mode} mode`);
  }
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error(`PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in ${mode} mode`);
  }
  return {
    mode: live ? "live" : "sandbox",
    config: {
      apiBase,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
      acceptSimulator: !live && env.PAYPAL_WEBHOOK_SIMULATOR === "on",
      allowLive: live,
    },
  };
}

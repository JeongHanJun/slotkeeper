import { DurableObject } from "cloudflare:workers";
import { createApp } from "./app";
import { OpenAiLlm } from "./llm/openai";
import { StubLlm } from "./llm/stub";
import type { Llm } from "./llm/types";
import type { PayPalClient } from "./paypal/client";
import { resolvePayPal } from "./paypal/config";
import { LivePayPal } from "./paypal/live";
import { MockPayPal } from "./paypal/mock";
import { pricesFromEnv, WorkersAiLlm } from "./llm/workersai";
import { DurableStore } from "./store";
import type { Env } from "./index";

// One desk = one Durable Object. All of a desk's requests arrive at this single
// instance, so the app's one-at-a-time queue really is the only writer, and the
// object's own storage commits each step atomically. KV offers neither: it has
// no compare-and-set and reads can be a minute stale.
//
// The alarm replaces a cron trigger: it fires when the next hold runs out, or
// every few seconds while an order is waiting for its payer.

type App = ReturnType<typeof createApp>;

export class Desk extends DurableObject<Env> {
  private app?: App;
  private appOrigin?: string;

  async fetch(request: Request): Promise<Response> {
    const origin = this.env.PUBLIC_BASE_URL ?? new URL(request.url).origin;
    if (origin !== this.appOrigin) await this.ctx.storage.put("origin", origin);
    const app = this.appFor(origin);
    const response = await app.handle(request);
    if (request.method !== "GET" || new URL(request.url).pathname === "/api/return") {
      await this.schedule(app);
    }
    return response ?? new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    // The alarm has no request to take the public address from; use the last one seen.
    const origin = this.env.PUBLIC_BASE_URL ?? (await this.ctx.storage.get<string>("origin"));
    if (!origin) return;
    const app = this.appFor(origin);
    try {
      await app.housekeeping();
    } catch (err) {
      console.log(JSON.stringify({ src: "alarm", error: err instanceof Error ? err.message : String(err) }));
    }
    await this.schedule(app);
  }

  private async schedule(app: App): Promise<void> {
    const wake = await app.nextWake();
    if (wake === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(wake);
  }

  private appFor(origin: string): App {
    if (this.app && this.appOrigin === origin) return this.app;
    const env = this.env;
    const store = new DurableStore(this.ctx.storage);
    const host = new URL(origin).hostname;
    this.app = createApp({
      store,
      paypal: paypalFor(env, store, origin),
      llm: llmFor(env, store),
      baseUrl: origin,
      demoControls: env.DEMO_CONTROLS === "on",
      wallClock: () => Date.now(),
      passcode: env.DESK_PASSCODE || undefined,
      // With no passcode the desk only opens on the developer's own machine.
      openDesk: host === "127.0.0.1" || host === "localhost",
    });
    this.appOrigin = origin;
    return this.app;
  }
}

function paypalFor(env: Env, store: DurableStore, origin: string): PayPalClient {
  const choice = resolvePayPal(env);
  return choice.mode === "mock" ? new MockPayPal(store, origin) : new LivePayPal(choice.config);
}

const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function llmFor(env: Env, store: DurableStore): Llm {
  if (env.LLM_MODE === "workers-ai" && env.AI) {
    return new WorkersAiLlm(env.AI, env.LLM_MODEL || DEFAULT_WORKERS_AI_MODEL, store, pricesFromEnv(env as unknown as Record<string, unknown>));
  }
  if (env.LLM_MODE === "openai" && env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL) {
    return new OpenAiLlm({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL });
  }
  return new StubLlm();
}

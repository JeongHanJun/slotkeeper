import { Desk } from "./desk";
import type { PayPalEnv } from "./paypal/config";

export { Desk };

export interface Env extends PayPalEnv {
  DESK: DurableObjectNamespace<Desk>;
  ASSETS: Fetcher;
  // Passcode for the owner's desk. Required anywhere but localhost.
  DESK_PASSCODE?: string;
  // "stub" (default), "workers-ai" (the AI binding below) or "openai".
  LLM_MODE?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  AI?: Ai;
  DAILY_NEURON_BUDGET?: string;
  LLM_NEURONS_PER_M_INPUT?: string;
  LLM_NEURONS_PER_M_OUTPUT?: string;
  DEMO_CONTROLS?: string;
  PUBLIC_BASE_URL?: string;
}

// Webhook events are the largest thing anyone sends; they stay well under this.
const MAX_BODY_BYTES = 300_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/mock/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      // Read the body here, with a cap, so the desk never waits on a slow or
      // oversized upload while other requests queue behind it.
      let forward = request;
      if (request.body) {
        const body = await request.arrayBuffer();
        if (body.byteLength > MAX_BODY_BYTES) return fail(413, "body too large");
        forward = new Request(request, { body });
      }
      // One desk for now. A desk per visitor is a different name here.
      const desk = env.DESK.get(env.DESK.idFromName("main"));
      return await desk.fetch(forward);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ src: "worker", path: pathname, error: message }));
      return fail(500, message);
    }
  },
};

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

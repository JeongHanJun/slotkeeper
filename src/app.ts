import {
  approveProposal,
  declineProposal,
  handleInquiry,
  moveBooking,
  onPayPalEvent,
  reconcile,
  settleOrder,
  tick,
  waitlistInquiry,
  type Ctx,
} from "./agent";
import { clearCookie, hasSession, passcodeMatches, RateLimiter, sessionCookie } from "./auth";
import { StubLlm } from "./llm/stub";
import type { Llm } from "./llm/types";
import type { PayPalClient } from "./paypal/client";
import { MockPayPal } from "./paypal/mock";
import type { WebhookEvent } from "./paypal/types";
import { newInquiry, sampleMessages } from "./seed";
import { ConflictError, loadState, resetState, saveState } from "./state";
import type { Store } from "./store";

// HTTP surface of the desk. Built from plain dependencies so the same code runs
// in the Durable Object and in tests.

export interface AppDeps {
  store: Store;
  paypal: PayPalClient;
  llm: Llm;
  baseUrl: string;
  demoControls: boolean;
  wallClock: () => number;
  // Passcode for the owner's desk. Leave out only where the app cannot be
  // reached by strangers; `openDesk` says whether that is the case.
  passcode?: string;
  openDesk?: boolean;
}

const MINUTE = 60_000;
const MAX_BODY = 8_000;
const MAX_WEBHOOK_BODY = 256_000;
const ORDER_ID = /^[A-Z0-9]{10,30}$/;
const CHANNELS = ["email", "instagram", "web"];
// How often waiting orders are looked up at PayPal when no webhook has arrived.
const POLL_MS = 25_000;

export function createApp(deps: AppDeps) {
  const { store, paypal, llm } = deps;
  const mock = paypal instanceof MockPayPal ? paypal : undefined;
  const limiter = new RateLimiter();

  // Everything that changes state runs one at a time. PayPal calls are awaited
  // in the middle of a step, and without this a webhook and the return URL for
  // the same order, or a capture and a hold expiry, could interleave.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  // Load, run one step of work, write back what changed.
  function work<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    return exclusive(async () => {
      const loaded = await loadState(store, deps.wallClock());
      const ctx: Ctx = {
        state: loaded.state,
        paypal,
        llm,
        now: deps.wallClock() + loaded.state.clockOffsetMs,
        baseUrl: deps.baseUrl,
      };
      const result = await fn(ctx);
      await saveState(store, loaded);
      return result;
    });
  }

  async function receiveWebhook(headers: Headers, rawBody: string): Promise<Response> {
    if (rawBody.length > MAX_WEBHOOK_BODY) return json({ error: "body too large" }, 413);
    if (!(await paypal.verifyWebhook(headers, rawBody))) {
      console.log(JSON.stringify({ src: "webhook", accepted: false }));
      return json({ error: "signature check failed" }, 400);
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return json({ error: "not json" }, 400);
    }
    if (typeof event?.id !== "string" || typeof event.event_type !== "string") {
      return json({ error: "not a webhook event" }, 400);
    }
    // A failure here answers 500, and PayPal delivers the event again later.
    await work((ctx) => onPayPalEvent(ctx, event));
    return json({ received: true });
  }

  // The mock has no network, so its queued webhooks are handed to the same
  // listener PayPal would call. A capture made while handling one event queues
  // another, hence the loop.
  async function deliverMockWebhooks(): Promise<void> {
    if (!mock) return;
    for (let round = 0; round < 5; round++) {
      const deliveries = await exclusive(() => mock.takeOutbox());
      if (deliveries.length === 0) return;
      for (const d of deliveries) await receiveWebhook(new Headers(d.headers), d.body);
    }
  }

  async function signedIn(request: Request): Promise<boolean> {
    if (!deps.passcode) return deps.openDesk !== false;
    return hasSession(request.headers.get("cookie"), deps.passcode, deps.wallClock());
  }

  async function route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const now = deps.wallClock();
    const caller = request.headers.get("cf-connecting-ip") ?? "local";
    const limited = (bucket: string, perMinute: number) =>
      !limiter.allow(`${bucket}:${caller}`, perMinute, MINUTE, now);

    // ---- open to PayPal and to guests ----

    if (method === "POST" && path === "/api/webhooks/paypal") {
      if (limited("webhook", 300)) return tooMany();
      return receiveWebhook(request.headers, await request.text());
    }

    // PayPal sends the payer back here after approval (?token=<order id>).
    if (method === "GET" && path === "/api/return") {
      if (limited("return", 30)) return tooMany();
      const orderId = url.searchParams.get("token") ?? "";
      if (!ORDER_ID.test(orderId)) return json({ error: "bad order id" }, 400);
      const { state } = await loadState(store, now);
      if (state.bookings.some((b) => b.orderId === orderId)) {
        await work((ctx) => settleOrder(ctx, orderId));
      }
      return redirect(`${deps.baseUrl}/thanks.html?order=${encodeURIComponent(orderId)}`);
    }

    // What the guest's page may know: the state of the one booking whose order
    // id it holds.
    if (method === "GET" && path === "/api/booking-status") {
      if (limited("status", 60)) return tooMany();
      const orderId = url.searchParams.get("order") ?? "";
      const { state } = ORDER_ID.test(orderId) ? await loadState(store, now) : { state: undefined };
      const booking = state?.bookings.find((b) => b.orderId === orderId);
      if (!booking) return json({ status: "unknown" });
      const status =
        booking.status === "confirmed" ? "confirmed" : booking.status === "held" ? "waiting" : "unavailable";
      return json({
        status,
        pending: booking.paymentPending === true,
        reference: booking.id,
        deposit: (booking.depositCents / 100).toFixed(2),
        currency: state!.venue.currency,
      });
    }

    if (mock && method === "GET" && path === "/mock/paypal/checkoutnow") {
      return mockCheckoutPage(mock, url.searchParams.get("token") ?? "");
    }

    if (mock && method === "POST" && path === "/mock/paypal/approve") {
      if (limited("return", 30)) return tooMany();
      const form = await request.formData();
      const token = String(form.get("token") ?? "");
      const email = String(form.get("email") ?? "payer@example.com").slice(0, 200);
      const view = await mock.checkoutView(token);
      if (!view) return new Response("Unknown order", { status: 404 });
      await exclusive(() => mock.approve(token, email));
      // PayPal's own redirect carries the order id as "token".
      return redirect(`${view.returnUrl}?token=${token}&PayerID=MOCKPAYER`);
    }

    // ---- sign-in ----

    if (method === "GET" && path === "/api/session") {
      return json({ signedIn: await signedIn(request), passcodeRequired: Boolean(deps.passcode) });
    }

    if (method === "POST" && path === "/api/login") {
      if (limited("login", 5)) return tooMany();
      if (!deps.passcode) return json({ ok: true });
      const body = await readJson<{ passcode?: unknown }>(request);
      if (!body.ok) return body.response;
      const given = typeof body.value.passcode === "string" ? body.value.passcode.slice(0, 200) : "";
      if (!(await passcodeMatches(given, deps.passcode))) {
        console.log(JSON.stringify({ src: "auth", ok: false }));
        return json({ error: "wrong passcode" }, 401);
      }
      const cookie = await sessionCookie(deps.passcode, now, deps.baseUrl.startsWith("https:"));
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }

    if (method === "POST" && path === "/api/logout") {
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }

    // ---- owner's desk: everything below needs a session ----

    if (!path.startsWith("/api/")) return undefined;
    if (!deps.passcode && deps.openDesk === false) {
      return json({ error: "DESK_PASSCODE is not set; the desk stays closed outside local development" }, 503);
    }
    if (!(await signedIn(request))) return json({ error: "sign in first" }, 401);

    if (method === "GET" && path === "/api/state") {
      if (limited("read", 240)) return tooMany();
      const { state } = await loadState(store, now);
      const clock = now + state.clockOffsetMs;
      return json({
        state: { ...state, seenEvents: undefined },
        now: clock,
        mode: {
          paypal: paypal.mode,
          llm: llm.name,
          llmUsage: llm.usage ? await llm.usage() : undefined,
          demo: deps.demoControls,
          webhooks: mock ? "mock" : paypal.webhooksConfigured ? "on" : "off",
        },
        samples: deps.demoControls ? sampleMessages(clock) : [],
      });
    }

    if (method !== "POST") return json({ error: "not found" }, 404);
    if (limited("write", 60)) return tooMany();
    // A page on another site cannot send JSON with our cookie unless the browser
    // says where it came from; turn those away.
    const origin = request.headers.get("origin");
    if (origin && hostOf(origin) !== url.host) return json({ error: "cross-site request" }, 403);
    const body = await readJson<Record<string, unknown>>(request);
    if (!body.ok) return body.response;
    const input = body.value;

    if (path === "/api/inquiries") {
      const text = typeof input.text === "string" ? input.text.trim().slice(0, 2000) : "";
      if (!text) return json({ error: "text is required" }, 400);
      const channel = CHANNELS.includes(input.channel as string) ? (input.channel as string) : "email";
      const id = await work(async (ctx) => {
        if (ctx.state.inquiries.length >= 200) return undefined;
        const inq = newInquiry(text, ctx.now, channel);
        ctx.state.inquiries.push(inq);
        return inq.id;
      });
      if (!id) return json({ error: "inbox is full; reset the demo" }, 409);
      return json({ id }, 201);
    }

    const m = path.match(/^\/api\/inquiries\/(INQ-[A-Z0-9]{6})\/(run|approve|waitlist|decline)$/);
    if (m) {
      const [, id, action] = m as unknown as [string, string, string];
      const option = input.option === undefined ? 0 : Number(input.option);
      if (!Number.isInteger(option) || option < 0 || option > 10) return json({ error: "bad option" }, 400);
      try {
        await work(async (ctx) => {
          if (action === "run") await handleInquiry(ctx, id);
          else if (action === "approve") await approveProposal(ctx, id, option);
          else if (action === "waitlist") await waitlistInquiry(ctx, id);
          else await declineProposal(ctx, id);
        });
      } catch (err) {
        if (err instanceof ConflictError) return json({ error: err.message }, 409);
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, message.startsWith("unknown ") ? 404 : 500);
      }
      return json({ ok: true });
    }

    const mv = path.match(/^\/api\/bookings\/(BK-[A-Z0-9]{6})\/move$/);
    if (mv) {
      const start = Number(input.start);
      if (!Number.isSafeInteger(start) || start <= 0) return json({ error: "start must be a time in ms" }, 400);
      try {
        const refused = await work((ctx) => moveBooking(ctx, mv[1]!, start));
        if (refused) return json({ error: refused }, 409);
      } catch (err) {
        if (err instanceof ConflictError) return json({ error: err.message }, 409);
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, message.startsWith("unknown ") ? 404 : 500);
      }
      return json({ ok: true });
    }

    if (path === "/api/tick") {
      return json(await housekeeping());
    }

    if (deps.demoControls && path === "/api/demo/reset") {
      await exclusive(() => resetState(store, now));
      return json({ ok: true });
    }

    // Read a message without touching the inbox: how the model and the rules
    // each understand it. For trying the reader and for the comparison table.
    if (deps.demoControls && path === "/api/demo/read") {
      const text = typeof input.text === "string" ? input.text.trim().slice(0, 2000) : "";
      if (!text) return json({ error: "text is required" }, 400);
      const { state } = await loadState(store, now);
      const clock = now + state.clockOffsetMs;
      const [model, rules] = await Promise.all([
        llm.understand(text, state.venue, clock),
        new StubLlm().understand(text, state.venue, clock),
      ]);
      return json({ reader: llm.name, model, rules });
    }

    if (deps.demoControls && path === "/api/demo/skip") {
      const minutes = Math.min(Math.max(Number(input.minutes) || 0, 0), 7 * 24 * 60);
      const released = await work(async (ctx) => {
        ctx.state.clockOffsetMs += minutes * MINUTE;
        ctx.now += minutes * MINUTE;
        return tick(ctx);
      });
      return json({ released });
    }

    return json({ error: "not found" }, 404);
  }

  // Release unpaid holds and catch up with PayPal. Runs from the Durable
  // Object's alarm; POST /api/tick does the same by hand.
  async function housekeeping(): Promise<{ released: number; checked: number }> {
    const result = await work(async (ctx) => {
      const checked = await reconcile(ctx);
      const released = await tick(ctx);
      return { released, checked };
    });
    await deliverMockWebhooks();
    return result;
  }

  // When housekeeping should run next, in wall-clock time, or undefined if
  // nothing is waiting.
  async function nextWake(): Promise<number | undefined> {
    const now = deps.wallClock();
    const { state } = await loadState(store, now);
    let wake: number | undefined;
    for (const b of state.bookings) {
      const waiting = b.paymentPending || (b.status === "held" && b.orderId && !b.captureId);
      if (!waiting) continue;
      const candidates: number[] = [];
      if (b.holdExpiresAt) candidates.push(b.holdExpiresAt - state.clockOffsetMs);
      if (!mock) candidates.push(now + POLL_MS);
      for (const at of candidates) wake = wake === undefined ? at : Math.min(wake, at);
    }
    return wake === undefined ? undefined : Math.max(wake, now + 1000);
  }

  // The first request seeds the demo data; do that once, in the queue.
  let seeded: Promise<unknown> | undefined;

  return {
    async handle(request: Request): Promise<Response | undefined> {
      await (seeded ??= exclusive(() => loadState(store, deps.wallClock())));
      const response = await route(request);
      if (request.method !== "GET" || new URL(request.url).pathname === "/api/return") {
        await deliverMockWebhooks();
      }
      return response;
    },
    housekeeping,
    nextWake,
  };
}

async function mockCheckoutPage(mock: MockPayPal, token: string): Promise<Response> {
  const view = await mock.checkoutView(token);
  if (!view) return new Response("Unknown order", { status: 404 });
  const unit = view.order.purchase_units?.[0];
  const paid = view.order.status !== "PAYER_ACTION_REQUIRED";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock checkout</title><link rel="stylesheet" href="/style.css"></head>
<body class="checkout">
<main>
  <p class="mock-banner">Mock checkout. This page stands in for PayPal's approval page; no payment is made.</p>
  <h1>${esc(view.brandName)}</h1>
  <p>${esc(unit?.description ?? "")}</p>
  <p class="amount">${esc(unit?.amount?.value ?? "")} ${esc(unit?.amount?.currency_code ?? "")}</p>
  <p class="muted">Order ${esc(view.order.id)} &middot; ${esc(view.order.status)}</p>
  ${
    paid
      ? `<p>This order has already been approved.</p>`
      : `<form method="post" action="/mock/paypal/approve">
    <input type="hidden" name="token" value="${esc(token)}">
    <label>Payer email <input name="email" type="email" value="buyer@example.com" required></label>
    <button type="submit">Pay now</button>
    <a href="${esc(view.cancelUrl)}">Cancel and return</a>
  </form>`
  }
</main></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function tooMany(): Response {
  return json({ error: "too many requests; wait a minute" }, 429, { "retry-after": "60" });
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

// JSON object bodies only. An empty body counts as {}.
async function readJson<T>(request: Request): Promise<Parsed<T>> {
  const text = await request.text();
  if (text.length > MAX_BODY) return { ok: false, response: json({ error: "body too large" }, 413) };
  if (text.trim() === "") return { ok: true, value: {} as T };
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    return { ok: false, response: json({ error: "send application/json" }, 415) };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as T };
    }
  } catch {
    // handled below
  }
  return { ok: false, response: json({ error: "body must be a JSON object" }, 400) };
}

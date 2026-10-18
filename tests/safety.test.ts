import { describe, expect, it } from "vitest";
import { PayPalError, type PayPalClient } from "../src/paypal/client";
import type { MockPayPal } from "../src/paypal/mock";
import type { Order } from "../src/paypal/types";
import { ConflictError, loadState, saveState } from "../src/state";
import { MemoryStore } from "../src/store";
import { makeDesk, NOW } from "./helpers";

// Pass every call through to the mock unless a test replaces it.
function passthrough(mock: MockPayPal, over: Partial<PayPalClient>): PayPalClient {
  return {
    mode: "sandbox",
    webhooksConfigured: false,
    createOrder: (b, id) => mock.createOrder(b, id),
    getOrder: (id) => mock.getOrder(id),
    captureOrder: (id, rid) => mock.captureOrder(id, rid),
    refundCapture: (id, b, rid) => mock.refundCapture(id, b, rid),
    verifyWebhook: async () => false,
    ...over,
  };
}

describe("owner sign-in", () => {
  it("keeps the desk closed without a session", async () => {
    const desk = makeDesk({ passcode: "open-sesame" });
    expect((await desk.call("GET", "/api/state")).status).toBe(401);
    expect((await desk.post("/api/demo/reset")).status).toBe(401);
    expect((await desk.post("/api/inquiries", { text: "hello" })).status).toBe(401);
    expect((await desk.post("/api/tick")).status).toBe(401);
  });

  it("opens with the passcode and closes again on sign-out", async () => {
    const desk = makeDesk({ passcode: "open-sesame" });
    expect((await desk.post("/api/login", { passcode: "guess" })).status).toBe(401);
    const res = await desk.post("/api/login", { passcode: "open-sesame" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await desk.call("GET", "/api/state")).status).toBe(200);

    desk.signOut();
    expect((await desk.call("GET", "/api/state")).status).toBe(401);
    const forged = { cookie: `sk_session=${NOW + 60_000}.${"0".repeat(64)}` };
    expect((await desk.call("GET", "/api/state", undefined, forged)).status).toBe(401);
  });

  it("limits passcode guesses", async () => {
    const desk = makeDesk({ passcode: "open-sesame" });
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await desk.post("/api/login", { passcode: "guess" + i })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Even the right passcode has to wait out the window.
    expect((await desk.post("/api/login", { passcode: "open-sesame" })).status).toBe(429);
  });

  it("stays shut when no passcode is set on a public host", async () => {
    const desk = makeDesk({ openDesk: false });
    expect((await desk.call("GET", "/api/state")).status).toBe(503);
  });

  it("leaves the guest's pages and PayPal's entry points open", async () => {
    const desk = makeDesk({ passcode: "open-sesame" });
    await desk.post("/api/login", { passcode: "open-sesame" });
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    desk.signOut();

    expect((await desk.pay(held)).status).toBe(303);
    const status = await desk.call("GET", `/api/booking-status?order=${held.orderId}`);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "confirmed", pending: false, reference: held.id, deposit: "72.00", currency: "USD" });
    // Nothing about other guests leaks through it.
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("refuses requests sent from another site", async () => {
    const desk = makeDesk();
    const res = await desk.call("POST", "/api/demo/reset", {}, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
  });
});

describe("input checks", () => {
  it("rejects malformed requests", async () => {
    const desk = makeDesk();
    expect((await desk.post("/api/inquiries", { text: "   " })).status).toBe(400);
    expect((await desk.post("/api/inquiries", { text: 42 })).status).toBe(400);
    expect((await desk.call("POST", "/api/inquiries", "x".repeat(9000), { "content-type": "application/json" })).status).toBe(413);
    expect((await desk.call("POST", "/api/inquiries", "text=hi", { "content-type": "text/plain" })).status).toBe(415);
    expect((await desk.call("POST", "/api/inquiries", "[1]", { "content-type": "application/json" })).status).toBe(400);
    expect((await desk.post("/api/inquiries/INQ-ZZZZZZ/run")).status).toBe(404);
    expect((await desk.post("/api/inquiries/INQ-zz/run")).status).toBe(404);
    expect((await desk.call("GET", "/api/return?token=<script>")).status).toBe(400);
    expect((await desk.call("GET", "/api/booking-status?order=nope")).status).toBe(200);
  });

  it("rejects an option the proposal does not have", async () => {
    const desk = makeDesk();
    const inq = await desk.run("kenji");
    expect((await desk.post(`/api/inquiries/${inq.id}/approve`, { option: "1; drop" })).status).toBe(400);
    expect((await desk.post(`/api/inquiries/${inq.id}/approve`, { option: 9 })).status).toBe(200);
    expect((await desk.inquiry("kenji")).status).toBe("awaiting_owner");
  });

  it("does not act on a return for an order it never created", async () => {
    const desk = makeDesk();
    const res = await desk.call("GET", "/api/return?token=5O190127TN364715T");
    expect(res.status).toBe(303);
    expect((await desk.state()).log).toHaveLength(0);
  });
});

describe("limits enforced on the server", () => {
  it("never creates an order above the ceiling, even with approval", async () => {
    const desk = makeDesk();
    const { state, rev, snapshot } = await loadState(desk.store, NOW);
    state.venue.policy.maxDepositCents = 9000;
    await saveState(desk.store, { state, rev, snapshot });

    const inq = await desk.run("Priya");
    expect(inq.status).toBe("awaiting_owner");
    expect(inq.proposal!.options).toHaveLength(0);
    await desk.post(`/api/inquiries/${inq.id}/approve`);
    expect((await desk.state()).bookings.some((b) => b.inquiryId === inq.id)).toBe(false);
  });

  it("never refunds more than the deposit that is left", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Priya");
    await desk.post(`/api/inquiries/${inq.id}/approve`);
    await desk.pay(await desk.bookingOf(inq));
    const res = await desk.post("/api/inquiries", { text: "Please cancel our session. priya.k@example.com" });
    const { id } = (await res.json()) as { id: string };
    await desk.post(`/api/inquiries/${id}/run`);

    // Someone edits the waiting proposal to ask for more.
    const loaded = await loadState(desk.store, NOW);
    loaded.state.inquiries.find((i) => i.id === id)!.proposal!.refundCents = 500_000;
    await saveState(desk.store, loaded);

    await desk.post(`/api/inquiries/${id}/approve`);
    expect((await desk.bookingOf(inq)).refundedCents).toBe(9600);
  });
});

describe("concurrent requests", () => {
  it("captures once when the return URL and the webhook arrive together", async () => {
    let captures = 0;
    const desk = makeDesk();
    const original = desk.paypal.captureOrder.bind(desk.paypal);
    desk.paypal.captureOrder = async (id, rid) => {
      captures++;
      await new Promise((r) => setTimeout(r, 5));
      return original(id, rid);
    };
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");
    const [approved] = await desk.paypal.takeOutbox();

    await Promise.all([
      desk.call("GET", `/api/return?token=${held.orderId}`),
      desk.call("POST", "/api/webhooks/paypal", approved!.body, approved!.headers),
      desk.call("GET", `/api/return?token=${held.orderId}`),
    ]);
    expect(captures).toBe(1);
    const state = await desk.state();
    expect(state.bookings.find((b) => b.id === held.id)!.status).toBe("confirmed");
    expect(state.log.filter((e) => e.text.includes("booking confirmed"))).toHaveLength(1);
  });

  it("holds a slot once when two guests ask for it at the same moment", async () => {
    const desk = makeDesk();
    const sample = "Hello, can 2 people join the wheel class on Oct 14 at 14:00? ";
    const ids = [];
    for (const who of ["a@example.com", "b@example.com"]) {
      const res = await desk.post("/api/inquiries", { text: sample + who });
      ids.push(((await res.json()) as { id: string }).id);
    }
    await Promise.all(ids.map((id) => desk.post(`/api/inquiries/${id}/run`)));

    const state = await desk.state();
    const held = state.bookings.filter((b) => b.status === "held");
    expect(held).toHaveLength(1);
    const statuses = ids.map((id) => state.inquiries.find((i) => i.id === id)!.status).sort();
    expect(statuses).toEqual(["awaiting_owner", "awaiting_payment"]);
  });

  it("does not lose a payment that races the hold expiry", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await Promise.all([desk.post("/api/demo/skip", { minutes: 31 }), desk.pay(held)]);
    // Either order of events ends the same way: nobody else wanted the slot, so the payment stands.
    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("confirmed");
    expect((await desk.paypal.getOrder(held.orderId!)).purchase_units![0]!.payments!.captures).toHaveLength(1);
  });

  it("refuses a write that started from stale state", async () => {
    const store = new MemoryStore();
    const first = await loadState(store, NOW);
    const second = await loadState(store, NOW);
    first.state.clockOffsetMs = 1;
    second.state.clockOffsetMs = 2;
    await saveState(store, first);
    await expect(saveState(store, second)).rejects.toBeInstanceOf(ConflictError);
    expect((await loadState(store, NOW)).state.clockOffsetMs).toBe(1);
  });

  it("stores each booking under its own key and rewrites only what changed", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    const keys = [...(await desk.store.list("desk:")).keys()];
    expect(keys).toContain(`desk:bk:${held.id}`);
    expect(keys).toContain(`desk:inq:${inq.id}`);

    const writes: string[][] = [];
    const write = desk.store.write.bind(desk.store);
    desk.store.write = async (puts, deletes) => {
      writes.push(Object.keys(puts));
      return write(puts, deletes);
    };
    await desk.call("GET", `/api/return?token=${held.orderId}`);
    // Not approved yet: one log line and the revision, no booking rewritten.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.some((k) => k.startsWith("desk:bk:"))).toBe(false);
  });
});

describe("when PayPal's answers go missing", () => {
  it("confirms from PayPal's records when no webhook and no return ever arrive", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");
    await desk.paypal.takeOutbox();

    const res = await desk.post("/api/tick");
    expect(await res.json()).toMatchObject({ checked: 1 });
    expect((await desk.bookingOf(inq)).status).toBe("confirmed");
  });

  it("recovers when the capture went through but the answer was lost", async () => {
    let dropped = false;
    const desk = makeDesk({
      wrap: (mock) =>
        passthrough(mock, {
          captureOrder: async (id, rid) => {
            const order = await mock.captureOrder(id, rid);
            if (!dropped) {
              dropped = true;
              throw new PayPalError(0, { name: "NETWORK_ERROR", message: "timeout" });
            }
            // PayPal remembers the request id only for a while; assume it has forgotten.
            void order;
            throw new PayPalError(422, {
              name: "UNPROCESSABLE_ENTITY",
              message: "",
              details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
            });
          },
        }),
    });
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");

    await desk.call("GET", `/api/return?token=${held.orderId}`);
    expect((await desk.bookingOf(inq)).status).toBe("held");
    await desk.post("/api/tick");
    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("confirmed");
    expect(booking.captureId).toBeTruthy();
  });

  it("keeps the slot while a capture is pending and confirms when it clears", async () => {
    let pending = true;
    const asPending = (order: Order): Order => {
      const copy = structuredClone(order);
      if (pending) copy.purchase_units![0]!.payments!.captures![0]!.status = "PENDING";
      return copy;
    };
    const desk = makeDesk({
      wrap: (mock) =>
        passthrough(mock, {
          captureOrder: async (id, rid) => asPending(await mock.captureOrder(id, rid)),
          getOrder: async (id) => asPending(await mock.getOrder(id)),
        }),
    });
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");
    await desk.call("GET", `/api/return?token=${held.orderId}`);

    let booking = await desk.bookingOf(inq);
    expect(booking).toMatchObject({ status: "held", paymentPending: true });
    await desk.post("/api/demo/skip", { minutes: 45 });
    expect((await desk.bookingOf(inq)).status).toBe("held");

    pending = false;
    await desk.post("/api/tick");
    booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("confirmed");
    expect(booking.paymentPending).toBeUndefined();
  });

  it("leaves the hold alone when the payer comes back without approving", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.call("GET", `/api/return?token=${held.orderId}`);
    expect((await desk.bookingOf(inq)).status).toBe("held");
    const last = (await desk.state()).log.pop()!;
    expect(last.text).toContain("the payer has not approved it yet");
  });
});

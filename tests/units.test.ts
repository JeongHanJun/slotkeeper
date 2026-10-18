import { describe, expect, it } from "vitest";
import { readMessage } from "../src/llm/stub";
import { PayPalError } from "../src/paypal/client";
import { MockPayPal } from "../src/paypal/mock";
import type { CreateOrderRequest } from "../src/paypal/types";
import { refundFor } from "../src/policy";
import { findAlternatives, fromLocal, isFree, slotFor } from "../src/schedule";
import { seedState } from "../src/seed";
import { MemoryStore } from "../src/store";
import type { Booking } from "../src/types";
import { NOW } from "./helpers";

const HOUR = 3_600_000;
const state = () => seedState(NOW);

describe("reading messages", () => {
  const { venue } = state();

  it("reads an English request", () => {
    const u = readMessage("Could 3 friends book the wheel class on Oct 14 at 2:30pm? - Maya, maya@example.com", venue, NOW);
    expect(u).toMatchObject({
      intent: "book",
      lang: "en",
      offeringId: "wheel-class",
      guests: 3,
      date: { y: 2026, m: 10, d: 14 },
      hour: 14,
      minute: 30,
      name: "Maya",
      email: "maya@example.com",
    });
  });

  it("reads a Japanese request", () => {
    const u = readMessage("10月15日の午後2時にろくろ体験を2人で予約できますか？ kenji@example.com", venue, NOW);
    expect(u).toMatchObject({ lang: "ja", offeringId: "wheel-class", guests: 2, date: { m: 10, d: 15 }, hour: 14 });
  });

  it("reads a Korean request", () => {
    const u = readMessage("토요일 오전 11시에 물레 체험 4명 예약 가능할까요? jisoo@example.com", venue, NOW);
    // NOW is a Saturday, so "Saturday" means a week later.
    expect(u).toMatchObject({ lang: "ko", offeringId: "wheel-class", guests: 4, date: { m: 10, d: 17 }, hour: 11 });
  });

  it("takes a bare weekday as the next one and a past date as next year", () => {
    expect(readMessage("glaze painting for 2 on Monday at 11am", venue, NOW).date).toEqual({ y: 2026, m: 10, d: 12 });
    expect(readMessage("glaze painting for 2 on 3/5 at 11am", venue, NOW).date).toEqual({ y: 2027, m: 3, d: 5 });
  });

  it("leaves out what the message does not say", () => {
    const u = readMessage("Do you have classes this week? Family of 5.", venue, NOW);
    expect(u.guests).toBe(5);
    expect(u.offeringId).toBeUndefined();
    expect(u.date).toBeUndefined();
    expect(u.hour).toBeUndefined();
  });

  it("spots a cancellation", () => {
    expect(readMessage("We need to cancel, sorry. a@example.com", venue, NOW).intent).toBe("cancel");
  });
});

describe("schedule", () => {
  it("never proposes an occupied or out-of-hours slot", () => {
    const s = state();
    const offering = s.venue.offerings[0]!;
    const taken = s.bookings[0]!;
    expect(isFree(s, slotFor(offering, taken.start + HOUR))).toBe(false);

    const options = findAlternatives(s, offering, taken.start, NOW);
    expect(options).toHaveLength(3);
    for (const o of options) {
      expect(isFree(s, o)).toBe(true);
      expect(o.end - o.start).toBe(2 * HOUR);
    }
    // Closest first: the class right before or right after the taken one.
    expect(Math.abs(options[0]!.start - taken.start)).toBe(2 * HOUR);
  });

  it("does not offer times that leave too little notice", () => {
    const s = state();
    const offering = s.venue.offerings[0]!;
    const todayAtOne = fromLocal(2026, 10, 10, 13, 0, 540);
    for (const o of findAlternatives(s, offering, todayAtOne, NOW)) {
      expect(o.start).toBeGreaterThanOrEqual(NOW + 2 * HOUR);
    }
  });
});

describe("refund policy", () => {
  const { policy } = state().venue;
  const booking = { start: NOW + 100 * HOUR, depositCents: 7200 } as Booking;

  it("follows the tiers", () => {
    expect(refundFor(booking, NOW, policy).cents).toBe(7200);
    expect(refundFor(booking, booking.start - 30 * HOUR, policy).cents).toBe(3600);
    expect(refundFor(booking, booking.start - 5 * HOUR, policy).cents).toBe(0);
  });

  it("only counts what has not been refunded yet", () => {
    expect(refundFor({ ...booking, refundedCents: 7200 }, NOW, policy).cents).toBe(0);
  });
});

describe("PayPal mock", () => {
  const order = (value: string): CreateOrderRequest => ({
    intent: "CAPTURE",
    purchase_units: [{ reference_id: "BK-1", custom_id: "BK-1", description: "test", amount: { currency_code: "USD", value } }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Test",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: "http://desk.test/api/return",
          cancel_url: "http://desk.test/",
        },
      },
    },
  });

  async function issueOf(p: Promise<unknown>) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PayPalError);
    return { status: (err as PayPalError).status, issue: (err as PayPalError).issue };
  }

  it("answers order creation the way the sandbox does", async () => {
    const paypal = new MockPayPal(new MemoryStore(), "http://desk.test");
    const created = await paypal.createOrder(order("72.00"), "req-1");
    expect(created.id).toMatch(/^[A-Z0-9]{17}$/);
    expect(created.status).toBe("PAYER_ACTION_REQUIRED");
    expect(created.links!.map((l) => l.rel)).toEqual(["self", "payer-action"]);
  });

  it("returns the first answer again for a repeated request id", async () => {
    const paypal = new MockPayPal(new MemoryStore(), "http://desk.test");
    const a = await paypal.createOrder(order("72.00"), "req-1");
    const b = await paypal.createOrder(order("72.00"), "req-1");
    const c = await paypal.createOrder(order("72.00"), "req-2");
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  it("refuses to capture before approval and to capture twice", async () => {
    const paypal = new MockPayPal(new MemoryStore(), "http://desk.test");
    const { id } = await paypal.createOrder(order("72.00"), "req-1");
    expect(await issueOf(paypal.captureOrder(id, "cap-1"))).toEqual({ status: 422, issue: "ORDER_NOT_APPROVED" });

    await paypal.approve(id, "buyer@example.com");
    const captured = await paypal.captureOrder(id, "cap-1");
    expect(captured.status).toBe("COMPLETED");
    expect(captured.purchase_units![0]!.payments!.captures![0]!.amount.value).toBe("72.00");
    expect(await issueOf(paypal.captureOrder(id, "cap-2"))).toEqual({ status: 422, issue: "ORDER_ALREADY_CAPTURED" });
  });

  it("limits refunds to what was captured", async () => {
    const paypal = new MockPayPal(new MemoryStore(), "http://desk.test");
    const { id } = await paypal.createOrder(order("72.00"), "req-1");
    await paypal.approve(id, "buyer@example.com");
    const capture = (await paypal.captureOrder(id, "cap-1")).purchase_units![0]!.payments!.captures![0]!;

    const usd = (value: string) => ({ amount: { currency_code: "USD", value } });
    expect(await issueOf(paypal.refundCapture(capture.id, usd("80.00"), "r-1"))).toEqual({ status: 422, issue: "REFUND_AMOUNT_EXCEEDED" });
    expect((await paypal.refundCapture(capture.id, usd("36.00"), "r-2")).status).toBe("COMPLETED");
    expect((await paypal.refundCapture(capture.id, {}, "r-3")).amount!.value).toBe("36.00");
    expect(await issueOf(paypal.refundCapture(capture.id, usd("1.00"), "r-4"))).toEqual({ status: 422, issue: "CAPTURE_FULLY_REFUNDED" });
    expect(await issueOf(paypal.refundCapture("NOPE", {}, "r-5"))).toEqual({ status: 404, issue: "INVALID_RESOURCE_ID" });
  });

  it("signs its webhooks and notices tampering", async () => {
    const paypal = new MockPayPal(new MemoryStore(), "http://desk.test");
    const { id } = await paypal.createOrder(order("72.00"), "req-1");
    await paypal.approve(id, "buyer@example.com");
    const [delivery] = await paypal.takeOutbox();
    const event = JSON.parse(delivery!.body);
    expect(event).toMatchObject({ event_type: "CHECKOUT.ORDER.APPROVED", resource_type: "checkout-order", resource: { id, status: "APPROVED" } });

    const headers = new Headers(delivery!.headers);
    expect(await paypal.verifyWebhook(headers, delivery!.body)).toBe(true);
    expect(await paypal.verifyWebhook(headers, delivery!.body.replace("72.00", "1.00"))).toBe(false);
  });
});

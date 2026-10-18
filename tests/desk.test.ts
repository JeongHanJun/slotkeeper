import { describe, expect, it } from "vitest";
import { makeDesk } from "./helpers";

// End-to-end through the HTTP routes, with the PayPal mock and the rule-based reader.

describe("booking a free slot", () => {
  it("holds the slot, creates an order and drafts a reply with the pay link", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    expect(inq.status).toBe("awaiting_payment");

    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("held");
    expect(booking.guests).toBe(3);
    expect(booking.totalCents).toBe(14400);
    expect(booking.depositCents).toBe(7200);
    expect(booking.approveUrl).toContain(`/mock/paypal/checkoutnow?token=${booking.orderId}`);
    expect(inq.reply).toContain(booking.approveUrl!);
    expect(inq.reply).toContain("$72.00");
  });

  it("confirms the booking once the guest pays", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);

    const res = await desk.pay(held);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`/api/return?token=${held.orderId}`);

    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("confirmed");
    expect(booking.captureId).toBeTruthy();
    expect((await desk.inquiry("Maya")).status).toBe("booked");

    // The return URL arrives after the webhook and must not capture twice.
    await desk.call("GET", `/api/return?token=${held.orderId}`);
    const order = await desk.paypal.getOrder(held.orderId!);
    expect(order.purchase_units![0]!.payments!.captures).toHaveLength(1);
  });
});

describe("when the agent may not decide alone", () => {
  it("offers nearby times when the slot is taken, and holds the one the owner picks", async () => {
    const desk = makeDesk();
    const inq = await desk.run("kenji");
    expect(inq.status).toBe("awaiting_owner");
    expect(inq.proposal!.kind).toBe("alternative");
    expect(inq.proposal!.options.length).toBeGreaterThan(0);

    const taken = (await desk.state()).bookings.find((b) => b.guestName === "Han family")!;
    for (const slot of inq.proposal!.options) {
      expect(slot.end <= taken.start || slot.start >= taken.end).toBe(true);
    }

    await desk.post(`/api/inquiries/${inq.id}/approve`, { option: 0 });
    const after = await desk.inquiry("kenji");
    expect(after.status).toBe("awaiting_payment");
    // Written in the guest's language, with the deposit for two guests.
    expect(after.reply).toContain("Kenji様");
    expect(after.reply).toContain("$48.00");
    expect((await desk.bookingOf(after)).start).toBe(inq.proposal!.options[0]!.start);
  });

  it("asks before holding when the deposit is over the limit", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Priya");
    expect(inq.status).toBe("awaiting_owner");
    expect(inq.proposal!.kind).toBe("over_limit");
    expect((await desk.state()).bookings.some((b) => b.inquiryId === inq.id)).toBe(false);

    await desk.post(`/api/inquiries/${inq.id}/approve`);
    expect((await desk.bookingOf(inq)).depositCents).toBe(9600);
  });

  it("asks the guest instead of guessing when details are missing", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Tom");
    expect(inq.status).toBe("needs_info");
    expect(inq.reply).toContain("which class");
    expect(inq.reply).toContain("the date");
  });
});

describe("unpaid holds", () => {
  it("releases the slot after the hold window", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    await desk.post("/api/demo/skip", { minutes: 31 });
    expect((await desk.bookingOf(inq)).status).toBe("released");
    expect((await desk.inquiry("Maya")).status).toBe("lapsed");
  });

  it("still takes a late payment if nobody else has the slot", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    await desk.post("/api/demo/skip", { minutes: 31 });
    await desk.pay(await desk.bookingOf(inq));
    expect((await desk.bookingOf(inq)).status).toBe("confirmed");
  });

  it("gives a released slot to the waitlist and refuses the late payment", async () => {
    const desk = makeDesk();
    const maya = await desk.run("Maya");
    const sora = await desk.addAndRun("Sora");
    expect(sora.status).toBe("awaiting_owner");
    await desk.post(`/api/inquiries/${sora.id}/waitlist`);

    await desk.post("/api/demo/skip", { minutes: 31 });
    const soraNow = await desk.inquiry("sora");
    expect(soraNow.status).toBe("awaiting_payment");
    expect((await desk.bookingOf(soraNow)).start).toBe((await desk.bookingOf(maya)).start);

    // Maya approves too late: the order is left uncaptured.
    const mayaBooking = await desk.bookingOf(maya);
    await desk.pay(mayaBooking);
    expect((await desk.bookingOf(maya)).status).toBe("released");
    expect((await desk.paypal.getOrder(mayaBooking.orderId!)).status).toBe("APPROVED");
  });
});

describe("cancellations", () => {
  it("refunds by policy and frees the slot", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    await desk.pay(await desk.bookingOf(inq));

    const cancel = await desk.addAndRun("Maya: cancellation");
    expect(cancel.status).toBe("cancelled");
    expect(cancel.reply).toContain("$72.00");

    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("cancelled");
    expect(booking.refundedCents).toBe(7200);
    expect(booking.refundId).toBeTruthy();

    const log = (await desk.state()).log.map((e) => e.ref);
    expect(log).toContain("PAYMENT.CAPTURE.REFUNDED");
  });

  it("refunds half inside 48 hours", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    await desk.pay(await desk.bookingOf(inq));
    // The class is four days out at 14:00; move to about 26 hours before it.
    await desk.post("/api/demo/skip", { minutes: 3 * 24 * 60 });

    await desk.addAndRun("Maya: cancellation");
    expect((await desk.bookingOf(inq)).refundedCents).toBe(3600);
  });

  it("waits for the owner when the refund is over the limit", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Priya");
    await desk.post(`/api/inquiries/${inq.id}/approve`);
    await desk.pay(await desk.bookingOf(inq));

    const res = await desk.post("/api/inquiries", { text: "Please cancel our session. priya.k@example.com" });
    const { id } = (await res.json()) as { id: string };
    await desk.post(`/api/inquiries/${id}/run`);

    let cancel = (await desk.state()).inquiries.find((i) => i.id === id)!;
    expect(cancel.status).toBe("awaiting_owner");
    expect(cancel.proposal!.refundCents).toBe(9600);
    expect((await desk.bookingOf(inq)).status).toBe("confirmed");

    await desk.post(`/api/inquiries/${id}/approve`);
    cancel = (await desk.state()).inquiries.find((i) => i.id === id)!;
    expect(cancel.status).toBe("cancelled");
    expect((await desk.bookingOf(inq)).refundedCents).toBe(9600);
  });
});

describe("webhook listener", () => {
  it("rejects a delivery that fails the signature check", async () => {
    const desk = makeDesk();
    const res = await desk.call(
      "POST",
      "/api/webhooks/paypal",
      JSON.stringify({ id: "WH-FAKE", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }),
      {
        "paypal-transmission-id": "x",
        "paypal-transmission-time": "2026-10-10T03:00:00Z",
        "paypal-transmission-sig": "bm90IGEgc2lnbmF0dXJl",
      },
    );
    expect(res.status).toBe(400);
  });

  it("ignores a repeated delivery of the same event", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");
    const [delivery] = await desk.paypal.takeOutbox();

    for (let i = 0; i < 2; i++) {
      const res = await desk.call("POST", "/api/webhooks/paypal", delivery!.body, delivery!.headers);
      expect(res.status).toBe(200);
    }
    const approvals = (await desk.state()).log.filter((e) => e.ref === "CHECKOUT.ORDER.APPROVED");
    expect(approvals).toHaveLength(1);
    expect((await desk.bookingOf(inq)).status).toBe("confirmed");
  });
});

describe("the owner moves a booking on the board", () => {
  const HOUR = 3_600_000;

  it("moves a held booking to a free time and rewrites the pay-link reply", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    const start = held.start + 2 * HOUR;

    const res = await desk.post(`/api/bookings/${held.id}/move`, { start });
    expect(res.status).toBe(200);
    const moved = await desk.bookingOf(inq);
    expect(moved.start).toBe(start);
    expect(moved.end - moved.start).toBe(held.end - held.start);
    expect(moved.orderId).toBe(held.orderId);
    expect(moved.status).toBe("held");
    const after = await desk.inquiry("Maya");
    expect(after.reply).toContain(held.approveUrl!);
    expect(after.reply).toContain("$72.00");
    expect(after.reply).not.toBe(inq.reply);
  });

  it("refuses a move onto another booking and changes nothing", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    const other = (await desk.state()).bookings.find(
      (b) => b.id !== held.id && b.resourceId === held.resourceId && b.status === "confirmed",
    )!;

    const res = await desk.post(`/api/bookings/${held.id}/move`, { start: other.start });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("overlaps");
    expect((await desk.bookingOf(inq)).start).toBe(held.start);
  });

  it("refuses times outside opening hours and bookings that are over", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    const dayStart = held.start - ((held.start + 9 * HOUR) % (24 * HOUR));

    const late = await desk.post(`/api/bookings/${held.id}/move`, { start: dayStart + 18 * HOUR });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toContain("opening hours");

    await desk.post("/api/demo/skip", { minutes: 31 });
    expect((await desk.bookingOf(inq)).status).toBe("released");
    const gone = await desk.post(`/api/bookings/${held.id}/move`, { start: held.start + HOUR });
    expect(gone.status).toBe(409);

    const bad = await desk.post(`/api/bookings/${held.id}/move`, { start: "soon" });
    expect(bad.status).toBe(400);
  });
});

import type { Llm, ReplyFacts } from "./llm/types";
import { approveLink, firstCapture, PayPalError, type PayPalClient } from "./paypal/client";
import type { Capture, Order, Refund, WebhookEvent } from "./paypal/types";
import { depositFor, refundFor, toAmount, fromAmount, type RefundDecision } from "./policy";
import { bookable, findAlternatives, formatLocal, fromLocal, isFree, slotFor, withinOpeningHours } from "./schedule";
import type { AppState, Booking, Inquiry, LogEntry, Offering, Slot } from "./types";

// The booking desk agent.
//
// Division of labour: the language model reads the guest's message and words the
// reply. Everything that touches the calendar or money is decided here, in code,
// inside the limits of venue.policy. Anything outside those limits becomes a
// proposal the owner approves or declines.

export interface Ctx {
  state: AppState;
  paypal: PayPalClient;
  llm: Llm;
  now: number;
  // Public origin of this app, used for PayPal return and cancel URLs.
  baseUrl: string;
}

const MIN = 60_000;

export async function handleInquiry(ctx: Ctx, inquiryId: string): Promise<void> {
  const inq = mustFind(ctx.state.inquiries, inquiryId, "inquiry");
  if (inq.status !== "new" && inq.status !== "needs_info") return;

  const { venue } = ctx.state;
  const u = await ctx.llm.understand(inq.text, venue, ctx.now);
  inq.understanding = u;

  if (u.intent === "cancel") {
    await handleCancellation(ctx, inq);
    return;
  }

  const offering = venue.offerings.find((o) => o.id === u.offeringId);

  if (offering && u.guests && u.guests > offering.maxGuests) {
    inq.status = "needs_info";
    inq.reply = await ctx.llm.writeReply({
      ...baseFacts(ctx, inq),
      kind: "too_many_guests",
      offeringName: offering.name,
      maxGuests: offering.maxGuests,
    });
    log(ctx, "agent", `${inq.id}: party of ${u.guests} is over the ${offering.maxGuests}-guest limit for ${offering.name}; offered to split.`);
    return;
  }

  const missing: string[] = [];
  if (!offering) missing.push("offering");
  if (!u.date) missing.push("date");
  if (u.hour === undefined) missing.push("time");
  if (!u.guests) missing.push("guests");
  if (!u.email) missing.push("email");
  if (!offering || !u.date || u.hour === undefined || !u.guests || !u.email) {
    inq.status = "needs_info";
    inq.reply = await ctx.llm.writeReply({ ...baseFacts(ctx, inq), kind: "ask_details", missing });
    log(ctx, "agent", `${inq.id}: cannot book yet, missing ${missing.join(", ")}; drafted a question.`);
    return;
  }

  const start = fromLocal(u.date.y, u.date.m, u.date.d, u.hour, u.minute ?? 0, venue.utcOffsetMinutes);
  const wanted = slotFor(offering, start);
  inq.wanted = wanted;
  const when = formatLocal(wanted.start, venue.utcOffsetMinutes);

  if (bookable(ctx.state, wanted, ctx.now)) {
    await holdOrAsk(ctx, inq, offering, wanted, "pay_link");
    return;
  }

  const why = !isFree(ctx.state, wanted)
    ? "is already taken"
    : wanted.start < ctx.now + venue.policy.leadMinutes * MIN
      ? "is too soon to prepare for"
      : "is outside opening hours";
  const options = findAlternatives(ctx.state, offering, wanted.start, ctx.now);
  if (options.length === 0) {
    await putOnWaitlist(ctx, inq);
    return;
  }
  inq.status = "awaiting_owner";
  inq.proposal = {
    kind: "alternative",
    reason: `${when} ${why}. Nearest free times are listed; pick one to hold, or waitlist the guest.`,
    options,
  };
  log(ctx, "agent", `${inq.id}: ${when} ${why}; found ${options.length} alternatives and asked the owner.`);
}

// Hold the slot and send a pay link if the deposit is within the agent's limit;
// otherwise leave the decision to the owner.
async function holdOrAsk(
  ctx: Ctx,
  inq: Inquiry,
  offering: Offering,
  slot: Slot,
  replyKind: "pay_link" | "alternative_held",
): Promise<void> {
  const { policy, utcOffsetMinutes } = ctx.state.venue;
  const guests = inq.understanding!.guests!;
  const deposit = depositFor(offering.pricePerGuestCents * guests, policy);
  if (deposit > policy.maxDepositCents) {
    inq.status = "awaiting_owner";
    inq.proposal = {
      kind: "over_limit",
      reason: `Deposit ${usd(ctx, deposit)} is above the ${usd(ctx, policy.maxDepositCents)} ceiling for online deposits. Arrange this one with the guest directly.`,
      options: [],
    };
    log(ctx, "agent", `${inq.id}: deposit ${usd(ctx, deposit)} is above the ceiling; left to the owner.`);
    return;
  }
  if (deposit > policy.autoHoldLimitCents) {
    inq.status = "awaiting_owner";
    inq.proposal = {
      kind: "over_limit",
      reason: `Deposit ${usd(ctx, deposit)} is above the ${usd(ctx, policy.autoHoldLimitCents)} the agent may hold on its own.`,
      options: [slot],
    };
    log(ctx, "agent", `${inq.id}: ${formatLocal(slot.start, utcOffsetMinutes)} is free, but the deposit ${usd(ctx, deposit)} needs the owner's approval.`);
    return;
  }
  await hold(ctx, inq, offering, slot, replyKind);
}

async function hold(
  ctx: Ctx,
  inq: Inquiry,
  offering: Offering,
  slot: Slot,
  replyKind: "pay_link" | "alternative_held",
): Promise<void> {
  const { venue } = ctx.state;
  const u = inq.understanding!;
  const total = offering.pricePerGuestCents * u.guests!;
  const booking: Booking = {
    id: "BK-" + shortId(),
    createdAt: ctx.now,
    inquiryId: inq.id,
    offeringId: offering.id,
    resourceId: slot.resourceId,
    start: slot.start,
    end: slot.end,
    guests: u.guests!,
    guestName: u.name ?? "Guest",
    guestEmail: u.email!,
    status: "held",
    totalCents: total,
    depositCents: depositFor(total, venue.policy),
    holdExpiresAt: ctx.now + venue.policy.holdMinutes * MIN,
  };
  const when = formatLocal(slot.start, venue.utcOffsetMinutes);

  // Checked here as well as in holdOrAsk: this is the last stop before PayPal,
  // whoever asked for the hold.
  const withinRules = booking.depositCents > 0 && booking.depositCents <= venue.policy.maxDepositCents;
  if (!withinRules || !bookable(ctx.state, slot, ctx.now)) {
    log(ctx, "agent", `${inq.id}: did not create an order for ${when} (${usd(ctx, booking.depositCents)}); outside the house rules.`);
    return;
  }

  let order: Order;
  try {
    order = await ctx.paypal.createOrder(
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: booking.id,
            custom_id: booking.id,
            description: `${offering.name}, ${when}, ${booking.guests} guests (deposit)`.slice(0, 127),
            amount: { currency_code: venue.currency, value: toAmount(booking.depositCents) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: venue.name,
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: `${ctx.baseUrl}/api/return`,
              cancel_url: `${ctx.baseUrl}/thanks.html?cancelled=1`,
            },
          },
        },
      },
      booking.id,
    );
  } catch (err) {
    // No order, no hold: the slot stays free and the inquiry can be run again.
    log(ctx, "paypal", `${inq.id}: could not create the order (${describe(err)}); nothing was held.`, "POST /v2/checkout/orders");
    return;
  }

  const approveUrl = approveLink(order);
  if (!approveUrl) {
    log(ctx, "paypal", `${inq.id}: order ${order.id} came back ${order.status} with no approval link; nothing was held.`, "POST /v2/checkout/orders");
    return;
  }
  booking.orderId = order.id;
  booking.approveUrl = approveUrl;
  ctx.state.bookings.push(booking);

  inq.status = "awaiting_payment";
  inq.bookingId = booking.id;
  inq.proposal = undefined;
  inq.reply = await ctx.llm.writeReply({
    ...baseFacts(ctx, inq),
    kind: replyKind,
    offeringName: offering.name,
    when,
    guests: booking.guests,
    deposit: usd(ctx, booking.depositCents),
    total: usd(ctx, booking.totalCents),
    payUrl: booking.approveUrl,
    holdMinutes: venue.policy.holdMinutes,
  });
  log(ctx, "agent", `${inq.id}: held ${offering.name} on ${when} as ${booking.id} for ${venue.policy.holdMinutes} min and created order ${order.id} for ${usd(ctx, booking.depositCents)}.`, "POST /v2/checkout/orders");
}

async function putOnWaitlist(ctx: Ctx, inq: Inquiry): Promise<void> {
  const when = inq.wanted ? formatLocal(inq.wanted.start, ctx.state.venue.utcOffsetMinutes) : undefined;
  inq.status = "waitlisted";
  inq.proposal = undefined;
  inq.reply = await ctx.llm.writeReply({ ...baseFacts(ctx, inq), kind: "waitlisted", when });
  log(ctx, "agent", `${inq.id}: waitlisted for ${when}.`);
}

// ---- owner decisions ----

export async function approveProposal(ctx: Ctx, inquiryId: string, optionIndex = 0): Promise<void> {
  const inq = mustFind(ctx.state.inquiries, inquiryId, "inquiry");
  const p = inq.proposal;
  if (inq.status !== "awaiting_owner" || !p) return;

  if (p.kind === "refund") {
    const booking = mustFind(ctx.state.bookings, p.bookingId!, "booking");
    log(ctx, "owner", `${inq.id}: approved refund of ${usd(ctx, p.refundCents ?? 0)} on ${booking.id}.`);
    const decision = refundFor(booking, ctx.now, ctx.state.venue.policy);
    await cancelBooking(ctx, inq, booking, { ...decision, cents: p.refundCents ?? decision.cents });
    return;
  }

  const slot = p.options[optionIndex];
  const offering = ctx.state.venue.offerings.find((o) => o.id === inq.understanding?.offeringId);
  if (!slot || !offering) return;
  const when = formatLocal(slot.start, ctx.state.venue.utcOffsetMinutes);
  if (!bookable(ctx.state, slot, ctx.now)) {
    // Someone else took it while the proposal was waiting. Work it out again.
    log(ctx, "agent", `${inq.id}: ${when} is no longer free; re-planning.`);
    inq.status = "new";
    inq.proposal = undefined;
    await handleInquiry(ctx, inq.id);
    return;
  }
  log(ctx, "owner", `${inq.id}: approved ${when}.`);
  await hold(ctx, inq, offering, slot, p.kind === "alternative" ? "alternative_held" : "pay_link");
}

export async function waitlistInquiry(ctx: Ctx, inquiryId: string): Promise<void> {
  const inq = mustFind(ctx.state.inquiries, inquiryId, "inquiry");
  if (inq.status !== "awaiting_owner" || inq.proposal?.kind !== "alternative") return;
  log(ctx, "owner", `${inq.id}: chose the waitlist.`);
  await putOnWaitlist(ctx, inq);
}

export async function declineProposal(ctx: Ctx, inquiryId: string): Promise<void> {
  const inq = mustFind(ctx.state.inquiries, inquiryId, "inquiry");
  if (inq.status !== "awaiting_owner") return;
  inq.status = "declined";
  inq.proposal = undefined;
  inq.reply = await ctx.llm.writeReply({ ...baseFacts(ctx, inq), kind: "declined" });
  log(ctx, "owner", `${inq.id}: declined.`);
}

// ---- cancellations and refunds ----

async function handleCancellation(ctx: Ctx, inq: Inquiry): Promise<void> {
  const { venue } = ctx.state;
  const email = inq.understanding?.email;
  const booking = ctx.state.bookings
    .filter((b) => (b.status === "held" || b.status === "confirmed") && b.guestEmail === email)
    .sort((a, b) => a.start - b.start)[0];

  if (!booking) {
    inq.status = "needs_info";
    inq.reply = await ctx.llm.writeReply({ ...baseFacts(ctx, inq), kind: "booking_not_found" });
    log(ctx, "agent", `${inq.id}: cancellation request, but no open booking matches ${email ?? "the sender"}.`);
    return;
  }
  inq.bookingId = booking.id;

  if (booking.status === "held") {
    await cancelBooking(ctx, inq, booking, { percent: 0, cents: 0, rule: "the deposit had not been paid" });
    return;
  }

  const decision = refundFor(booking, ctx.now, venue.policy);
  if (decision.cents > venue.policy.autoRefundLimitCents) {
    inq.status = "awaiting_owner";
    inq.proposal = {
      kind: "refund",
      reason: `Policy gives ${usd(ctx, decision.cents)} back (${decision.rule}). That is above the ${usd(ctx, venue.policy.autoRefundLimitCents)} the agent may refund on its own.`,
      options: [],
      bookingId: booking.id,
      refundCents: decision.cents,
    };
    log(ctx, "agent", `${inq.id}: refund of ${usd(ctx, decision.cents)} on ${booking.id} needs the owner's approval.`);
    return;
  }
  await cancelBooking(ctx, inq, booking, decision);
}

async function cancelBooking(
  ctx: Ctx,
  inq: Inquiry,
  booking: Booking,
  decision: RefundDecision,
): Promise<void> {
  const { venue } = ctx.state;
  const when = formatLocal(booking.start, venue.utcOffsetMinutes);

  // Never more than what is left of the deposit, whatever was proposed.
  const left = Math.max(booking.depositCents - (booking.refundedCents ?? 0), 0);
  if (decision.cents > left) decision = { ...decision, cents: left };

  if (decision.cents > 0 && (!booking.captureId || booking.paymentPending)) {
    // Taken by phone or paid in cash: there is no PayPal capture to refund.
    decision = { percent: 0, cents: 0, rule: "the deposit was not paid through PayPal; refund it by hand" };
  }

  if (decision.cents > 0) {
    let refund: Refund;
    try {
      refund = await ctx.paypal.refundCapture(
        booking.captureId!,
        {
          amount: { currency_code: venue.currency, value: toAmount(decision.cents) },
          note_to_payer: `Cancelled booking on ${when}`,
        },
        // A retry of the same refund reuses the id; a different amount is a new request.
        `refund-${booking.id}-${booking.refundedCents ?? 0}-${decision.cents}`,
      );
    } catch (err) {
      // Keep the booking as it was; a person has to look at this one.
      inq.status = "awaiting_owner";
      inq.proposal = {
        kind: "refund",
        reason: `PayPal refused the refund (${describe(err)}). Approve to try again.`,
        options: [],
        bookingId: booking.id,
        refundCents: decision.cents,
      };
      log(ctx, "paypal", `${booking.id}: refund failed (${describe(err)}); booking left unchanged.`, "POST /v2/payments/captures/{id}/refund");
      return;
    }
    if (refund.status !== "COMPLETED" && refund.status !== "PENDING") {
      inq.status = "awaiting_owner";
      inq.proposal = {
        kind: "refund",
        reason: `PayPal answered the refund with status ${refund.status}. Check it in PayPal before trying again.`,
        options: [],
        bookingId: booking.id,
        refundCents: decision.cents,
      };
      log(ctx, "paypal", `${booking.id}: refund ${refund.id} is ${refund.status}; booking left unchanged.`, "POST /v2/payments/captures/{id}/refund");
      return;
    }
    booking.refundId = refund.id;
    booking.refundedCents = (booking.refundedCents ?? 0) + decision.cents;
    log(ctx, "agent", `${booking.id}: refunded ${usd(ctx, decision.cents)} (${decision.rule}), refund ${refund.id}.`, "POST /v2/payments/captures/{id}/refund");
  } else {
    log(ctx, "agent", `${booking.id}: cancelled with no refund (${decision.rule}).`);
  }

  booking.status = "cancelled";
  booking.holdExpiresAt = undefined;
  inq.status = "cancelled";
  inq.proposal = undefined;
  const original = ctx.state.inquiries.find((i) => i.id === booking.inquiryId);
  if (original && original.id !== inq.id) original.status = "cancelled";
  inq.reply = await ctx.llm.writeReply({
    ...baseFacts(ctx, inq),
    kind: "cancelled",
    when,
    refund: decision.cents > 0 ? usd(ctx, decision.cents) : undefined,
    refundRule: decision.rule,
  });
  await backfill(ctx);
}

// ---- PayPal events ----

export async function onPayPalEvent(ctx: Ctx, event: WebhookEvent): Promise<void> {
  const { state } = ctx;
  if (state.seenEvents.some((e) => e.id === event.id)) return;
  state.seenEvents.push({ id: event.id, at: ctx.now });

  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const order = event.resource as Partial<Order> | undefined;
    if (typeof order?.id !== "string") return;
    log(ctx, "paypal", `Payer approved order ${order.id}.`, event.event_type);
    await settleOrder(ctx, order.id);
    return;
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const capture = event.resource as Partial<Capture> | undefined;
    if (typeof capture?.id !== "string") return;
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    const booking = state.bookings.find(
      (b) => (orderId && b.orderId === orderId) || (capture.custom_id && b.id === capture.custom_id),
    );
    if (!booking) {
      log(ctx, "paypal", `Capture ${capture.id} does not match any booking; ignored.`, event.event_type);
      return;
    }
    confirm(ctx, booking, capture.id, event.event_type);
    return;
  }

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const refund = event.resource as Partial<Refund> | undefined;
    if (typeof refund?.id !== "string") return;
    const captureId = refund.links?.find((l) => l.rel === "up")?.href.split("/").pop();
    const booking = captureId ? state.bookings.find((b) => b.captureId === captureId) : undefined;
    if (!booking) return;
    if (booking.refundId === refund.id) {
      log(ctx, "paypal", `${booking.id}: PayPal confirmed refund ${refund.id}.`, event.event_type);
      return;
    }
    // A refund made outside this app, for example from the PayPal dashboard.
    const cents = refund.amount ? fromAmount(refund.amount.value) : 0;
    booking.refundedCents = Math.min(booking.depositCents, (booking.refundedCents ?? 0) + cents);
    log(ctx, "paypal", `${booking.id}: refund ${refund.id} of ${usd(ctx, cents)} was made outside the desk; recorded.`, event.event_type);
  }
}

// Take the deposit for an approved order. Reached from the return URL, from the
// CHECKOUT.ORDER.APPROVED webhook and from the reconciliation pass; whichever
// arrives first does the work and the others find it done.
export async function settleOrder(ctx: Ctx, orderId: string): Promise<void> {
  const { state } = ctx;
  const booking = state.bookings.find((b) => b.orderId === orderId);
  if (!booking) {
    log(ctx, "paypal", `Order ${orderId} does not match any booking; ignored.`);
    return;
  }
  if (booking.paymentPending) {
    await checkPendingCapture(ctx, booking);
    return;
  }
  if (booking.captureId) return;

  let revived = false;
  if (booking.status !== "held") {
    // The guest paid after the hold ran out.
    const slot = { resourceId: booking.resourceId, start: booking.start, end: booking.end };
    if (booking.status === "released" && booking.start > ctx.now && isFree(state, slot)) {
      booking.status = "held";
      revived = true;
      log(ctx, "agent", `${booking.id}: approved after the hold lapsed, but the slot is still free; taking the payment.`);
    } else {
      log(ctx, "agent", `${booking.id}: approved after the slot was given up; not capturing, so no money moves.`);
      return;
    }
  }

  const ref = "POST /v2/checkout/orders/{id}/capture";
  let order: Order;
  try {
    order = await ctx.paypal.captureOrder(orderId, "capture-" + booking.id);
  } catch (err) {
    // Whatever the refusal was called, the order itself says whether the money
    // was already taken (for example by an earlier attempt whose answer was lost).
    const refused = err instanceof PayPalError && err.status === 422;
    const seen = refused ? await lookUp(ctx, orderId) : undefined;
    if (seen?.status === "COMPLETED" && firstCapture(seen)) {
      order = seen;
    } else {
      if (revived) booking.status = "released";
      const notApproved = err instanceof PayPalError && err.issue === "ORDER_NOT_APPROVED";
      const why = notApproved ? "the payer has not approved it yet" : describe(err);
      const after = revived ? "the slot stays released" : "the hold stays until it expires";
      log(ctx, "paypal", `${booking.id}: not captured (${why}); ${after}.`, ref);
      return;
    }
  }

  const capture = firstCapture(order);
  if (capture?.status === "COMPLETED") {
    confirm(ctx, booking, capture.id, ref);
  } else if (capture?.status === "PENDING") {
    // PayPal is reviewing the payment. Keep the slot until it decides.
    booking.captureId = capture.id;
    booking.paymentPending = true;
    booking.holdExpiresAt = undefined;
    log(ctx, "paypal", `${booking.id}: capture ${capture.id} is pending at PayPal; keeping the slot until it clears.`, ref);
  } else {
    if (revived) booking.status = "released";
    log(ctx, "paypal", `${booking.id}: capture is ${capture?.status ?? "missing"}; nothing was confirmed.`, ref);
  }
}

async function checkPendingCapture(ctx: Ctx, booking: Booking): Promise<void> {
  const ref = "GET /v2/checkout/orders/{id}";
  const order = await lookUp(ctx, booking.orderId!);
  const capture = order && firstCapture(order);
  if (!capture || capture.status === "PENDING") return;
  if (capture.status === "COMPLETED") {
    confirm(ctx, booking, capture.id, ref);
    return;
  }
  booking.paymentPending = undefined;
  booking.captureId = undefined;
  booking.status = "released";
  const inq = ctx.state.inquiries.find((i) => i.id === booking.inquiryId);
  if (inq) inq.status = "lapsed";
  log(ctx, "paypal", `${booking.id}: PayPal ended the pending capture as ${capture.status}; slot released.`, ref);
  await backfill(ctx);
}

async function lookUp(ctx: Ctx, orderId: string): Promise<Order | undefined> {
  try {
    return await ctx.paypal.getOrder(orderId);
  } catch {
    return undefined;
  }
}

// Webhooks can be late, lost or not set up at all, and a payer can close the
// tab before PayPal sends them back. So ask PayPal about every order that is
// still waiting. Returns how many orders were looked at.
export async function reconcile(ctx: Ctx): Promise<number> {
  const waiting = ctx.state.bookings.filter(
    (b) => b.orderId && (b.paymentPending || (b.status === "held" && !b.captureId)),
  );
  for (const booking of waiting) {
    if (booking.paymentPending) {
      await checkPendingCapture(ctx, booking);
      continue;
    }
    const order = await lookUp(ctx, booking.orderId!);
    if (order?.status === "APPROVED" || order?.status === "COMPLETED") {
      log(ctx, "system", `${booking.id}: PayPal shows order ${order.id} as ${order.status}; settling.`, "GET /v2/checkout/orders/{id}");
      await settleOrder(ctx, order.id);
    }
  }
  return waiting.length;
}

function confirm(ctx: Ctx, booking: Booking, captureId: string, ref: string): void {
  if (booking.status === "confirmed" && booking.captureId === captureId) return;
  if (booking.status === "cancelled" || booking.status === "released") {
    const slot = { resourceId: booking.resourceId, start: booking.start, end: booking.end };
    if (booking.status === "cancelled" || !isFree(ctx.state, slot)) {
      // Money arrived for a slot that is gone. Never double-book; a person decides.
      if (booking.captureId === captureId) return;
      booking.captureId = captureId;
      log(ctx, "system", `${booking.id}: a deposit was captured (${captureId}) but the booking is ${booking.status}. Refund it in PayPal or rebook the guest.`, ref);
      return;
    }
  }
  booking.status = "confirmed";
  booking.captureId = captureId;
  booking.paymentPending = undefined;
  booking.holdExpiresAt = undefined;
  const inq = ctx.state.inquiries.find((i) => i.id === booking.inquiryId);
  if (inq) inq.status = "booked";
  log(ctx, "paypal", `${booking.id}: deposit ${usd(ctx, booking.depositCents)} captured (${captureId}); booking confirmed.`, ref);
}

// ---- time ----

// Release holds that were not paid in time, then offer the freed slots on.
export async function tick(ctx: Ctx): Promise<number> {
  const { venue } = ctx.state;
  let released = 0;
  for (const booking of ctx.state.bookings) {
    if (booking.status !== "held" || booking.paymentPending) continue;
    if (!booking.holdExpiresAt || booking.holdExpiresAt > ctx.now) continue;
    booking.status = "released";
    released++;
    const when = formatLocal(booking.start, venue.utcOffsetMinutes);
    const inq = ctx.state.inquiries.find((i) => i.id === booking.inquiryId);
    if (inq) {
      inq.status = "lapsed";
      inq.reply = await ctx.llm.writeReply({ ...baseFacts(ctx, inq), kind: "hold_lapsed", when });
    }
    log(ctx, "agent", `${booking.id}: no payment within ${venue.policy.holdMinutes} min; released ${when}.`);
  }
  if (released > 0) await backfill(ctx);
  return released;
}

// Give freed slots to waitlisted guests, oldest request first.
async function backfill(ctx: Ctx): Promise<void> {
  const waiting = ctx.state.inquiries
    .filter((i) => i.status === "waitlisted" && i.wanted)
    .sort((a, b) => a.receivedAt - b.receivedAt);
  for (const inq of waiting) {
    const offering = ctx.state.venue.offerings.find((o) => o.id === inq.understanding?.offeringId);
    if (!offering || !bookable(ctx.state, inq.wanted!, ctx.now)) continue;
    log(ctx, "agent", `${inq.id}: the slot this guest was waiting for has opened up.`);
    await holdOrAsk(ctx, inq, offering, inq.wanted!, "pay_link");
  }
}

// ---- the owner moves a booking on the board ----

// The owner drags a booking to another time. The move is checked against the
// same rules the agent holds by; if it passes, the guest's reply is rewritten
// for the new time. Returns the reason when the move is refused; nothing
// changes then. The PayPal order is not touched: same amount, same link.
export async function moveBooking(ctx: Ctx, bookingId: string, start: number): Promise<string | undefined> {
  const { venue } = ctx.state;
  const booking = mustFind(ctx.state.bookings, bookingId, "booking");
  if (booking.status !== "held" && booking.status !== "confirmed") {
    return `${booking.id} is ${booking.status} and cannot be moved.`;
  }
  if (start === booking.start) return undefined;
  const slot: Slot = { resourceId: booking.resourceId, start, end: start + (booking.end - booking.start) };
  const when = formatLocal(slot.start, venue.utcOffsetMinutes);
  if (!withinOpeningHours(venue, slot)) return `${when} is outside opening hours.`;
  if (slot.start < ctx.now + venue.policy.leadMinutes * MIN) {
    return `${when} is too soon; bookings need ${venue.policy.leadMinutes} minutes' notice.`;
  }
  if (!isFree(ctx.state, slot, booking.id)) return `${when} overlaps another booking.`;

  const from = formatLocal(booking.start, venue.utcOffsetMinutes);
  booking.start = slot.start;
  booking.end = slot.end;
  log(ctx, "owner", `${booking.id}: moved from ${from} to ${when}.`);

  const inq = ctx.state.inquiries.find((i) => i.id === booking.inquiryId);
  const offering = venue.offerings.find((o) => o.id === booking.offeringId);
  if (!inq || !offering) return undefined;
  const paying = booking.status === "held";
  inq.reply = await ctx.llm.writeReply({
    ...baseFacts(ctx, inq),
    kind: "moved",
    offeringName: offering.name,
    when,
    guests: booking.guests,
    ...(paying
      ? {
          payUrl: booking.approveUrl,
          deposit: usd(ctx, booking.depositCents),
          holdMinutes: Math.max(1, Math.ceil(((booking.holdExpiresAt ?? ctx.now) - ctx.now) / MIN)),
        }
      : {}),
  });
  log(
    ctx,
    "agent",
    paying
      ? `${inq.id}: rewrote the pay-link reply for ${when}; order ${booking.orderId} and the ${usd(ctx, booking.depositCents)} deposit are unchanged.`
      : `${inq.id}: drafted a note to the guest about the new time, ${when}. The paid deposit stays as it is.`,
  );
  return undefined;
}

// ---- helpers ----

function baseFacts(ctx: Ctx, inq: Inquiry): Pick<ReplyFacts, "lang" | "guestName" | "venueName"> {
  return {
    lang: inq.understanding?.lang ?? "en",
    guestName: inq.understanding?.name,
    venueName: ctx.state.venue.name,
  };
}

function log(ctx: Ctx, actor: LogEntry["actor"], text: string, ref?: string): void {
  ctx.state.log.push({ seq: ++ctx.state.logSeq, at: ctx.now, actor, text, ref });
}

function usd(ctx: Ctx, cents: number): string {
  const { currency } = ctx.state.venue;
  return currency === "USD" ? `$${toAmount(cents)}` : `${toAmount(cents)} ${currency}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mustFind<T extends { id: string }>(list: T[], id: string, what: string): T {
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error(`unknown ${what} ${id}`);
  return item;
}

export function shortId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (const b of crypto.getRandomValues(new Uint8Array(6))) id += alphabet[b % alphabet.length];
  return id;
}

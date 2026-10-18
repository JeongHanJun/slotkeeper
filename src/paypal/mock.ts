import type { Store } from "../store";
import { PayPalError, type PayPalClient } from "./client";
import type {
  Capture,
  CreateOrderRequest,
  ErrorBody,
  Money,
  Order,
  Refund,
  RefundRequest,
  WebhookEvent,
} from "./types";

// Stand-in for the PayPal sandbox. No network, no credentials, no real money.
// It answers with the same shapes and status rules as the REST API for the calls
// this app makes, and queues the webhook events PayPal would send.
// Nothing outside this file and the /mock/paypal/* routes knows it exists.
//
// Order creation, lookups and every error marked "seen" in docs/SANDBOX_SHAPES.md
// were copied from real sandbox answers. The capture and refund bodies follow
// the API reference and PayPal's webhook simulator until a real approved order
// has been recorded.

const DB_KEY = "mock-paypal";
const WEBHOOK_SECRET = "mock-webhook-secret";
export const MOCK_WEBHOOK_ID = "MOCK-WEBHOOK-ID";
// Links in real answers use this host, not api-m.
const API = "https://api.sandbox.paypal.com";
// Currencies PayPal takes without decimals.
const WHOLE_UNIT = new Set(["JPY", "HUF", "TWD", "KRW"]);

interface StoredOrder {
  order: Order;
  // Kept for the approval page; the real API does not echo these back.
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
}

interface StoredCapture {
  capture: Capture;
  orderId: string;
  refundedCents: number;
}

interface MockDb {
  orders: Record<string, StoredOrder>;
  captures: Record<string, StoredCapture>;
  // PayPal-Request-Id -> response already given for it.
  replies: Record<string, unknown>;
  outbox: WebhookEvent[];
}

export interface Delivery {
  headers: Record<string, string>;
  body: string;
}

export class MockPayPal implements PayPalClient {
  readonly mode = "mock" as const;
  readonly webhooksConfigured = true;

  // `checkoutBase` is where the fake approval page lives (this app's own origin).
  constructor(
    private store: Store,
    private checkoutBase: string,
  ) {}

  private async load(): Promise<MockDb> {
    return (
      (await this.store.get<MockDb>(DB_KEY)) ?? { orders: {}, captures: {}, replies: {}, outbox: [] }
    );
  }

  private save(db: MockDb): Promise<void> {
    return this.store.put(DB_KEY, db);
  }

  async createOrder(body: CreateOrderRequest, requestId: string): Promise<Order> {
    const db = await this.load();
    const key = "order:" + requestId;
    if (db.replies[key]) return db.replies[key] as Order;

    const unit = body.purchase_units?.[0];
    if (body.intent !== "CAPTURE" || !unit) {
      throw fail(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER");
    }
    const { value, currency_code } = unit.amount;
    const field = `/purchase_units/@reference_id=='${unit.reference_id}'/amount/value`;
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw fail(400, "INVALID_REQUEST", "INVALID_PARAMETER_SYNTAX", { field, value, location: "body" });
    }
    if (Number(value) <= 0) throw fail(422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_ZERO_OR_NEGATIVE", { field, value });
    const decimals = value.split(".")[1]?.length ?? 0;
    if (WHOLE_UNIT.has(currency_code) && decimals > 0) {
      throw fail(422, "UNPROCESSABLE_ENTITY", "DECIMALS_NOT_SUPPORTED", { field, value });
    }
    if (decimals > 2) throw fail(422, "UNPROCESSABLE_ENTITY", "DECIMAL_PRECISION", { field, value });
    if (!("paypal" in body.payment_source)) {
      // What a sandbox account without card processing answers.
      throw fail(422, "UNPROCESSABLE_ENTITY", "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING");
    }

    const context = body.payment_source.paypal.experience_context;
    const id = newId();
    const order: Order = {
      id,
      intent: "CAPTURE",
      status: "PAYER_ACTION_REQUIRED",
      payment_source: { paypal: {} },
      purchase_units: body.purchase_units.map((u) => ({
        reference_id: u.reference_id,
        amount: u.amount,
        payee: {
          email_address: "merchant@example.com",
          merchant_id: "MOCKMERCHANT1",
          display_data: { brand_name: context.brand_name },
        },
        description: u.description,
        custom_id: u.custom_id,
      })),
      links: [
        { href: `${API}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        {
          href: `${this.checkoutBase}/mock/paypal/checkoutnow?token=${id}`,
          rel: "payer-action",
          method: "GET",
        },
      ],
    };
    db.orders[id] = {
      // Lookups carry create_time; the answer to the create call does not.
      order: { ...structuredClone(order), create_time: new Date().toISOString() },
      brandName: context.brand_name,
      returnUrl: context.return_url,
      cancelUrl: context.cancel_url,
    };
    // A repeated request id gets the first order back, even if the body differs.
    db.replies[key] = order;
    await this.save(db);
    return order;
  }

  async getOrder(orderId: string): Promise<Order> {
    const db = await this.load();
    const found = db.orders[orderId];
    if (!found) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    return found.order;
  }

  async captureOrder(orderId: string, requestId: string): Promise<Order> {
    const db = await this.load();
    const key = "capture:" + requestId;
    if (db.replies[key]) return db.replies[key] as Order;

    const found = db.orders[orderId];
    if (!found) {
      throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", { field: "order_id", value: orderId, location: "path" });
    }
    const { order } = found;
    if (order.status === "COMPLETED") throw fail(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED");
    if (order.status !== "APPROVED") throw fail(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED");

    const unit = order.purchase_units![0]!;
    const amount = unit.amount!;
    const now = new Date().toISOString();
    const gross = cents(amount.value);
    // Illustrative fee only; real sandbox fees depend on the account's country.
    const fee = Math.round(gross * 0.0349) + 49;
    const capture: Capture = {
      id: newId(),
      status: "COMPLETED",
      amount,
      final_capture: true,
      custom_id: unit.custom_id,
      seller_receivable_breakdown: {
        gross_amount: amount,
        paypal_fee: money(fee, amount.currency_code),
        net_amount: money(gross - fee, amount.currency_code),
      },
      supplementary_data: { related_ids: { order_id: orderId } },
      create_time: now,
      update_time: now,
    };
    capture.links = [
      { href: `${API}/v2/payments/captures/${capture.id}`, rel: "self", method: "GET" },
      { href: `${API}/v2/payments/captures/${capture.id}/refund`, rel: "refund", method: "POST" },
      { href: `${API}/v2/checkout/orders/${orderId}`, rel: "up", method: "GET" },
    ];

    order.status = "COMPLETED";
    unit.payments = { captures: [capture] };
    db.captures[capture.id] = { capture, orderId, refundedCents: 0 };
    db.replies[key] = order;
    db.outbox.push(
      event("PAYMENT.CAPTURE.COMPLETED", "capture", `Payment completed for $ ${amount.value} ${amount.currency_code}`, capture),
    );
    await this.save(db);
    return order;
  }

  async refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund> {
    const db = await this.load();
    const key = "refund:" + requestId;
    if (db.replies[key]) return db.replies[key] as Refund;

    const found = db.captures[captureId];
    if (!found) {
      throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", { field: "capture_id", value: captureId, location: "path" });
    }
    const { capture } = found;
    const total = cents(capture.amount.value);
    const left = total - found.refundedCents;
    if (left <= 0) throw fail(422, "UNPROCESSABLE_ENTITY", "CAPTURE_FULLY_REFUNDED");
    if (body.amount && body.amount.currency_code !== capture.amount.currency_code) {
      throw fail(422, "UNPROCESSABLE_ENTITY", "CURRENCY_MISMATCH");
    }
    // No amount means "refund whatever is left", as in the real API.
    const want = body.amount ? cents(body.amount.value) : left;
    if (want <= 0) throw fail(422, "UNPROCESSABLE_ENTITY", "INVALID_PARAMETER_VALUE");
    if (want > left) throw fail(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED");

    found.refundedCents += want;
    capture.status = found.refundedCents === total ? "REFUNDED" : "PARTIALLY_REFUNDED";

    const refundId = newId();
    const now = new Date().toISOString();
    const currency = capture.amount.currency_code;
    const refund: Refund = {
      id: refundId,
      status: "COMPLETED",
      amount: money(want, currency),
      note_to_payer: body.note_to_payer,
      seller_payable_breakdown: {
        gross_amount: money(want, currency),
        paypal_fee: money(0, currency),
        net_amount: money(want, currency),
        total_refunded_amount: money(found.refundedCents, currency),
      },
      create_time: now,
      update_time: now,
      links: [
        { href: `${API}/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
        { href: `${API}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
      ],
    };
    db.replies[key] = refund;
    db.outbox.push(
      event("PAYMENT.CAPTURE.REFUNDED", "refund", `A $ ${refund.amount!.value} ${refund.amount!.currency_code} capture payment was refunded`, refund),
    );
    await this.save(db);
    return refund;
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
    const id = headers.get("paypal-transmission-id");
    const time = headers.get("paypal-transmission-time");
    const sig = headers.get("paypal-transmission-sig");
    if (!id || !time || !sig) return false;
    return sig === (await sign(id, time, rawBody));
  }

  // ---- mock-only controls: the things a payer or PayPal itself would do ----

  // What the approval page needs to show.
  async checkoutView(orderId: string): Promise<StoredOrder | undefined> {
    return (await this.load()).orders[orderId];
  }

  // The payer pressed "Pay" on the approval page.
  async approve(orderId: string, payerEmail: string): Promise<Order> {
    const db = await this.load();
    const found = db.orders[orderId];
    if (!found) throw fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    const { order } = found;
    if (order.status !== "PAYER_ACTION_REQUIRED" && order.status !== "CREATED") return order;

    order.status = "APPROVED";
    order.payer = {
      name: { given_name: "Mock", surname: "Payer" },
      email_address: payerEmail,
      payer_id: newId().slice(0, 13),
    };
    db.outbox.push(
      event("CHECKOUT.ORDER.APPROVED", "checkout-order", "An order has been approved by buyer", order),
    );
    await this.save(db);
    return order;
  }

  // Pending webhook deliveries, signed the way verifyWebhook expects.
  async takeOutbox(): Promise<Delivery[]> {
    const db = await this.load();
    if (db.outbox.length === 0) return [];
    const events = db.outbox;
    db.outbox = [];
    await this.save(db);

    const out: Delivery[] = [];
    for (const ev of events) out.push(await this.deliveryFor(ev));
    return out;
  }

  // Wrap an event body the way a delivery arrives. Also used by tests to send
  // payloads recorded from PayPal's webhook simulator.
  async deliveryFor(ev: WebhookEvent): Promise<Delivery> {
    const body = JSON.stringify(ev);
    const id = crypto.randomUUID();
    const time = ev.create_time;
    return {
      body,
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": id,
        "paypal-transmission-time": time,
        "paypal-transmission-sig": await sign(id, time, body),
        "paypal-auth-algo": "MOCK-HMAC-SHA256",
        "paypal-cert-url": "mock://cert",
      },
    };
  }
}

function event<R>(type: string, resourceType: string, summary: string, resource: R): WebhookEvent<R> {
  const id = "WH-" + newId() + "-" + newId();
  return {
    id,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: resourceType,
    resource_version: "2.0",
    event_type: type,
    summary,
    // Snapshot, so later changes to the stored object do not rewrite history.
    resource: JSON.parse(JSON.stringify(resource)) as R,
    links: [
      { href: `${API}/v1/notifications/webhooks-events/${id}`, rel: "self", method: "GET" },
      { href: `${API}/v1/notifications/webhooks-events/${id}/resend`, rel: "resend", method: "POST" },
    ],
  };
}

const DESCRIPTIONS: Record<string, string> = {
  ORDER_NOT_APPROVED:
    "Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.",
  CANNOT_BE_ZERO_OR_NEGATIVE:
    "Must be greater than zero. If the currency supports decimals, only two decimal place precision is supported.",
  DECIMAL_PRECISION: "If the currency supports decimals, only two decimal place precision is supported.",
  DECIMALS_NOT_SUPPORTED: "Currency does not support decimals.",
  INVALID_PARAMETER_SYNTAX: "The value of a field does not conform to the expected format.",
  INVALID_RESOURCE_ID: "Specified resource ID does not exist. Please check the resource ID and try again.",
  PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING:
    "Payee account is not setup to be able to process card payments. Please contact PayPal customer support.",
};

const MESSAGES: Record<number, string> = {
  400: "Request is not well-formed, syntactically incorrect, or violates schema.",
  404: "The specified resource does not exist.",
  422: "The requested action could not be performed, semantically incorrect, or failed business validation.",
};

function fail(
  status: number,
  name: string,
  issue: string,
  where: { field?: string; value?: string; location?: string } = {},
): PayPalError {
  const body: ErrorBody = {
    name,
    details: [{ ...where, issue, description: DESCRIPTIONS[issue] }],
    message: MESSAGES[status] ?? "",
    debug_id: newId().toLowerCase().slice(0, 13),
    links: [
      {
        href: `https://developer.paypal.com/api/rest/reference/orders/v2/errors/#${issue}`,
        rel: "information_link",
        method: "GET",
      },
    ],
  };
  return new PayPalError(status, body);
}

// PayPal ids look like "5O190127TN364715T": 17 upper-case letters and digits.
function newId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

function cents(value: string): number {
  return Math.round(Number(value) * 100);
}

function money(c: number, currency: string): Money {
  return { currency_code: currency, value: (c / 100).toFixed(2) };
}

// Real PayPal signs "id|time|webhookId|crc32(body)" with an RSA certificate.
// The mock keeps the same inputs but uses a shared-secret HMAC.
async function sign(transmissionId: string, time: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${transmissionId}|${time}|${MOCK_WEBHOOK_ID}|${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

import type { CreateOrderRequest, ErrorBody, Order, Refund, RefundRequest } from "./types";

// The only door to PayPal. The agent never sees which implementation is behind it.
// `requestId` is sent as the PayPal-Request-Id header, so a retried call cannot
// create a second order, capture or refund.
export interface PayPalClient {
  readonly mode: "mock" | "sandbox" | "live";
  // False when no webhook delivery could pass verifyWebhook (nothing registered yet).
  readonly webhooksConfigured: boolean;
  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  captureOrder(orderId: string, requestId: string): Promise<Order>;
  refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund>;
  // True only if the delivery really came from PayPal. `rawBody` must be the
  // exact bytes received; re-serialised JSON does not verify.
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public body: ErrorBody,
  ) {
    super(`${body.name}: ${body.details?.[0]?.issue ?? body.message}`);
  }

  get issue(): string | undefined {
    return this.body.details?.[0]?.issue;
  }
}

// The link the payer must open. PayPal names it "payer-action" when
// payment_source is given and "approve" otherwise.
export function approveLink(order: Order): string | undefined {
  const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return link?.href;
}

export function firstCapture(order: Order) {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}

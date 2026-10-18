import { describe, expect, inject, it } from "vitest";
import { firstCapture, type PayPalClient } from "../../src/paypal/client";
import { LivePayPal, SANDBOX_API, type CallLog } from "../../src/paypal/live";
import type { CreateOrderRequest } from "../../src/paypal/types";
import { orderBody, payPalContract, refusal } from "../contract";

// Opt-in suite against the real PayPal sandbox (npm run test:sandbox).
// Nothing here needs a payer: it covers everything up to the approval page,
// and the card path on accounts that have card processing enabled.

declare module "vitest" {
  export interface ProvidedContext {
    sandbox: { ready: boolean; clientId: string; clientSecret: string };
  }
}

const sandbox = inject("sandbox");
const calls: CallLog[] = [];
let client: LivePayPal | undefined;

function live(): LivePayPal {
  client ??= new LivePayPal({
    apiBase: SANDBOX_API,
    clientId: sandbox.clientId,
    clientSecret: sandbox.clientSecret,
    // A made-up id: enough to exercise the verification call, never a match.
    webhookId: "0AB12345CD678901E",
    log: (entry) => calls.push(entry),
  });
  return client;
}

// PayPal's published sandbox test Visa:
// https://developer.paypal.com/tools/sandbox/card-testing/
const TEST_CARD = {
  number: "4012888888881881",
  expiry: "2030-12",
  security_code: "123",
  name: "Test Buyer",
  billing_address: {
    address_line_1: "1 Main St",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

if (!sandbox.ready) {
  describe("PayPal sandbox", () => {
    it.skip("needs PAYPAL_MODE=sandbox, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .dev.vars", () => {});
  });
} else {
  payPalContract("sandbox", () => live() as PayPalClient);

  describe("PayPal sandbox", () => {
    it("reuses one access token for the whole run", async () => {
      await live().createOrder(orderBody("24.00"), "test-" + crypto.randomUUID());
      expect(calls.filter((c) => c.path === "/v1/oauth2/token" && c.status === 200)).toHaveLength(1);
      expect(calls.every((c) => !JSON.stringify(c).includes(sandbox.clientSecret))).toBe(true);
    });

    it("sends the payer to the sandbox checkout page", async () => {
      const order = await live().createOrder(orderBody("24.00"), "test-" + crypto.randomUUID());
      const link = order.links!.find((l) => l.rel === "payer-action")!;
      expect(link.href).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`);
    });

    it("rejects a webhook delivery PayPal did not sign", async () => {
      const headers = new Headers({
        "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
        "paypal-transmission-time": "2026-10-10T03:00:00Z",
        "paypal-transmission-sig": "bm90IGEgc2lnbmF0dXJl",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
      });
      const body = JSON.stringify({ id: "WH-TEST", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} });
      expect(await live().verifyWebhook(headers, body)).toBe(false);
      // Both checks ran: the certificate was fetched and PayPal was asked.
      expect(calls.some((c) => c.path === "/v1/notifications/verify-webhook-signature" && c.status === 200)).toBe(true);
    });

    // The only way to finish a payment without a person at the approval page.
    // It works only if the sandbox business account has card processing enabled.
    it("captures and refunds through a test card, if the account allows cards", async () => {
      const body: CreateOrderRequest = { ...orderBody("24.00"), payment_source: { card: TEST_CARD } };
      const attempt = await live()
        .createOrder(body, "test-" + crypto.randomUUID())
        .then(
          (order) => ({ order }),
          async (err: unknown) => ({ refused: await refusal(Promise.reject(err)) }),
        );

      if ("refused" in attempt) {
        expect(attempt.refused).toEqual({
          status: 422,
          name: "UNPROCESSABLE_ENTITY",
          issue: "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING",
        });
        console.log("card path: not available on this sandbox account (PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING)");
        return;
      }

      const { order } = attempt;
      expect(order.status).toBe("COMPLETED");
      const capture = firstCapture(order)!;
      expect(capture.status).toBe("COMPLETED");
      const usd = (value: string) => ({ amount: { currency_code: "USD", value } });
      const id = () => "test-" + crypto.randomUUID();

      const again = await refusal(live().captureOrder(order.id, id()));
      const tooMuch = await refusal(live().refundCapture(capture.id, usd("30.00"), id()));
      const half = await live().refundCapture(capture.id, usd("12.00"), id());
      const rest = await live().refundCapture(capture.id, {}, id());
      const nothingLeft = await refusal(live().refundCapture(capture.id, usd("1.00"), id()));
      console.log("card path:", JSON.stringify({ again, tooMuch, half: half.status, rest: rest.status, nothingLeft }));

      expect(again.status).toBe(422);
      expect(tooMuch.status).toBe(422);
      expect(half.amount!.value).toBe("12.00");
      expect(rest.amount!.value).toBe("12.00");
      expect(nothingLeft.status).toBe(422);
    });
  });
}

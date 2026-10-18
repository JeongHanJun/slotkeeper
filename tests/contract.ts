import { describe, expect, it } from "vitest";
import { approveLink, PayPalError, type PayPalClient } from "../src/paypal/client";
import type { CreateOrderRequest } from "../src/paypal/types";

// What the desk relies on from PayPal before a payer is involved. Every
// expectation here was first observed on the real sandbox; the same checks run
// against the mock (npm test) and against the sandbox (npm run test:sandbox),
// so the two cannot drift apart unnoticed.

export function orderBody(value: string, currency = "USD", ref = "BK-TEST01"): CreateOrderRequest {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: ref,
        custom_id: ref,
        description: "Wheel throwing class (deposit)",
        amount: { currency_code: currency, value },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Dalhang Pottery Studio",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: "http://127.0.0.1:8794/api/return",
          cancel_url: "http://127.0.0.1:8794/thanks.html?cancelled=1",
        },
      },
    },
  };
}

export async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PayPalError);
  const e = err as PayPalError;
  return { status: e.status, name: e.body.name, issue: e.issue };
}

const unique = () => "test-" + crypto.randomUUID();
const UNKNOWN_ID = "0AB12345CD678901E";

export function payPalContract(label: string, client: () => PayPalClient) {
  describe(`PayPal contract: ${label}`, () => {
    it("creates an order that waits for the payer", async () => {
      const order = await client().createOrder(orderBody("24.00"), unique());
      expect(order.id).toMatch(/^[A-Z0-9]{17}$/);
      expect(order.status).toBe("PAYER_ACTION_REQUIRED");
      expect(order.intent).toBe("CAPTURE");
      expect(order.payment_source).toEqual({ paypal: {} });
      expect(order.links!.map((l) => l.rel)).toEqual(["self", "payer-action"]);
      expect(approveLink(order)).toContain(`checkoutnow?token=${order.id}`);

      const unit = order.purchase_units![0]!;
      expect(unit).toMatchObject({
        reference_id: "BK-TEST01",
        custom_id: "BK-TEST01",
        description: "Wheel throwing class (deposit)",
        amount: { currency_code: "USD", value: "24.00" },
        payee: { display_data: { brand_name: "Dalhang Pottery Studio" } },
      });
      expect(unit.payee!.merchant_id).toBeTruthy();
    });

    it("returns the same order for a repeated request id, whatever the body", async () => {
      const id = unique();
      const first = await client().createOrder(orderBody("24.00"), id);
      const again = await client().createOrder(orderBody("24.00"), id);
      const changed = await client().createOrder(orderBody("25.00"), id);
      expect(again.id).toBe(first.id);
      expect(changed.id).toBe(first.id);
      expect(changed.purchase_units![0]!.amount!.value).toBe("24.00");
      expect((await client().createOrder(orderBody("24.00"), unique())).id).not.toBe(first.id);
    });

    it("looks an order up", async () => {
      const created = await client().createOrder(orderBody("24.00"), unique());
      const found = await client().getOrder(created.id);
      expect(found).toMatchObject({ id: created.id, status: "PAYER_ACTION_REQUIRED" });
      expect(found.create_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("refuses amounts it cannot charge", async () => {
      const tryAmount = (value: string, currency?: string) =>
        refusal(client().createOrder(orderBody(value, currency), unique()));
      expect(await tryAmount("0.00")).toEqual({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "CANNOT_BE_ZERO_OR_NEGATIVE" });
      expect(await tryAmount("-5.00")).toEqual({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "CANNOT_BE_ZERO_OR_NEGATIVE" });
      expect(await tryAmount("12.345")).toEqual({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "DECIMAL_PRECISION" });
      expect(await tryAmount("abc")).toEqual({ status: 400, name: "INVALID_REQUEST", issue: "INVALID_PARAMETER_SYNTAX" });
      expect(await tryAmount("1000.50", "JPY")).toEqual({ status: 422, name: "UNPROCESSABLE_ENTITY", issue: "DECIMALS_NOT_SUPPORTED" });
    });

    it("will not capture before the payer approves", async () => {
      const order = await client().createOrder(orderBody("24.00"), unique());
      expect(await refusal(client().captureOrder(order.id, unique()))).toEqual({
        status: 422,
        name: "UNPROCESSABLE_ENTITY",
        issue: "ORDER_NOT_APPROVED",
      });
      expect((await client().getOrder(order.id)).status).toBe("PAYER_ACTION_REQUIRED");
    });

    it("answers 404 for ids it does not know", async () => {
      const notFound = { status: 404, name: "RESOURCE_NOT_FOUND", issue: "INVALID_RESOURCE_ID" };
      expect(await refusal(client().getOrder(UNKNOWN_ID))).toEqual(notFound);
      expect(await refusal(client().captureOrder(UNKNOWN_ID, unique()))).toEqual(notFound);
      expect(await refusal(client().refundCapture(UNKNOWN_ID, {}, unique()))).toEqual(notFound);
    });
  });
}

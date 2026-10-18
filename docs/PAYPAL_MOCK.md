# The PayPal mock and what it mirrors

`src/paypal/mock.ts` stands in for the PayPal sandbox so the app and its tests
run with no credentials and no network. The agent only sees the `PayPalClient`
interface in `src/paypal/client.ts`; `PAYPAL_MODE=sandbox` swaps in
`src/paypal/live.ts` with no other change.

What the real sandbox answers is written down in `docs/SANDBOX_SHAPES.md`. The
checks in `tests/contract.ts` run against both the mock (`npm test`) and the
sandbox (`npm run test:sandbox`), so the mock cannot drift from the parts of
PayPal that have been observed.

## Calls

| Interface method | Real endpoint | Mock answer |
|---|---|---|
| `createOrder(body, requestId)` | `POST /v2/checkout/orders` | Order with `status: "PAYER_ACTION_REQUIRED"`, `payment_source: { paypal: {} }`, `payee`, links `self` and `payer-action` |
| `getOrder(id)` | `GET /v2/checkout/orders/{id}` | Stored order, with `create_time` |
| `captureOrder(id, requestId)` | `POST /v2/checkout/orders/{id}/capture` | Order with `status: "COMPLETED"` and `purchase_units[0].payments.captures[0]` |
| `refundCapture(id, body, requestId)` | `POST /v2/payments/captures/{capture_id}/refund` | Refund with `status: "COMPLETED"`, `seller_payable_breakdown`, links `self`, `up` |
| `verifyWebhook(headers, rawBody)` | certificate check, then `POST /v1/notifications/verify-webhook-signature` | HMAC check (see below) |

`requestId` is the `PayPal-Request-Id` header. A repeated id returns the first
answer again, even if the body is different, as the sandbox does.

Request body sent for an order:

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "reference_id": "BK-XM563Y",
    "custom_id": "BK-XM563Y",
    "description": "Wheel throwing class, Wed 14 Oct, 14:00, 3 guests (deposit)",
    "amount": { "currency_code": "USD", "value": "72.00" }
  }],
  "payment_source": { "paypal": { "experience_context": {
    "brand_name": "Dalhang Pottery Studio",
    "user_action": "PAY_NOW",
    "shipping_preference": "NO_SHIPPING",
    "return_url": "https://<app>/api/return",
    "cancel_url": "https://<app>/thanks.html?cancelled=1"
  }}}
}
```

## Errors

Body shape: `{ name, details: [{ issue, description, field?, value?, location? }], message, debug_id, links }`.

| Situation | Status | `name` | `details[0].issue` | Checked against the sandbox |
|---|---|---|---|---|
| Amount zero or negative | 422 | `UNPROCESSABLE_ENTITY` | `CANNOT_BE_ZERO_OR_NEGATIVE` | yes |
| More than two decimals | 422 | `UNPROCESSABLE_ENTITY` | `DECIMAL_PRECISION` | yes |
| Amount is not a number | 400 | `INVALID_REQUEST` | `INVALID_PARAMETER_SYNTAX` | yes |
| Decimals in JPY, KRW, HUF, TWD | 422 | `UNPROCESSABLE_ENTITY` | `DECIMALS_NOT_SUPPORTED` | yes |
| Capture before the payer approved | 422 | `UNPROCESSABLE_ENTITY` | `ORDER_NOT_APPROVED` | yes |
| Unknown order or capture | 404 | `RESOURCE_NOT_FOUND` | `INVALID_RESOURCE_ID` | yes |
| Card as payment source | 422 | `UNPROCESSABLE_ENTITY` | `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` | yes (this account) |
| Capture twice | 422 | `UNPROCESSABLE_ENTITY` | `ORDER_ALREADY_CAPTURED` | no |
| Refund more than is left | 422 | `UNPROCESSABLE_ENTITY` | `REFUND_AMOUNT_EXCEEDED` | no |
| Refund a fully refunded capture | 422 | `UNPROCESSABLE_ENTITY` | `CAPTURE_FULLY_REFUNDED` | no |
| Refund in another currency | 422 | `UNPROCESSABLE_ENTITY` | `CURRENCY_MISMATCH` | no |

The four "no" rows need a captured payment, which needs a person at the
approval page once. `npm run sandbox:settle -- <order id>` triggers each of
them and records the answers in `docs/sandbox-recorded/`; correct this table
and `mock.ts` from those files. The desk does not branch on these names: after
a refused capture it looks the order up and goes by its status, and a refused
refund is handed to the owner with PayPal's wording.

What changed in the mock after the first real run (2026-10-10):

- The create answer has no `create_time`, echoes `payment_source` as
  `{ paypal: {} }` and adds `payee` with the brand name.
- Bad amounts used to be one made-up `INVALID_PARAMETER_VALUE`; they are now
  the four real issues above.
- Error bodies carry `description`, `field`/`value`/`location` and an
  `information_link`.
- A repeated request id with a different body returns the first order.
- Card payment sources are refused the way this account refuses them.
- Link hosts are `api.sandbox.paypal.com`; events have a `resend` link; the
  refund has `seller_payable_breakdown`; the approved order's payer has a name.

## Webhook events

Envelope and fields: see `docs/SANDBOX_SHAPES.md`. The mock queues
`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` and
`PAYMENT.CAPTURE.REFUNDED` and hands them to the app's own listener after each
request. `tests/webhooks.test.ts` also delivers the three bodies returned by
PayPal's webhook simulator (`tests/fixtures/simulator/`).

## Where the mock differs on purpose

- **Approval page.** The `payer-action` link points to
  `/mock/paypal/checkoutnow?token=<order id>` on this app instead of
  `https://www.sandbox.paypal.com/checkoutnow?token=...`. It carries a banner
  saying it is a mock.
- **Webhook delivery.** In process, right after the request that caused it.
- **Webhook signature.** PayPal signs `transmission id|time|webhook id|crc32(body)`
  with RSA and a certificate. The mock keeps the same inputs but uses an HMAC
  with a fixed secret and `paypal-auth-algo: MOCK-HMAC-SHA256`. The real check
  is in `src/paypal/webhook.ts` and has its own tests.
- **Fees.** `seller_receivable_breakdown` uses a made-up 3.49% + $0.49.
- **Payee.** `merchant@example.com` / `MOCKMERCHANT1`.
- Captures and refunds always complete at once. The agent's handling of a
  `PENDING` capture is tested with a wrapper around the mock.

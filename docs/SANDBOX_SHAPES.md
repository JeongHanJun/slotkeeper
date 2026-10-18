# What the PayPal sandbox actually answers

Recorded 2026-10-10 against `https://api-m.sandbox.paypal.com` with the sandbox
"Default Application". Ids, e-mail addresses, names and times are replaced;
everything else is as received. `npm run test:sandbox` re-checks the parts
marked **seen** on every run.

Status of each part:

| Part | Status |
|---|---|
| Token, create order, get order, request-id replay | **seen** |
| Errors before approval (amounts, capture too early, unknown ids, card not enabled) | **seen** |
| verify-webhook-signature with an unknown delivery | **seen** |
| Webhook event bodies | from PayPal's simulator (`POST /v1/notifications/simulate-event`), not from a real payment |
| Capture response, double capture, refunds and refund errors | **not seen yet**: needs one order approved by a person. `npm run sandbox:settle` records them into `docs/sandbox-recorded/` |

## Token

`POST /v1/oauth2/token`, Basic auth, body `grant_type=client_credentials` → 200.
The client reads `access_token` and `expires_in` and nothing else.
Bad credentials answer 401 with `{ "error": "invalid_client", "error_description": "..." }`,
not the usual error body.

## Create order

`POST /v2/checkout/orders` with `PayPal-Request-Id` and `Prefer: return=representation`.
Request body as in `docs/PAYPAL_MOCK.md`. Answer: **HTTP 200** (not 201) when
`payment_source.paypal` is given.

```json
{
  "id": "<ID>",
  "intent": "CAPTURE",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": { "paypal": {} },
  "purchase_units": [
    {
      "reference_id": "BK-XXXXXX",
      "amount": { "currency_code": "USD", "value": "24.00" },
      "payee": {
        "email_address": "<EMAIL>",
        "merchant_id": "<MERCHANT_ID>",
        "display_data": { "brand_name": "Dalhang Pottery Studio" }
      },
      "description": "Wheel throwing class (deposit)",
      "custom_id": "BK-XXXXXX"
    }
  ],
  "links": [
    { "href": "https://api.sandbox.paypal.com/v2/checkout/orders/<ID>", "rel": "self", "method": "GET" },
    { "href": "https://www.sandbox.paypal.com/checkoutnow?token=<ID>", "rel": "payer-action", "method": "GET" }
  ]
}
```

Things that differ from what the first mock assumed:

- No `create_time` in this answer. `GET /v2/checkout/orders/{id}` has it.
- `payment_source` comes back as `{ "paypal": {} }`; the experience context is not echoed.
- `payee` is added, and `brand_name` moves to `payee.display_data`.
- Link hosts are `api.sandbox.paypal.com`, not `api-m.sandbox.paypal.com`.
- Order ids are 17 upper-case letters and digits.

**Request-id replay.** The same `PayPal-Request-Id` returns the first order
again, status 200, even when the second body asks for a different amount. PayPal
does not complain about the mismatch. So a request id must never be reused for a
logically different request; the desk uses the booking id for orders and
`refund-<booking>-<already refunded>-<amount>` for refunds.

## Errors

Common shape (422 and 404):

```json
{
  "name": "UNPROCESSABLE_ENTITY",
  "details": [
    {
      "field": "/purchase_units/@reference_id=='BK-XXXXXX'/amount/value",
      "value": "0.00",
      "issue": "CANNOT_BE_ZERO_OR_NEGATIVE",
      "description": "Must be greater than zero. If the currency supports decimals, only two decimal place precision is supported."
    }
  ],
  "message": "The requested action could not be performed, semantically incorrect, or failed business validation.",
  "debug_id": "<DEBUG_ID>",
  "links": [
    { "href": "https://developer.paypal.com/api/rest/reference/orders/v2/errors/#CANNOT_BE_ZERO_OR_NEGATIVE", "rel": "information_link", "method": "GET" }
  ]
}
```

`field`, `value` and `location` appear only when the error is about one input.
Every answer also carries a `Paypal-Debug-Id` header; the client logs it.

| Situation | HTTP | `name` | `details[0].issue` |
|---|---|---|---|
| Amount `0.00` or `-5.00` | 422 | `UNPROCESSABLE_ENTITY` | `CANNOT_BE_ZERO_OR_NEGATIVE` |
| Amount `12.345` | 422 | `UNPROCESSABLE_ENTITY` | `DECIMAL_PRECISION` |
| Amount `abc` | 400 | `INVALID_REQUEST` | `INVALID_PARAMETER_SYNTAX` (with `location: "body"`) |
| `1000.50` in a currency without decimals (KRW, JPY) | 422 | `UNPROCESSABLE_ENTITY` | `DECIMALS_NOT_SUPPORTED` |
| Capture before the payer approved | 422 | `UNPROCESSABLE_ENTITY` | `ORDER_NOT_APPROVED` |
| Get or capture an unknown order | 404 | `RESOURCE_NOT_FOUND` | `INVALID_RESOURCE_ID` (capture adds `field: "order_id", location: "path"`) |
| Refund an unknown capture | 404 | `RESOURCE_NOT_FOUND` | `INVALID_RESOURCE_ID` (`field: "capture_id", location: "path"`) |
| Order with `payment_source.card` on this account | 422 | `UNPROCESSABLE_ENTITY` | `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` |

The 400 answer puts `message` and `debug_id` before `details` and its link has
`encType` instead of `method`; nothing in the app depends on that.

Not triggered yet (they need a captured payment). The names below are from the
API reference and from memory, and the code does not depend on them: after a
refused capture the desk looks the order up and goes by its status.

| Situation | Expected |
|---|---|
| Capture twice | 422 `ORDER_ALREADY_CAPTURED` |
| Refund more than is left | 422 `REFUND_AMOUNT_EXCEEDED` |
| Refund a fully refunded capture | 422 `CAPTURE_FULLY_REFUNDED` |
| Refund in another currency | 422 `CURRENCY_MISMATCH` |

## Paying without a person at the approval page

Tried: an order with `payment_source.card` and one of PayPal's published sandbox
test cards (https://developer.paypal.com/tools/sandbox/card-testing/). On an
account with card processing this completes the payment in the create call.
This sandbox account answers `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`, so **there
is no non-interactive capture path with the current app**. Vaulted payment
tokens would also work without a login, but the first payment that creates the
token needs the same approval page. PayPal's negative-testing header
(`PayPal-Mock-Response`) only forces error answers; it cannot approve an order.

The live suite keeps trying the card path: if card processing is enabled later
(Sandbox Accounts → the Business account → enable "Advanced Credit and Debit
Card Payments", available for US business test accounts), it runs capture,
double capture and the refund cases on its own.

## Webhooks

`POST /v1/notifications/verify-webhook-signature` with made-up transmission
headers and a made-up webhook id answers 200 `{ "verification_status": "FAILURE" }`.
A real, matching delivery answers `"SUCCESS"`.

Event bodies below are what `POST /v1/notifications/simulate-event` returns for
`resource_version: "2.0"`; full copies are in `tests/fixtures/simulator/`.
They are PayPal's samples, so `custom_id` is missing from the capture and the
amounts are arbitrary.

Envelope: `id`, `create_time`, `resource_type`, `event_type`, `summary`,
`resource`, `links` (`self` and `resend`), `event_version: "1.0"`, `resource_version: "2.0"`.

| Event | `resource_type` | Fields the desk reads | Other fields present |
|---|---|---|---|
| `CHECKOUT.ORDER.APPROVED` | `checkout-order` | `resource.id` | `status: "APPROVED"`, `intent`, `payer{name,email_address,payer_id}`, `purchase_units[]`, `links[self, capture]` |
| `PAYMENT.CAPTURE.COMPLETED` | `capture` | `resource.id`, `resource.supplementary_data.related_ids.order_id`, `resource.custom_id` (real events) | `status: "COMPLETED"`, `amount`, `final_capture`, `seller_protection`, `seller_receivable_breakdown{gross_amount,paypal_fee,net_amount}`, `links[self, refund, up]` |
| `PAYMENT.CAPTURE.REFUNDED` | `refund` | `resource.id`, `resource.amount`, the `up` link (ends in the capture id) | `status: "COMPLETED"`, `seller_payable_breakdown{gross_amount,paypal_fee,net_amount,total_refunded_amount}`, `links[self, up]` |

Signature, from PayPal's documentation: RSA-SHA256 over
`<transmission id>|<transmission time>|<webhook id>|<CRC32 of the raw body, decimal>`,
certificate at the URL in `paypal-cert-url` (host `api.sandbox.paypal.com`,
path `/v1/notifications/certs/...`). Simulator events are signed for the fixed
webhook id `WEBHOOK_ID` and cannot be checked with the verify endpoint.

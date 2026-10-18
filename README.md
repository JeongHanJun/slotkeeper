# Slotkeeper

A booking desk agent for small studios that take visitors from abroad.

Guests write in by email or DM, in their own language, at any hour. Slotkeeper
reads each message, checks the calendar, holds a slot, takes the deposit through
PayPal, and gives the slot away again if the deposit never arrives. The owner
only sees the cases that need a decision.

**Status: running on the PayPal sandbox at https://slotkeeper.hanjunjung.workers.dev**
(the owner's desk asks for a passcode; the guest pages are open). It runs two ways: on a built-in PayPal mock (no
accounts needed), or against the real PayPal sandbox. Order, approval, capture,
partial and full refund and the error cases have all been run against the
sandbox (`docs/SANDBOX_SHAPES.md`, `docs/sandbox-recorded/`). The schedule is a
Bryntum Scheduler; the owner can drag a booking to another time and the agent
re-checks the rules and rewrites the guest's reply.

## Run it on the mock

Needs Node 20 or newer. No accounts or API keys.

```
npm install
npm run start:mock
```

Open http://127.0.0.1:8794. (`npm start` does the same when there is no
`.dev.vars` file.)

1. Press **Run agent on new**. Four sample messages are handled four different
   ways: one slot is held and a pay link drafted, one guest is offered other
   times (owner picks), one is asked for missing details, one waits for approval
   because the deposit is over the agent's limit.
2. Open a pay link from the bookings table and press **Pay now** on the mock
   checkout page. The striped hold on the board turns into a confirmed booking.
3. Press **+31 min** to let an unpaid hold run out. The slot is released and
   offered to anyone on the waitlist for it.
4. Add the sample "Maya: cancellation". The agent works out the refund from the
   house rules and refunds the deposit.
5. Drag a booking on the schedule to another time. The desk checks opening
   hours, notice and clashes, moves it, and rewrites the draft reply for the new
   time. The PayPal order is untouched: same amount, same link.

`npm start` first copies the Bryntum Scheduler trial bundle from `node_modules`
into `public/vendor/` (`npm run vendor`). Without it the page falls back to a
plain board.

**Reset demo** starts over.

## Run it on the PayPal sandbox

1. Copy `.dev.vars.example` to `.dev.vars` and fill in a sandbox app's client id
   and secret (developer.paypal.com → Apps & Credentials → Sandbox).
2. `npm start`, open http://127.0.0.1:8794. The badge reads "PayPal: sandbox".
3. Run the agent. The pay link in the bookings table now goes to
   `https://www.sandbox.paypal.com/checkoutnow?token=...`. Open it, sign in with
   the sandbox **Personal** test account and complete the purchase.
4. PayPal sends the browser back to `/api/return`, which captures the deposit
   and confirms the booking. If the tab is closed before that, the desk finds
   the approved order on its own within half a minute.
5. Add the sample cancellation to refund it.

Only `api-m.sandbox.paypal.com` is accepted. With any other mode or host the
app stops with an error instead of starting.

To check the PayPal side without the desk:

```
npm run sandbox:order              # prints an approval link and an order id
npm run sandbox:settle -- <id>     # after approving: capture, refunds, error cases
```

## Tests

```
npm test              # 89 tests, mock only, no network
npm run test:sandbox  # 10 tests against the real sandbox; skipped without sandbox keys
npm run typecheck
```

`tests/contract.ts` is run by both suites, against the mock and against the
sandbox, so the mock stays in step with what PayPal really answers.

## How it is put together

```
src/agent.ts           decisions: hold, ask the owner, capture, release, refund, reconcile
src/schedule.ts        free/busy and nearest alternatives
src/policy.ts          deposit and refund rules
src/paypal/client.ts   the interface the agent talks to
src/paypal/live.ts     PayPal over REST: token cache, retries, request ids, logs
src/paypal/webhook.ts  webhook signature check (CRC32 + RSA certificate)
src/paypal/config.ts   mock or sandbox, and nothing else
src/paypal/mock.ts     stand-in for the sandbox (default)
src/llm/stub.ts        rule-based message reader and reply templates (default)
src/llm/model.ts       prompts, range checks and fall-backs shared by the real models
src/llm/workersai.ts   Workers AI through the AI binding, with a daily spend cap
src/llm/openai.ts      any OpenAI-compatible endpoint
src/app.ts             HTTP routes, sign-in, rate limits, input checks
src/state.ts           one storage key per booking/inquiry, revision-checked writes
src/desk.ts            Durable Object: one writer per desk, alarm for expiry and polling
public/                owner's desk and the guest's page, no build step
public/vendor/         Bryntum Scheduler trial bundle, copied by scripts/vendor.mjs (not committed)
```

The language model reads messages and words replies. It never decides anything
about the calendar or money: slots, amounts and refunds come from code and the
limits in `venue.policy`, and a reply that drops or changes a pay link or an
amount is replaced by the template.

### PayPal

Calls: `POST /v1/oauth2/token`, `POST /v2/checkout/orders`,
`GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture`,
`POST /v2/payments/captures/{id}/refund`,
`POST /v1/notifications/verify-webhook-signature`; webhooks
`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`.

- Every write carries a `PayPal-Request-Id`, so a retry after a timeout cannot
  create a second order, capture or refund. 5xx and 429 answers are retried
  with backoff.
- A deposit is captured from whichever arrives first: the payer's return, the
  approval webhook, or the desk's own polling. The others find it done.
- Webhooks are optional. Without a registered webhook the desk rejects every
  delivery and relies on the return URL and polling.
- Each PayPal call is logged as one JSON line (method, path without ids,
  status, time, PayPal debug id). No keys, tokens or bodies.

### Limits the agent cannot cross

Enforced in `src/agent.ts`, not in the page: deposits above
`autoHoldLimitCents` and refunds above `autoRefundLimitCents` wait for the
owner; no order is created above `maxDepositCents` whoever approves; a refund
never exceeds what is left of the deposit; a payment that arrives after the
slot went to someone else is not captured.

### State

One Durable Object per desk. Requests that change state run one at a time
inside it, and each step writes its changes in a single transaction, so a
webhook, a return and a hold expiry for the same booking cannot interleave.
(KV was not enough: no compare-and-set, and reads can be stale.)

## Putting it on a public address

The demo above runs on Cloudflare Workers with `PAYPAL_MODE=sandbox` and
`LLM_MODE=workers-ai` (`npm run deploy`). For your own copy:

- `DESK_PASSCODE` must be set (`wrangler secret put DESK_PASSCODE`). Without it
  the desk answers 503 anywhere but localhost. Sign-in attempts are limited to
  five a minute.
- Register the webhook `https://<address>/api/webhooks/paypal` for the three
  events above and store its id as `PAYPAL_WEBHOOK_ID`.
  `node scripts/sandbox-webhook.mjs` does this through the REST API and writes
  the id to `.dev.vars`; then `wrangler secret put PAYPAL_WEBHOOK_ID`.
- To try deliveries from the dashboard's Webhooks simulator first, set
  `PAYPAL_WEBHOOK_SIMULATOR=on` for the test and remove it afterwards: simulator
  events are signed for a fixed id that anyone can use.

## Using a real model

Two ways, both optional; the rule-based reader is the default.

- **Workers AI**: set `LLM_MODE=workers-ai` (`wrangler.jsonc` or
  `--var LLM_MODE:workers-ai`). The Worker's `AI` binding runs `LLM_MODEL`
  (default Llama 3.3 70B). Spend is counted in Workers AI neurons and capped per
  day by `DAILY_NEURON_BUDGET`; past the cap, or when the model fails, the desk
  reads with the rules and answers with the templates. The owner's page shows
  today's count next to the reader name. `wrangler dev` uses the real service.
- **OpenAI-compatible endpoint**: `LLM_MODE=openai` with `LLM_BASE_URL`,
  `LLM_API_KEY` and `LLM_MODEL` in `.dev.vars`.

Either way the model only reads messages and words replies. Its reading is
range-checked against the venue (`src/llm/model.ts`), the email always comes
from the rules, and a reply that drops a pay link, amount or time is replaced
by the template. `docs/READER_COMPARISON.md` scores the model and the rules on
20 messages in three languages (`node scripts/compare-readers.mjs` against a
running desk).

## Limits of the prototype

- Replies are drafted, not sent.
- One owner, one venue, one desk shared by everyone who has the passcode.
- The webhook is registered for the public address, but a delivery has not
  been watched end to end yet; the return URL and polling cover the same
  ground.
- The schedule component is the Bryntum trial build (45 days from first load in
  a browser); a licence is needed to ship it.
- Do not put real guest data in it.

## License

MIT

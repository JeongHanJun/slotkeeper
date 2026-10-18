// Takes an order that was approved in the sandbox checkout page through the
// rest of its life: capture, a second capture (must be refused), a partial
// refund, a refund that is too large (must be refused), a refund of the rest,
// and one more refund (must be refused).
//
//   npm run sandbox:settle -- <order id>
//
// Prints statuses and issue names with ids shortened. The full answers, with
// ids, e-mails and names replaced, are written to docs/sandbox-recorded/ so the
// mock can be compared with them.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, redact, sandboxClient, shortRef } from "./lib.mjs";

const orderId = process.argv[2] ?? "";
if (!/^[A-Z0-9]{10,30}$/.test(orderId)) {
  console.error("Usage: npm run sandbox:settle -- <order id printed by sandbox:order>");
  process.exit(1);
}

const outDir = path.join(ROOT, "docs", "sandbox-recorded");
mkdirSync(outDir, { recursive: true });
const record = (name, value) =>
  writeFileSync(path.join(outDir, name + ".json"), JSON.stringify(redact(value), null, 2) + "\n");

const paypal = await sandboxClient();
const id = () => "script-" + crypto.randomUUID();
let failed = false;

function line(step, result) {
  console.log(step.padEnd(34) + result);
}

// Run a call that must be refused and note what PayPal called the refusal.
async function expectRefusal(step, file, call) {
  try {
    const value = await call();
    record(file, value);
    line(step, "NOT REFUSED (status " + (value?.status ?? "?") + ")");
    failed = true;
  } catch (err) {
    record(file, { status: err.status, body: err.body });
    line(step, `refused: ${err.status} ${err.body?.details?.[0]?.issue ?? err.body?.name}`);
  }
}

try {
  let order = await paypal.getOrder(orderId);
  record("order-before-capture", order);
  line("order " + shortRef(orderId), order.status);

  if (order.status === "PAYER_ACTION_REQUIRED" || order.status === "CREATED") {
    console.error("\nThe order has not been approved yet. Open the approve link, sign in with the");
    console.error("sandbox Personal test account, press Complete Purchase, then run this again.");
    process.exit(2);
  }

  if (order.status === "APPROVED") {
    order = await paypal.captureOrder(orderId, "script-capture-" + orderId);
    record("capture-order", order);
  }
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error("order is " + order.status + " and has no capture");
  line("capture " + shortRef(capture.id), `${capture.status} ${capture.amount.value} ${capture.amount.currency_code}`);

  await expectRefusal("capture again", "error-capture-twice", () => paypal.captureOrder(orderId, id()));

  const currency = capture.amount.currency_code;
  const total = Math.round(Number(capture.amount.value) * 100);
  const money = (cents) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });
  const before = await paypal.getCapture(capture.id);
  record("capture-before-refund", before);

  if (before.status === "COMPLETED") {
    const half = Math.floor(total / 2);
    await expectRefusal("refund more than captured", "error-refund-too-much", () =>
      paypal.refundCapture(capture.id, { amount: money(total + 500) }, id()),
    );
    const partial = await paypal.refundCapture(
      capture.id,
      { amount: money(half), note_to_payer: "Cancelled booking (sandbox test)" },
      "script-refund-half-" + capture.id,
    );
    record("refund-partial", partial);
    line("partial refund " + shortRef(partial.id), `${partial.status} ${partial.amount?.value ?? ""}`);
    record("capture-after-partial-refund", await paypal.getCapture(capture.id));

    await expectRefusal("refund more than is left", "error-refund-over-remaining", () =>
      paypal.refundCapture(capture.id, { amount: money(total - half + 100) }, id()),
    );
    const rest = await paypal.refundCapture(capture.id, {}, "script-refund-rest-" + capture.id);
    record("refund-rest", rest);
    line("refund of the rest " + shortRef(rest.id), `${rest.status} ${rest.amount?.value ?? ""}`);
  } else {
    line("refunds", "skipped, capture is already " + before.status);
  }

  await expectRefusal("refund when nothing is left", "error-refund-nothing-left", () =>
    paypal.refundCapture(capture.id, { amount: money(100) }, id()),
  );
  const after = await paypal.getCapture(capture.id);
  record("capture-after-full-refund", after);
  line("capture at the end", after.status);
  record("order-at-the-end", await paypal.getOrder(orderId));

  console.log("\nRecorded (redacted) answers: docs/sandbox-recorded/");
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error("Stopped: " + (err?.message ?? err));
  process.exit(1);
}

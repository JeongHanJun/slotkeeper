// Creates one sandbox order and prints where to approve it. Nothing else is
// printed: no keys, no tokens, no account details.
//
//   npm run sandbox:order            deposit of 24.00 USD
//   npm run sandbox:order -- 72.00   another amount
//
// Open the link, sign in with the sandbox *Personal* test account and press
// "Complete Purchase". Then run:  npm run sandbox:settle -- <order id>

import { sandboxClient } from "./lib.mjs";

const amount = process.argv[2] ?? "24.00";
if (!/^\d{1,4}\.\d{2}$/.test(amount)) {
  console.error("Amount must look like 24.00");
  process.exit(1);
}

const local = "http://127.0.0.1:8794";
const ref = "BK-" + crypto.randomUUID().slice(0, 6).toUpperCase();

try {
  const paypal = await sandboxClient();
  const order = await paypal.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: ref,
          custom_id: ref,
          description: "Wheel throwing class (deposit, sandbox test)",
          amount: { currency_code: "USD", value: amount },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Dalhang Pottery Studio",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${local}/approved.html`,
            cancel_url: `${local}/thanks.html?cancelled=1`,
          },
        },
      },
    },
    "script-order-" + crypto.randomUUID(),
  );
  const link = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  console.log("approve:  " + link.href);
  console.log("order id: " + order.id);
} catch (err) {
  console.error("Could not create the order: " + (err?.message ?? err));
  process.exit(1);
}

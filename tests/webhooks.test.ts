import { describe, expect, it } from "vitest";
import { LivePayPal, SANDBOX_API } from "../src/paypal/live";
import type { WebhookEvent } from "../src/paypal/types";
import {
  crc32,
  signedMessage,
  spkiFromCertificate,
  trustedCertUrl,
  verifyWithKey,
  type Transmission,
} from "../src/paypal/webhook";
import sandboxCert from "./fixtures/paypal-sandbox-cert.pem?raw";
import approvedSample from "./fixtures/simulator/CHECKOUT.ORDER.APPROVED.json";
import completedSample from "./fixtures/simulator/PAYMENT.CAPTURE.COMPLETED.json";
import refundedSample from "./fixtures/simulator/PAYMENT.CAPTURE.REFUNDED.json";
import { makeDesk } from "./helpers";

const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270";
const BODY = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP" } });

async function signer() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  async function transmission(webhookId: string, body: string): Promise<Transmission> {
    const t = { id: "tx-1", time: "2026-10-10T03:00:00Z", sig: "", algo: "SHA256withRSA", certUrl: CERT_URL };
    const mac = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signedMessage(t, webhookId, body)),
    );
    t.sig = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return t;
  }
  return { key: pair.publicKey, transmission };
}

describe("webhook signature", () => {
  it("computes CRC-32 the standard way", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(signedMessage({ id: "a", time: "b", sig: "", algo: "", certUrl: "" }, "WH", "123456789")).toBe(
      "a|b|WH|3421780262",
    );
  });

  it("accepts a correctly signed delivery and nothing else", async () => {
    const { key, transmission } = await signer();
    const t = await transmission("WH-ID", BODY);
    expect(await verifyWithKey(key, t, "WH-ID", BODY)).toBe(true);
    expect(await verifyWithKey(key, t, "WH-ID", BODY.replace("CAP", "CAQ"))).toBe(false);
    expect(await verifyWithKey(key, t, "OTHER-ID", BODY)).toBe(false);
    expect(await verifyWithKey(key, { ...t, time: "2026-10-10T03:00:01Z" }, "WH-ID", BODY)).toBe(false);
    expect(await verifyWithKey(key, { ...t, algo: "none" }, "WH-ID", BODY)).toBe(false);
    expect(await verifyWithKey(key, { ...t, sig: "not base64!" }, "WH-ID", BODY)).toBe(false);
  });

  it("reads the public key out of a real PayPal sandbox certificate", async () => {
    const spki = spkiFromCertificate(sandboxCert);
    const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    expect(key.type).toBe("public");
    expect(() => spkiFromCertificate("not a certificate")).toThrow();
  });

  it("only trusts certificates served by PayPal", () => {
    expect(trustedCertUrl(CERT_URL, true)).toBe(true);
    expect(trustedCertUrl(CERT_URL, false)).toBe(false);
    expect(trustedCertUrl("https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/x", true)).toBe(false);
    expect(trustedCertUrl("http://api.sandbox.paypal.com/v1/notifications/certs/x", true)).toBe(false);
    expect(trustedCertUrl("https://api.sandbox.paypal.com/other", true)).toBe(false);
    expect(trustedCertUrl("mock://cert", true)).toBe(false);
  });
});

describe("live client webhook check", () => {
  const headers = new Headers({
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-10-10T03:00:00Z",
    "paypal-transmission-sig": "bm90IGEgc2lnbmF0dXJl",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": CERT_URL,
  });

  function client(webhookId: string | undefined, verdict: string) {
    const posted: string[] = [];
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === CERT_URL) return new Response(sandboxCert);
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      posted.push(String(init?.body));
      return Response.json({ verification_status: verdict });
    }) as typeof fetch;
    const paypal = new LivePayPal({ apiBase: SANDBOX_API, clientId: "i", clientSecret: "s", webhookId, fetch: http, log: () => {} });
    return { paypal, posted };
  }

  it("rejects everything while no webhook id is set", async () => {
    const { paypal, posted } = client(undefined, "SUCCESS");
    expect(paypal.webhooksConfigured).toBe(false);
    expect(await paypal.verifyWebhook(headers, BODY)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("falls back to PayPal's own check and passes the body through untouched", async () => {
    const spaced = '{ "id": "WH-1",  "event_type":"X", "resource": {"amount": 1.50} }';
    const { paypal, posted } = client("WH-ID", "SUCCESS");
    expect(await paypal.verifyWebhook(headers, spaced)).toBe(true);
    expect(posted[0]).toContain(`"webhook_id":"WH-ID","webhook_event":${spaced}}`);
  });

  it("rejects when PayPal says the signature is wrong", async () => {
    expect(await client("WH-ID", "FAILURE").paypal.verifyWebhook(headers, BODY)).toBe(false);
  });

  it("does not fetch a certificate from anywhere but PayPal", async () => {
    const forged = new Headers(headers);
    forged.set("paypal-cert-url", "https://evil.test/cert.pem");
    const { paypal, posted } = client("WH-ID", "SUCCESS");
    expect(await paypal.verifyWebhook(forged, BODY)).toBe(false);
    expect(posted).toHaveLength(0);
  });
});

// Payloads returned by PayPal's webhook simulator (ids redacted), delivered to
// the desk with the ids of a booking made in the test.
describe("simulator payloads", () => {
  const clone = <T>(sample: T) => structuredClone(sample) as unknown as WebhookEvent<Record<string, any>>;

  async function send(desk: ReturnType<typeof makeDesk>, event: WebhookEvent) {
    const delivery = await desk.paypal.deliveryFor(event);
    return desk.call("POST", "/api/webhooks/paypal", delivery.body, delivery.headers);
  }

  it("captures when CHECKOUT.ORDER.APPROVED arrives", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);
    await desk.paypal.approve(held.orderId!, "buyer@example.com");
    await desk.paypal.takeOutbox();

    const event = clone(approvedSample);
    event.id = "WH-SIM-APPROVED";
    event.resource.id = held.orderId;
    expect((await send(desk, event)).status).toBe(200);
    expect((await desk.bookingOf(inq)).status).toBe("confirmed");
  });

  it("confirms from PAYMENT.CAPTURE.COMPLETED by order id", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    const held = await desk.bookingOf(inq);

    const event = clone(completedSample);
    event.id = "WH-SIM-COMPLETED";
    event.resource.id = "CAPTURE00000000001";
    event.resource.supplementary_data.related_ids.order_id = held.orderId;
    expect((await send(desk, event)).status).toBe(200);

    const booking = await desk.bookingOf(inq);
    expect(booking.status).toBe("confirmed");
    expect(booking.captureId).toBe("CAPTURE00000000001");
  });

  it("records a refund made outside the desk from PAYMENT.CAPTURE.REFUNDED", async () => {
    const desk = makeDesk();
    const inq = await desk.run("Maya");
    await desk.pay(await desk.bookingOf(inq));
    const paid = await desk.bookingOf(inq);

    const event = clone(refundedSample);
    event.id = "WH-SIM-REFUNDED";
    event.resource.id = "REFUND000000000001";
    for (const link of event.resource.links) {
      if (link.rel === "up") link.href = `https://api.sandbox.paypal.com/v2/payments/captures/${paid.captureId}`;
    }
    expect((await send(desk, event)).status).toBe(200);
    expect((await desk.bookingOf(inq)).refundedCents).toBe(99);

    // PayPal retries deliveries; the same event must not count twice.
    await send(desk, event);
    expect((await desk.bookingOf(inq)).refundedCents).toBe(99);
  });

  it("ignores events about payments it does not know", async () => {
    const desk = makeDesk();
    const before = JSON.stringify((await desk.state()).bookings);
    for (const sample of [approvedSample, completedSample, refundedSample]) {
      const event = clone(sample);
      event.id = "WH-SIM-" + event.event_type;
      expect((await send(desk, event)).status).toBe(200);
    }
    expect(JSON.stringify((await desk.state()).bookings)).toBe(before);
  });
});

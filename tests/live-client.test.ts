import { describe, expect, it } from "vitest";
import { PayPalError } from "../src/paypal/client";
import { resolvePayPal } from "../src/paypal/config";
import { LivePayPal, SANDBOX_API, type CallLog } from "../src/paypal/live";

// The real client against a scripted fetch: no network, no credentials.

const SECRET = "s3cret-value";
const TOKEN = "A21AAtoken";

type Step = (url: string, init: RequestInit) => Response;

function scripted(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: CallLog[] = [];
  const sleeps: number[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected call to ${url}`);
    return step(url, init ?? {});
  }) as typeof fetch;
  const client = new LivePayPal({
    apiBase: SANDBOX_API,
    clientId: "client-id",
    clientSecret: SECRET,
    fetch: http,
    sleep: async (ms) => void sleeps.push(ms),
    log: (entry) => logs.push(entry),
  });
  return { client, calls, logs, sleeps };
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "paypal-debug-id": "dbg123", ...headers } });
const token = reply(200, { access_token: TOKEN, expires_in: 32400 });
const order = { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED" };
const problem = (name: string, issue: string) => ({ name, message: "m", debug_id: "dbg123", details: [{ issue }] });

describe("live client", () => {
  it("fetches one token and reuses it", async () => {
    const { client, calls } = scripted([token, reply(200, order), reply(200, order)]);
    await client.getOrder(order.id);
    await client.getOrder(order.id);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/oauth2/token",
      `/v2/checkout/orders/${order.id}`,
      `/v2/checkout/orders/${order.id}`,
    ]);
    const auth = (calls[0]!.init.headers as Record<string, string>).authorization;
    expect(auth).toBe("Basic " + btoa(`client-id:${SECRET}`));
  });

  it("shares one token request between concurrent calls", async () => {
    const { client, calls } = scripted([token, reply(200, order), reply(200, order)]);
    await Promise.all([client.getOrder(order.id), client.getOrder(order.id)]);
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("sends the request id and asks for the full representation", async () => {
    const { client, calls } = scripted([token, reply(201, order)]);
    await client.captureOrder(order.id, "capture-BK-1");
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers["paypal-request-id"]).toBe("capture-BK-1");
    expect(headers.prefer).toBe("return=representation");
    expect(headers.authorization).toBe("Bearer " + TOKEN);
  });

  it("retries 5xx and 429 with the same request id, then succeeds", async () => {
    const { client, calls, sleeps } = scripted([
      token,
      reply(503, problem("SERVICE_UNAVAILABLE", "X")),
      reply(429, problem("RATE_LIMIT_REACHED", "X"), { "retry-after": "2" }),
      reply(201, order),
    ]);
    expect((await client.captureOrder(order.id, "capture-BK-1")).id).toBe(order.id);
    const ids = calls.slice(1).map((c) => (c.init.headers as Record<string, string>)["paypal-request-id"]);
    expect(ids).toEqual(["capture-BK-1", "capture-BK-1", "capture-BK-1"]);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBe(2000);
  });

  it("gives up after four attempts", async () => {
    const down = reply(500, problem("INTERNAL_SERVER_ERROR", "X"));
    const { client, calls } = scripted([token, down, down, down, down]);
    await expect(client.getOrder(order.id)).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(5);
  });

  it("does not retry a business refusal", async () => {
    const { client, calls } = scripted([token, reply(422, problem("UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED"))]);
    const err = await client.captureOrder(order.id, "c-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).issue).toBe("ORDER_NOT_APPROVED");
    expect((err as PayPalError).body.debug_id).toBe("dbg123");
    expect(calls).toHaveLength(2);
  });

  it("retries a dropped connection", async () => {
    const { client } = scripted([
      token,
      () => {
        throw new TypeError("fetch failed");
      },
      reply(200, order),
    ]);
    expect((await client.getOrder(order.id)).id).toBe(order.id);
  });

  it("gets a new token once when the old one is refused", async () => {
    const { client, calls } = scripted([token, reply(401, { error: "invalid_token" }), token, reply(200, order)]);
    expect((await client.getOrder(order.id)).id).toBe(order.id);
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("reports bad credentials in the token endpoint's own format", async () => {
    const { client } = scripted([reply(401, { error: "invalid_client", error_description: "Client Authentication failed" })]);
    await expect(client.getOrder(order.id)).rejects.toMatchObject({ status: 401, body: { name: "invalid_client" } });
  });

  it("logs each call without secrets, tokens or resource ids", async () => {
    const { client, logs } = scripted([token, reply(422, problem("UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED"))]);
    await client.captureOrder(order.id, "c-1").catch(() => undefined);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({
      src: "paypal",
      method: "POST",
      path: "/v2/checkout/orders/{id}/capture",
      status: 422,
      attempt: 1,
      issue: "ORDER_NOT_APPROVED",
      debugId: "dbg123",
    });
    const text = JSON.stringify(logs);
    for (const hidden of [SECRET, TOKEN, order.id, "client-id"]) expect(text).not.toContain(hidden);
  });
});

describe("choosing the PayPal environment", () => {
  const keys = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: SECRET };

  it("defaults to the mock", () => {
    expect(resolvePayPal({})).toEqual({ mode: "mock" });
    expect(resolvePayPal({ PAYPAL_MODE: "mock", ...keys })).toEqual({ mode: "mock" });
  });

  it("uses the sandbox host in sandbox mode", () => {
    const choice = resolvePayPal({ PAYPAL_MODE: "sandbox", ...keys });
    expect(choice).toMatchObject({ mode: "sandbox", config: { apiBase: SANDBOX_API, allowLive: false } });
  });

  it("refuses any other mode or host", () => {
    expect(() => resolvePayPal({ PAYPAL_MODE: "live", ...keys })).toThrow(/must be "mock" or "sandbox"/);
    expect(() => resolvePayPal({ PAYPAL_MODE: "production", ...keys })).toThrow();
    expect(() =>
      resolvePayPal({ PAYPAL_MODE: "sandbox", PAYPAL_API_BASE: "https://api-m.paypal.com", ...keys }),
    ).toThrow(/api-m\.sandbox\.paypal\.com/);
    expect(() => resolvePayPal({ PAYPAL_MODE: "sandbox" })).toThrow(/required/);
  });

  it("the client itself refuses a non-sandbox host", () => {
    const make = (apiBase: string) => new LivePayPal({ apiBase, clientId: "id", clientSecret: SECRET });
    expect(() => make("https://api-m.paypal.com")).toThrow();
    expect(() => make("https://api-m.sandbox.paypal.com.evil.test")).toThrow();
    expect(make("https://api-m.sandbox.paypal.com/").mode).toBe("sandbox");
  });
});

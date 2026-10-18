import { PayPalError, type PayPalClient } from "./client";
import type { Capture, CreateOrderRequest, ErrorBody, Order, Refund, RefundRequest } from "./types";
import { readTransmission, trustedCertUrl, verifyWithCertificate, type Transmission } from "./webhook";

// PayPal over REST. Built for the sandbox; see resolvePayPal() in config.ts for
// what it takes to point it anywhere else.

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";
export const LIVE_API = "https://api-m.paypal.com";

export interface CallLog {
  src: "paypal";
  method: string;
  // Path with ids replaced, e.g. /v2/checkout/orders/{id}/capture
  path: string;
  status: number;
  ms: number;
  attempt: number;
  debugId?: string;
  issue?: string;
  error?: string;
}

export interface LiveConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  // Id PayPal gave the registered webhook. Without it no delivery is accepted.
  webhookId?: string;
  // Also accept events from the dashboard's Webhooks simulator, which are
  // signed for the fixed id "WEBHOOK_ID". Testing only: anyone can send those.
  acceptSimulator?: boolean;
  // Must be true for anything other than the sandbox host.
  allowLive?: boolean;
  // Seams for tests.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: CallLog) => void;
  maxAttempts?: number;
  timeoutMs?: number;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class LivePayPal implements PayPalClient {
  readonly mode: "sandbox" | "live";
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private certs = new Map<string, string>();
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (entry: CallLog) => void;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(private cfg: LiveConfig) {
    const base = cfg.apiBase.replace(/\/$/, "");
    if (base === SANDBOX_API) {
      this.mode = "sandbox";
    } else if (base === LIVE_API && cfg.allowLive === true) {
      this.mode = "live";
    } else {
      throw new Error(`PayPal host must be ${SANDBOX_API}`);
    }
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
    }
    this.cfg = { ...cfg, apiBase: base };
    this.http = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = cfg.log ?? ((entry) => console.log(JSON.stringify(entry)));
    this.maxAttempts = cfg.maxAttempts ?? 4;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  get webhooksConfigured(): boolean {
    return Boolean(this.cfg.webhookId) || this.cfg.acceptSimulator === true;
  }

  // ---- interface ----

  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order> {
    return this.call("POST", "/v2/checkout/orders", body, requestId);
  }

  getOrder(orderId: string): Promise<Order> {
    return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string): Promise<Order> {
    return this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
  }

  getCapture(captureId: string): Promise<Capture> {
    return this.call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund> {
    return this.call(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      body,
      requestId,
    );
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
    const t = readTransmission(headers);
    if (!t || !isJsonObject(rawBody)) return false;
    if (!trustedCertUrl(t.certUrl, this.mode === "sandbox")) return false;

    const ids: string[] = [];
    if (this.cfg.webhookId) ids.push(this.cfg.webhookId);
    if (this.cfg.acceptSimulator && this.mode === "sandbox") ids.push("WEBHOOK_ID");
    if (ids.length === 0) return false;

    // First with the certificate, which needs no API call per delivery.
    try {
      const pem = await this.certificate(t.certUrl);
      for (const id of ids) {
        if (await verifyWithCertificate(t, id, rawBody, pem)) return true;
      }
    } catch {
      // Fall through and let PayPal judge.
    }
    // Then ask PayPal. Simulator events cannot be checked this way.
    return this.cfg.webhookId ? this.verifyByPostback(t, rawBody, this.cfg.webhookId) : false;
  }

  private async certificate(url: string): Promise<string> {
    const cached = this.certs.get(url);
    if (cached) return cached;
    const res = await this.http(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error("certificate not available");
    const pem = await res.text();
    if (this.certs.size > 8) this.certs.clear();
    this.certs.set(url, pem);
    return pem;
  }

  private async verifyByPostback(t: Transmission, rawBody: string, webhookId: string): Promise<boolean> {
    const fields = {
      auth_algo: t.algo,
      cert_url: t.certUrl,
      transmission_id: t.id,
      transmission_sig: t.sig,
      transmission_time: t.time,
      webhook_id: webhookId,
    };
    // PayPal checks the signature against the bytes it sent, so the event goes
    // in untouched: splice the raw text in rather than parse and re-serialise.
    const head = JSON.stringify(fields).slice(0, -1);
    try {
      const data = await this.send<{ verification_status?: string }>(
        "POST",
        "/v1/notifications/verify-webhook-signature",
        `${head},"webhook_event":${rawBody}}`,
      );
      return data.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }

  // ---- transport ----

  private call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    return this.send(method, path, body === undefined ? undefined : JSON.stringify(body), requestId);
  }

  // One API call with retries. POSTs carry a PayPal-Request-Id, so sending the
  // same call again after a timeout or a 5xx cannot repeat its effect.
  private async send<T>(method: string, path: string, body?: string, requestId?: string): Promise<T> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const entry: CallLog = { src: "paypal", method, path: template(path), status: 0, ms: 0, attempt };
      let res: Response | undefined;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
          // Ask for the full resource, not just id and links.
          prefer: "return=representation",
        };
        if (requestId) headers["paypal-request-id"] = requestId;
        res = await this.http(this.cfg.apiBase + path, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (err instanceof PayPalError) throw err;
        entry.error = err instanceof Error ? err.name : "network";
      }

      entry.ms = Date.now() - started;
      if (res) {
        entry.status = res.status;
        entry.debugId = res.headers.get("paypal-debug-id") ?? undefined;
      }

      if (res?.ok) {
        this.log(entry);
        return (res.status === 204 ? undefined : await res.json()) as T;
      }

      // A token PayPal no longer accepts: fetch a new one, once.
      if (res?.status === 401 && !refreshed) {
        refreshed = true;
        this.token = undefined;
        this.log(entry);
        continue;
      }

      const retryable = !res || RETRY_STATUS.has(res.status);
      if (!retryable || attempt >= this.maxAttempts) {
        const error = res ? await asError(res) : new PayPalError(0, { name: "NETWORK_ERROR", message: entry.error ?? "request failed" });
        entry.issue = error.issue ?? error.body.name;
        entry.debugId ??= error.body.debug_id;
        this.log(entry);
        throw error;
      }
      this.log(entry);
      await this.sleep(backoff(attempt, res?.headers.get("retry-after")));
    }
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return Promise.resolve(this.token.value);
    // Concurrent callers share one token request.
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const path = "/v1/oauth2/token";
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const entry: CallLog = { src: "paypal", method: "POST", path, status: 0, ms: 0, attempt };
      let res: Response | undefined;
      try {
        res = await this.http(this.cfg.apiBase + path, {
          method: "POST",
          headers: {
            authorization: "Basic " + btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        entry.error = err instanceof Error ? err.name : "network";
      }
      entry.ms = Date.now() - started;
      entry.status = res?.status ?? 0;

      if (res?.ok) {
        this.log(entry);
        const data = (await res.json()) as { access_token: string; expires_in: number };
        this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        return data.access_token;
      }
      const retryable = !res || RETRY_STATUS.has(res.status);
      if (!retryable || attempt >= this.maxAttempts) {
        const error = res ? await asError(res) : new PayPalError(0, { name: "NETWORK_ERROR", message: entry.error ?? "request failed" });
        entry.issue = error.body.name;
        this.log(entry);
        throw error;
      }
      this.log(entry);
      await this.sleep(backoff(attempt, res?.headers.get("retry-after")));
    }
  }
}

// 0.3s, 0.6s, 1.2s plus jitter; a Retry-After header wins, up to 5s.
function backoff(attempt: number, retryAfter?: string | null): number {
  const asked = Number(retryAfter);
  if (retryAfter && Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, 5000);
  return 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
}

// Keep resource ids out of the logs.
function template(path: string): string {
  return path
    .split("/")
    .map((part) => (/^[A-Z0-9-]{10,}$/.test(decodeURIComponent(part)) ? "{id}" : part))
    .join("/");
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

async function asError(res: Response): Promise<PayPalError> {
  let body: ErrorBody;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = { name: "HTTP_" + res.status, message: res.statusText };
  }
  // The token endpoint answers with { error, error_description } instead.
  const alt = body as unknown as { error?: string; error_description?: string };
  if (!body.name && alt.error) {
    body = { name: alt.error, message: alt.error_description ?? "" };
  }
  if (!body.name) body = { ...body, name: "HTTP_" + res.status, message: body.message ?? "" };
  body.debug_id ??= res.headers.get("paypal-debug-id") ?? undefined;
  return new PayPalError(res.status, body);
}

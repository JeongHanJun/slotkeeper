import { createApp } from "../src/app";
import { StubLlm } from "../src/llm/stub";
import type { PayPalClient } from "../src/paypal/client";
import { MockPayPal } from "../src/paypal/mock";
import { sampleMessages } from "../src/seed";
import { MemoryStore } from "../src/store";
import type { AppState, Booking, Inquiry } from "../src/types";

// Saturday 10 Oct 2026, 12:00 in Seoul.
export const NOW = Date.UTC(2026, 9, 10, 3, 0);
export const BASE = "http://desk.test";

export interface DeskOptions {
  passcode?: string;
  openDesk?: boolean;
  // Put something between the agent and the mock, to make PayPal misbehave.
  wrap?: (mock: MockPayPal) => PayPalClient;
}

export function makeDesk(options: DeskOptions = {}) {
  const store = new MemoryStore();
  const paypal = new MockPayPal(store, BASE);
  const app = createApp({
    store,
    paypal: options.wrap ? options.wrap(paypal) : paypal,
    llm: new StubLlm(),
    baseUrl: BASE,
    demoControls: true,
    wallClock: () => NOW,
    passcode: options.passcode,
    openDesk: options.openDesk,
  });
  // Cookie jar of one, so a signed-in desk stays signed in.
  let cookie = "";

  async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const init: RequestInit = { method, headers: { ...(cookie ? { cookie } : {}), ...headers } };
    if (body instanceof URLSearchParams || typeof body === "string") init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const res = await app.handle(new Request(BASE + path, init));
    if (!res) throw new Error(`no route for ${method} ${path}`);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  }

  const desk = {
    paypal,
    store,
    app,
    call,
    signOut: () => {
      cookie = "";
    },
    post: (path: string, body: unknown = {}) => call("POST", path, body),

    async state(): Promise<AppState> {
      return ((await (await call("GET", "/api/state")).json()) as { state: AppState }).state;
    },

    // Find a seeded or added inquiry by a word in its text.
    async inquiry(word: string): Promise<Inquiry> {
      const found = (await desk.state()).inquiries.filter((i) => i.text.includes(word)).pop();
      if (!found) throw new Error(`no inquiry mentioning ${word}`);
      return found;
    },

    async bookingOf(inq: Inquiry): Promise<Booking> {
      const fresh = (await desk.state()).inquiries.find((i) => i.id === inq.id)!;
      const booking = (await desk.state()).bookings.find((b) => b.id === fresh.bookingId);
      if (!booking) throw new Error(`no booking for ${inq.id}`);
      return booking;
    },

    async run(word: string): Promise<Inquiry> {
      const inq = await desk.inquiry(word);
      await desk.post(`/api/inquiries/${inq.id}/run`);
      return desk.inquiry(word);
    },

    // Drop one of the demo messages into the inbox and let the agent handle it.
    async addAndRun(label: string): Promise<Inquiry> {
      const sample = sampleMessages(NOW).find((s) => s.label.startsWith(label))!;
      const res = await desk.post("/api/inquiries", { text: sample.text });
      const { id } = (await res.json()) as { id: string };
      await desk.post(`/api/inquiries/${id}/run`);
      return (await desk.state()).inquiries.find((i) => i.id === id)!;
    },

    // What the guest does on the approval page.
    async pay(booking: Booking) {
      return call("POST", "/mock/paypal/approve", new URLSearchParams({ token: booking.orderId!, email: booking.guestEmail }));
    },
  };
  return desk;
}

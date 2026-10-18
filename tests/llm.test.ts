import { describe, expect, it } from "vitest";
import { WorkersAiLlm, type AiBinding, type Prices } from "../src/llm/workersai";
import { seedState } from "../src/seed";
import { MemoryStore } from "../src/store";
import { NOW } from "./helpers";

// The model behind the AI binding is faked here; what is under test is the
// range checking, the fall-backs and the daily cap around it.

const PRICES: Prices = { neuronsPerMInput: 1_000_000, neuronsPerMOutput: 1_000_000, dailyBudget: 5_000 };
const venue = seedState(NOW).venue;

function fakeAi(answer: (input: Record<string, unknown>) => unknown): AiBinding & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    async run(_model, input) {
      calls.push(input);
      return answer(input);
    },
  };
}

const reading = {
  intent: "book", lang: "ja", offeringId: "wheel-class", date: { y: 2026, m: 10, d: 15 },
  hour: 14, minute: 0, guests: 2, name: "Kenji", email: "ignored@example.com",
};

describe("Workers AI reader", () => {
  it("takes the model's reading when it is in range, but keeps the rule-based email", async () => {
    const ai = fakeAi(() => ({ response: reading, usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    const llm = new WorkersAiLlm(ai, "@cf/test", new MemoryStore(), PRICES, () => NOW);
    const u = await llm.understand("10月15日の午後2時にろくろ体験を2人で kenji@example.com", venue, NOW);
    expect(u).toMatchObject({ lang: "ja", offeringId: "wheel-class", guests: 2, hour: 14, name: "Kenji", email: "kenji@example.com" });
    expect(ai.calls[0]!.response_format).toMatchObject({ type: "json_schema" });
    expect(await llm.usage()).toMatchObject({ calls: 1, neurons: 120, budget: 5_000 });
  });

  it("drops values that are out of range or not in the venue", async () => {
    const ai = fakeAi(() => ({ response: { ...reading, offeringId: "sauna", guests: 99, hour: 31, date: { y: 1999, m: 1, d: 1 } } }));
    const llm = new WorkersAiLlm(ai, "@cf/test", new MemoryStore(), PRICES, () => NOW);
    const u = await llm.understand("hello", venue, NOW);
    expect(u.offeringId).toBeUndefined();
    expect(u.guests).toBeUndefined();
    expect(u.hour).toBeUndefined();
    expect(u.date).toBeUndefined();
  });

  it("falls back to the rules when the model fails, and stops calling past the daily budget", async () => {
    let fail = true;
    const ai = fakeAi(() => {
      if (fail) throw new Error("model down");
      return { response: reading, usage: { prompt_tokens: 4_000, completion_tokens: 500 } };
    });
    const store = new MemoryStore();
    const llm = new WorkersAiLlm(ai, "@cf/test", store, PRICES, () => NOW);
    const text = "Could 3 friends book the wheel class on Oct 14 at 2:30pm? - Maya, maya@example.com";
    const down = await llm.understand(text, venue, NOW);
    expect(down).toMatchObject({ lang: "en", guests: 3, hour: 14, minute: 30, name: "Maya" });

    fail = false;
    await llm.understand(text, venue, NOW);
    expect((await llm.usage()).neurons).toBe(4_500);
    const callsBefore = ai.calls.length;
    const capped = await llm.understand(text, venue, NOW);
    expect(ai.calls.length).toBe(callsBefore);
    expect(capped).toMatchObject({ guests: 3, name: "Maya" });
  });

  it("starts a new count on a new day", async () => {
    const ai = fakeAi(() => ({ response: reading, usage: { prompt_tokens: 4_000, completion_tokens: 500 } }));
    const store = new MemoryStore();
    let now = NOW;
    const llm = new WorkersAiLlm(ai, "@cf/test", store, PRICES, () => now);
    await llm.understand("x", venue, NOW);
    expect((await llm.usage()).neurons).toBe(4_500);
    now += 86_400_000;
    expect(await llm.usage()).toMatchObject({ calls: 0, neurons: 0 });
  });
});

describe("Workers AI replies", () => {
  const facts = {
    kind: "pay_link" as const, lang: "en" as const, guestName: "Maya", venueName: venue.name,
    offeringName: "Wheel throwing class", when: "Thu 15 Oct, 14:00", guests: 3,
    deposit: "$72.00", total: "$144.00", payUrl: "https://pay.example/abc", holdMinutes: 30,
  };

  it("uses the model's wording when it keeps every fact", async () => {
    const ai = fakeAi((input) => {
      const draft = (input.messages as { content: string }[])[1]!.content;
      return { response: "Hello Maya! " + draft };
    });
    const llm = new WorkersAiLlm(ai, "@cf/test", new MemoryStore(), PRICES, () => NOW);
    const reply = await llm.writeReply(facts);
    expect(reply.startsWith("Hello Maya!")).toBe(true);
    expect(reply).toContain(facts.payUrl);
  });

  it("throws away a reply that lost the pay link or an amount", async () => {
    const ai = fakeAi(() => ({ response: "Hi Maya, see you Thu 15 Oct, 14:00! Deposit $72.00, total $144.00." }));
    const llm = new WorkersAiLlm(ai, "@cf/test", new MemoryStore(), PRICES, () => NOW);
    const reply = await llm.writeReply(facts);
    expect(reply).toContain(facts.payUrl);
    expect(reply.startsWith("Hi Maya,")).toBe(true);
  });
});

import type { Understanding, Venue } from "../types";
import { toLocal } from "../schedule";
import { readMessage, templateReply } from "./stub";
import type { Llm, ReplyFacts, Usage } from "./types";

// Shared half of every real model: the prompts, the range checks on what the
// model read, and the fall-back to the rule-based reader and the templates.
// Subclasses only say how to reach their model (`chat`).
//
// The model reads messages and phrases replies. It is never trusted with facts:
// its reading is range-checked, and a reply that drops or alters the pay link
// or an amount is thrown away in favour of the template.

export abstract class ModelLlm implements Llm {
  abstract readonly name: string;

  // Returns the model's text; throws when the model cannot be used right now.
  protected abstract chat(system: string, user: string, json: boolean): Promise<string>;

  usage?(): Promise<Usage>;

  async understand(text: string, venue: Venue, now: number): Promise<Understanding> {
    const fallback = readMessage(text, venue, now);
    const today = toLocal(now, venue.utcOffsetMinutes);
    const system =
      `You read booking messages for ${venue.name}. Today is ${today.y}-${today.m}-${today.d} ` +
      `(weekday ${today.weekday}, 0 = Sunday) in the venue's time zone. Offerings: ` +
      venue.offerings.map((o) => `${o.id} = ${o.name}`).join("; ") +
      `. Answer with one JSON object and nothing else: {"intent":"book"|"cancel"|"other",` +
      `"lang":"en"|"ja"|"ko","offeringId":string|null,"date":{"y":int,"m":int,"d":int}|null,` +
      `"hour":int|null,"minute":int|null,"guests":int|null,"name":string|null,"email":string|null}. ` +
      `Use null for anything the message does not say. Do not guess.`;
    try {
      const raw = JSON.parse(await this.chat(system, text, true)) as Record<string, unknown>;
      return checked(raw, venue, fallback);
    } catch {
      return fallback;
    }
  }

  async writeReply(facts: ReplyFacts): Promise<string> {
    const template = templateReply(facts);
    const system =
      "Rewrite the draft reply so it sounds like a friendly small studio owner, in the same " +
      "language as the draft. Keep every date, time, amount and link exactly as written. " +
      "Add nothing that is not in the draft. Plain text, under 90 words.";
    try {
      const text = (await this.chat(system, template, false)).trim();
      const mustKeep = [facts.payUrl, facts.deposit, facts.total, facts.refund, facts.when].filter(
        (v): v is string => Boolean(v),
      );
      return text && mustKeep.every((v) => text.includes(v)) ? text : template;
    } catch {
      return template;
    }
  }
}

// Keep only values that are the right type and in range; fall back to the
// rule-based reading for the email, which a model has no business rewriting.
export function checked(raw: Record<string, unknown>, venue: Venue, fallback: Understanding): Understanding {
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

  const u: Understanding = {
    intent: raw.intent === "cancel" || raw.intent === "other" ? raw.intent : "book",
    lang: raw.lang === "ja" || raw.lang === "ko" ? raw.lang : "en",
    email: fallback.email,
  };
  if (venue.offerings.some((o) => o.id === raw.offeringId)) u.offeringId = raw.offeringId as string;

  const d = raw.date as Record<string, unknown> | null | undefined;
  if (d) {
    const y = int(d.y, 2026, 2030);
    const m = int(d.m, 1, 12);
    const day = int(d.d, 1, 31);
    if (y && m && day) u.date = { y, m, d: day };
  }
  const hour = int(raw.hour, 0, 23);
  if (hour !== undefined) {
    u.hour = hour;
    u.minute = int(raw.minute, 0, 59) ?? 0;
  }
  const guests = int(raw.guests, 1, 50);
  if (guests) u.guests = guests;
  if (typeof raw.name === "string" && raw.name.length <= 60) u.name = raw.name;
  else u.name = fallback.name;
  return u;
}

// The JSON shape asked of models that support a schema.
export const UNDERSTANDING_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["book", "cancel", "other"] },
    lang: { type: "string", enum: ["en", "ja", "ko"] },
    offeringId: { type: ["string", "null"] },
    date: {
      type: ["object", "null"],
      properties: { y: { type: "integer" }, m: { type: "integer" }, d: { type: "integer" } },
      required: ["y", "m", "d"],
    },
    hour: { type: ["integer", "null"] },
    minute: { type: ["integer", "null"] },
    guests: { type: ["integer", "null"] },
    name: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
  },
  required: ["intent", "lang", "offeringId", "date", "hour", "minute", "guests", "name", "email"],
};

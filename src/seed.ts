import { shortId } from "./agent";
import { fromLocal, startOfLocalDay, toLocal } from "./schedule";
import type { AppState, Booking, Inquiry, Venue } from "./types";

// Demo data: a made-up pottery studio and a morning's worth of messages.
// Dates are written relative to "now" so the demo works on any day.

const DAY = 86_400_000;
const OFFSET = 9 * 60; // Seoul, no daylight saving

const venue: Venue = {
  name: "Dalhang Pottery Studio",
  city: "Seoul",
  utcOffsetMinutes: OFFSET,
  // PayPal does not settle in KRW, so a Korean studio charges visitors in USD.
  currency: "USD",
  openHour: 10,
  closeHour: 19,
  resources: [
    { id: "wheel", name: "Wheel room" },
    { id: "glaze", name: "Glaze table" },
  ],
  offerings: [
    {
      id: "wheel-class",
      name: "Wheel throwing class",
      resourceId: "wheel",
      minutes: 120,
      pricePerGuestCents: 4800,
      maxGuests: 4,
      keywords: ["wheel", "throwing", "ろくろ", "물레"],
    },
    {
      id: "glaze-class",
      name: "Glaze painting session",
      resourceId: "glaze",
      minutes: 90,
      pricePerGuestCents: 3200,
      maxGuests: 6,
      keywords: ["glaze", "glazing", "painting", "絵付け", "페인팅"],
    },
  ],
  policy: {
    depositPercent: 50,
    holdMinutes: 30,
    leadMinutes: 120,
    autoHoldLimitCents: 8000,
    autoRefundLimitCents: 8000,
    maxDepositCents: 30000,
    refundTiers: [
      { hoursBefore: 48, percent: 100 },
      { hoursBefore: 24, percent: 50 },
    ],
  },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayAhead(now: number, days: number) {
  const p = toLocal(startOfLocalDay(now, OFFSET) + days * DAY, OFFSET);
  return { ...p, en: `${MONTHS[p.m - 1]} ${p.d}`, ja: `${p.m}月${p.d}日` };
}

// Messages the demo can drop into the inbox.
export function sampleMessages(now: number): { label: string; text: string }[] {
  const d4 = dayAhead(now, 4);
  const d5 = dayAhead(now, 5);
  const d6 = dayAhead(now, 6);
  return [
    {
      label: "Maya: 3 guests, free slot",
      text: `Hi! We're 3 friends visiting Seoul next week. Could we book the wheel throwing class on ${d4.en} at 2pm? Thanks! Maya (maya.r@example.com)`,
    },
    {
      label: "Kenji: slot already taken",
      text: `こんにちは。${d5.ja}の午後2時にろくろ体験を2人で予約できますか？ 田中 kenji.t@example.com`,
    },
    {
      label: "Tom: details missing",
      text: "Hello, do you have any classes this week? We are a family of 5. - Tom, tom.b@example.com",
    },
    {
      label: "Priya: deposit over the limit",
      text: `We'd love a glaze painting session for 6 people on ${d6.en} at 11am for a team outing. Priya, priya.k@example.com`,
    },
    {
      label: "Maya: cancellation",
      text: "Hi, something came up and we have to cancel our class. So sorry! Maya (maya.r@example.com)",
    },
    {
      label: "Sora: same slot as Maya",
      text: `Hello, can 2 people join the wheel class on ${d4.en} at 14:00? sora.w@example.com`,
    },
  ];
}

export function newInquiry(text: string, now: number, channel = "email"): Inquiry {
  return { id: "INQ-" + shortId(), channel, receivedAt: now, text, status: "new" };
}

export function seedState(now: number): AppState {
  const d5 = dayAhead(now, 5);
  const d2 = dayAhead(now, 2);

  // Bookings that were already on the calendar, taken by phone.
  const existing: Booking[] = [
    {
      id: "BK-" + shortId(),
      createdAt: now - 3 * DAY,
      offeringId: "wheel-class",
      resourceId: "wheel",
      start: fromLocal(d5.y, d5.m, d5.d, 14, 0, OFFSET),
      end: fromLocal(d5.y, d5.m, d5.d, 16, 0, OFFSET),
      guests: 4,
      guestName: "Han family",
      guestEmail: "phone-booking@example.com",
      status: "confirmed",
      totalCents: 19200,
      depositCents: 9600,
    },
    {
      id: "BK-" + shortId(),
      createdAt: now - 2 * DAY,
      offeringId: "glaze-class",
      resourceId: "glaze",
      start: fromLocal(d2.y, d2.m, d2.d, 11, 0, OFFSET),
      end: fromLocal(d2.y, d2.m, d2.d, 12, 30, OFFSET),
      guests: 5,
      guestName: "School visit",
      guestEmail: "phone-booking@example.com",
      status: "confirmed",
      totalCents: 16000,
      depositCents: 8000,
    },
  ];

  const inbox = sampleMessages(now)
    .slice(0, 4)
    .map((s, i) => newInquiry(s.text, now - (4 - i) * 11 * 60_000, i === 1 ? "instagram" : "email"));

  return {
    venue: structuredClone(venue),
    inquiries: inbox,
    bookings: existing,
    log: [],
    seenEvents: [],
    logSeq: 0,
    clockOffsetMs: 0,
  };
}

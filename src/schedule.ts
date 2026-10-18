import type { AppState, Booking, Offering, Slot, Venue } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hour: number;
  minute: number;
  // 0 = Sunday
  weekday: number;
}

// The venue runs on a fixed UTC offset, so local time is plain arithmetic.
export function toLocal(ms: number, offsetMinutes: number): LocalParts {
  const t = new Date(ms + offsetMinutes * MIN);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(),
  };
}

export function fromLocal(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): number {
  return Date.UTC(y, m - 1, d, hour, minute) - offsetMinutes * MIN;
}

export function startOfLocalDay(ms: number, offsetMinutes: number): number {
  const p = toLocal(ms, offsetMinutes);
  return fromLocal(p.y, p.m, p.d, 0, 0, offsetMinutes);
}

function occupies(b: Booking): boolean {
  return b.status === "held" || b.status === "confirmed";
}

export function isFree(state: AppState, slot: Slot, ignoreBookingId?: string): boolean {
  return !state.bookings.some(
    (b) =>
      occupies(b) &&
      b.id !== ignoreBookingId &&
      b.resourceId === slot.resourceId &&
      b.start < slot.end &&
      slot.start < b.end,
  );
}

export function withinOpeningHours(venue: Venue, slot: Slot): boolean {
  const s = toLocal(slot.start, venue.utcOffsetMinutes);
  const dayStart = fromLocal(s.y, s.m, s.d, 0, 0, venue.utcOffsetMinutes);
  return (
    slot.start >= dayStart + venue.openHour * HOUR && slot.end <= dayStart + venue.closeHour * HOUR
  );
}

export function slotFor(offering: Offering, start: number): Slot {
  return { resourceId: offering.resourceId, start, end: start + offering.minutes * MIN };
}

export function bookable(state: AppState, slot: Slot, now: number): boolean {
  return (
    slot.start >= now + state.venue.policy.leadMinutes * MIN &&
    withinOpeningHours(state.venue, slot) &&
    isFree(state, slot)
  );
}

// Free slots closest to what the guest asked for: same day first, then the
// next two days. Starts are on the half hour.
export function findAlternatives(
  state: AppState,
  offering: Offering,
  wantedStart: number,
  now: number,
  count = 3,
): Slot[] {
  const { venue } = state;
  const day0 = startOfLocalDay(wantedStart, venue.utcOffsetMinutes);
  const found: { slot: Slot; cost: number }[] = [];

  for (let dayShift = 0; dayShift <= 2; dayShift++) {
    const dayStart = day0 + dayShift * DAY;
    for (let m = venue.openHour * 60; m + offering.minutes <= venue.closeHour * 60; m += 30) {
      const slot = slotFor(offering, dayStart + m * MIN);
      if (slot.start === wantedStart || !bookable(state, slot, now)) continue;
      // Changing the day costs more than changing the hour.
      const sameClock = wantedStart + dayShift * DAY;
      const cost = Math.abs(slot.start - sameClock) / HOUR + dayShift * 6;
      found.push({ slot, cost });
    }
  }

  found.sort((a, b) => a.cost - b.cost || a.slot.start - b.slot.start);

  // Drop options that overlap a better one, so the owner sees distinct choices.
  const picked: Slot[] = [];
  for (const { slot } of found) {
    if (picked.some((p) => p.start < slot.end && slot.start < p.end)) continue;
    picked.push(slot);
    if (picked.length === count) break;
  }
  return picked;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Sat 17 Oct, 14:00" in venue time.
export function formatLocal(ms: number, offsetMinutes: number): string {
  const p = toLocal(ms, offsetMinutes);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${WEEKDAYS[p.weekday]} ${p.d} ${MONTHS[p.m - 1]}, ${hh}:${mm}`;
}

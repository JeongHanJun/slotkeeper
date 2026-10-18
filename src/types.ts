// Domain types. Times are epoch milliseconds; money is integer cents.

export interface Resource {
  id: string;
  name: string;
}

export interface Offering {
  id: string;
  name: string;
  resourceId: string;
  minutes: number;
  pricePerGuestCents: number;
  maxGuests: number;
  // Words that identify this offering in a guest message (any language).
  keywords: string[];
}

export interface RefundTier {
  hoursBefore: number;
  percent: number;
}

// Everything the agent may decide on its own is bounded by these numbers.
export interface Policy {
  depositPercent: number;
  holdMinutes: number;
  leadMinutes: number;
  // Deposits above this need the owner's approval before a slot is held.
  autoHoldLimitCents: number;
  // Refunds above this need the owner's approval.
  autoRefundLimitCents: number;
  // No order is ever created above this, with or without approval.
  maxDepositCents: number;
  // Checked top to bottom; cancelling later than the last tier refunds nothing.
  refundTiers: RefundTier[];
}

export interface Venue {
  name: string;
  city: string;
  utcOffsetMinutes: number;
  currency: string;
  openHour: number;
  closeHour: number;
  resources: Resource[];
  offerings: Offering[];
  policy: Policy;
}

export type Lang = "en" | "ja" | "ko";

// What the language model is allowed to contribute: a reading of the message.
export interface Understanding {
  intent: "book" | "cancel" | "other";
  lang: Lang;
  offeringId?: string;
  date?: { y: number; m: number; d: number };
  hour?: number;
  minute?: number;
  guests?: number;
  name?: string;
  email?: string;
}

export interface Slot {
  resourceId: string;
  start: number;
  end: number;
}

export type BookingStatus = "held" | "confirmed" | "released" | "cancelled";

export interface Booking {
  id: string;
  createdAt: number;
  inquiryId?: string;
  offeringId: string;
  resourceId: string;
  start: number;
  end: number;
  guests: number;
  guestName: string;
  guestEmail: string;
  status: BookingStatus;
  totalCents: number;
  depositCents: number;
  holdExpiresAt?: number;
  orderId?: string;
  approveUrl?: string;
  captureId?: string;
  // PayPal took the capture but has not finished it (status PENDING).
  paymentPending?: boolean;
  refundId?: string;
  refundedCents?: number;
}

export type InquiryStatus =
  | "new"
  | "needs_info"
  | "awaiting_owner"
  | "awaiting_payment"
  | "booked"
  | "waitlisted"
  | "lapsed"
  | "cancelled"
  | "declined";

export interface Proposal {
  kind: "alternative" | "over_limit" | "refund";
  reason: string;
  options: Slot[];
  // Set for refund proposals.
  bookingId?: string;
  refundCents?: number;
}

export interface Inquiry {
  id: string;
  channel: string;
  receivedAt: number;
  text: string;
  status: InquiryStatus;
  understanding?: Understanding;
  // The slot the guest actually asked for; used to backfill from the waitlist.
  wanted?: Slot;
  proposal?: Proposal;
  bookingId?: string;
  // Draft reply to the guest. Sending is out of scope for the prototype.
  reply?: string;
}

export interface LogEntry {
  seq: number;
  at: number;
  actor: "agent" | "owner" | "paypal" | "system";
  text: string;
  // PayPal call or event name, when the entry is about money.
  ref?: string;
}

export interface AppState {
  venue: Venue;
  inquiries: Inquiry[];
  bookings: Booking[];
  log: LogEntry[];
  // Webhook events already processed (PayPal retries deliveries).
  seenEvents: { id: string; at: number }[];
  // Number of the last activity line written.
  logSeq: number;
  // Demo-only clock offset so a hold can be shown expiring without waiting.
  clockOffsetMs: number;
}

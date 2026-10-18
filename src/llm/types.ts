import type { Lang, Understanding, Venue } from "../types";

// Facts the agent has already decided. A reply may phrase them, never change them.
export interface ReplyFacts {
  kind:
    | "pay_link"
    | "alternative_held"
    | "ask_details"
    | "too_many_guests"
    | "waitlisted"
    | "hold_lapsed"
    | "cancelled"
    | "booking_not_found"
    | "declined"
    // The owner moved the booking on the board.
    | "moved";
  lang: Lang;
  guestName?: string;
  venueName: string;
  offeringName?: string;
  when?: string;
  guests?: number;
  deposit?: string;
  total?: string;
  payUrl?: string;
  holdMinutes?: number;
  missing?: string[];
  maxGuests?: number;
  refund?: string;
  refundRule?: string;
}

// What a metered model has spent today.
export interface Usage {
  day: string;
  calls: number;
  neurons: number;
  budget: number;
}

export interface Llm {
  readonly name: string;
  understand(text: string, venue: Venue, now: number): Promise<Understanding>;
  writeReply(facts: ReplyFacts): Promise<string>;
  // Only models with a spend cap report this.
  usage?(): Promise<Usage>;
}

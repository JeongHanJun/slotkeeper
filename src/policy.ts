import type { Booking, Policy } from "./types";

const HOUR = 3_600_000;

export function depositFor(totalCents: number, policy: Policy): number {
  return Math.round((totalCents * policy.depositPercent) / 100);
}

export interface RefundDecision {
  percent: number;
  cents: number;
  rule: string;
}

// How much of the deposit goes back if the guest cancels at `now`.
export function refundFor(booking: Booking, now: number, policy: Policy): RefundDecision {
  const paid = booking.depositCents - (booking.refundedCents ?? 0);
  const hoursLeft = (booking.start - now) / HOUR;
  for (const tier of policy.refundTiers) {
    if (hoursLeft >= tier.hoursBefore) {
      return {
        percent: tier.percent,
        cents: Math.round((paid * tier.percent) / 100),
        rule: `${tier.percent}% back when cancelled ${tier.hoursBefore}h or more before the start`,
      };
    }
  }
  const last = policy.refundTiers[policy.refundTiers.length - 1];
  return {
    percent: 0,
    cents: 0,
    rule: `no refund inside ${last ? last.hoursBefore : 0}h of the start`,
  };
}

// PayPal amounts are decimal strings ("72.00").
export function toAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fromAmount(value: string): number {
  return Math.round(Number(value) * 100);
}

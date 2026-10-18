import { fromLocal, toLocal } from "../schedule";
import type { Lang, Understanding, Venue } from "../types";
import type { Llm, ReplyFacts } from "./types";

// Rule-based reader and fixed reply templates. This is the default, so the demo
// and the tests behave the same on every run and need no API key.
// It reads typical booking messages in English, Japanese and Korean; anything
// it cannot read is left empty and the agent asks the guest for it.

const DAY = 86_400_000;

export class StubLlm implements Llm {
  readonly name = "stub";

  async understand(text: string, venue: Venue, now: number): Promise<Understanding> {
    return readMessage(text, venue, now);
  }

  async writeReply(facts: ReplyFacts): Promise<string> {
    return templateReply(facts);
  }
}

export function readMessage(text: string, venue: Venue, now: number): Understanding {
  const lower = text.toLowerCase();
  const u: Understanding = {
    intent: /\bcancel|キャンセル|取り消|취소/i.test(text) ? "cancel" : "book",
    lang: detectLang(text),
  };

  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) u.email = email[0].toLowerCase();
  u.name = readName(text, u.email);

  const offering = venue.offerings.find((o) => o.keywords.some((k) => lower.includes(k.toLowerCase())));
  if (offering) u.offeringId = offering.id;

  const guests = readGuests(text);
  if (guests) u.guests = guests;

  const date = readDate(text, now, venue.utcOffsetMinutes);
  if (date) u.date = date;

  const time = readTime(text);
  if (time) {
    u.hour = time.hour;
    u.minute = time.minute;
  }

  if (u.intent === "book" && !offering && !guests && !date && !time) u.intent = "other";
  return u;
}

function detectLang(text: string): Lang {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  return "en";
}

function readName(text: string, email?: string): string | undefined {
  // A sign-off such as "— Maya" or "- Tom".
  const signed = text.match(/(?:^|\s)[—–-]\s*([A-Z][a-z]+)\b/);
  if (signed) return signed[1];
  if (!email) return undefined;
  const first = email.split("@")[0]!.split(/[._\d+-]/)[0];
  return first ? first[0]!.toUpperCase() + first.slice(1) : undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function readGuests(text: string): number | undefined {
  const unit = "(?:people|persons|guests|friends|adults|of us|pax|人|名|명)";
  const patterns = [
    new RegExp(`(\\d{1,2})\\s*${unit}`, "i"),
    /(?:family|group|party|team)\s+of\s+(\d{1,2})/i,
    /\bfor\s+(\d{1,2})\b(?!\s*(?:am|pm|[:/]))/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return Number(m[1]);
  }
  const word = text.match(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\s+${unit}`, "i"));
  if (word) return NUMBER_WORDS[word[1]!.toLowerCase()];
  if (/\bcouple\b|\bmy (?:wife|husband|partner) and i\b/i.test(text)) return 2;
  if (/\bjust me\b|\bby myself\b|\balone\b/i.test(text)) return 1;
  return undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const EN_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const JA_DAYS = "日月火水木金土";
const KO_DAYS = "일월화수목금토";

function readDate(text: string, now: number, offset: number) {
  const today = toLocal(now, offset);
  const todayStart = fromLocal(today.y, today.m, today.d, 0, 0, offset);
  const at = (ms: number) => {
    const p = toLocal(ms, offset);
    return { y: p.y, m: p.m, d: p.d };
  };
  // A month and day with no year means the next time that date comes round.
  const monthDay = (m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    const y = fromLocal(today.y, m, d, 0, 0, offset) < todayStart ? today.y + 1 : today.y;
    return { y, m, d };
  };

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };

  const cjk = text.match(/(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]/);
  if (cjk) return monthDay(Number(cjk[1]), Number(cjk[2]));

  const names = MONTHS.join("|");
  const monthFirst = text.match(new RegExp(`\\b(${names})[a-z]*\\.?\\s+(\\d{1,2})\\b`, "i"));
  if (monthFirst) {
    return monthDay(MONTHS.indexOf(monthFirst[1]!.toLowerCase()) + 1, Number(monthFirst[2]));
  }
  const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${names})`, "i"));
  if (dayFirst) {
    return monthDay(MONTHS.indexOf(dayFirst[2]!.toLowerCase()) + 1, Number(dayFirst[1]));
  }
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (slash) return monthDay(Number(slash[1]), Number(slash[2]));

  if (/\btomorrow\b|明日|내일/i.test(text)) return at(todayStart + DAY);

  let weekday = -1;
  const en = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/i);
  const ja = text.match(/([日月火水木金土])曜/);
  const ko = text.match(/([일월화수목금토])요일/);
  if (en) weekday = EN_DAYS.indexOf(en[1]!.toLowerCase());
  else if (ja) weekday = JA_DAYS.indexOf(ja[1]!);
  else if (ko) weekday = KO_DAYS.indexOf(ko[1]!);
  if (weekday >= 0) {
    // A bare weekday is the next one, never today.
    const ahead = (weekday - today.weekday + 7) % 7 || 7;
    return at(todayStart + ahead * DAY);
  }
  return undefined;
}

function readTime(text: string): { hour: number; minute: number } | undefined {
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3]!.toLowerCase() === "pm") hour += 12;
    return { hour, minute: Number(ampm[2] ?? 0) };
  }

  const cjk = text.match(/(午前|午後|오전|오후)?\s*(\d{1,2})\s*[時시](?:\s*(\d{1,2})\s*[分분]|\s*(半|반))?/);
  if (cjk) {
    let hour = Number(cjk[2]);
    const afternoon = cjk[1] === "午後" || cjk[1] === "오후";
    // "2時" with no marker means the afternoon for a daytime studio.
    if ((afternoon || (!cjk[1] && hour < 8)) && hour < 12) hour += 12;
    return { hour, minute: cjk[4] ? 30 : Number(cjk[3] ?? 0) };
  }

  const clock = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clock) return { hour: Number(clock[1]), minute: Number(clock[2]) };

  if (/\bmorning\b/i.test(text)) return { hour: 10, minute: 0 };
  if (/\bafternoon\b/i.test(text)) return { hour: 14, minute: 0 };
  if (/\bevening\b/i.test(text)) return { hour: 17, minute: 0 };
  return undefined;
}

const FIELD_NAMES: Record<Lang, Record<string, string>> = {
  en: { offering: "which class", date: "the date", time: "the start time", guests: "how many guests", email: "an email address for the payment link" },
  ja: { offering: "ご希望の体験", date: "ご希望の日付", time: "開始時間", guests: "人数", email: "お支払いリンク送付用のメールアドレス" },
  ko: { offering: "원하시는 클래스", date: "날짜", time: "시작 시간", guests: "인원", email: "결제 링크를 받을 이메일 주소" },
};

export function templateReply(f: ReplyFacts): string {
  const name = f.guestName ?? (f.lang === "en" ? "there" : "");
  const missing = (f.missing ?? []).map((k) => FIELD_NAMES[f.lang][k] ?? k);

  if (f.lang === "ja") {
    const hi = name ? `${name}様\n` : "";
    switch (f.kind) {
      case "pay_link":
        return `${hi}お問い合わせありがとうございます。${f.when}の「${f.offeringName}」（${f.guests}名様）を${f.holdMinutes}分間お取り置きしました。\n下記のリンクから予約金 ${f.deposit}（合計 ${f.total}）をPayPalでお支払いいただくと予約が確定します。\n${f.payUrl}\n${f.venueName}`;
      case "alternative_held":
        return `${hi}申し訳ありません、ご希望の時間は満席でした。代わりに${f.when}の「${f.offeringName}」（${f.guests}名様）を${f.holdMinutes}分間お取り置きしています。\nよろしければ下記のリンクから予約金 ${f.deposit} をお支払いください。\n${f.payUrl}\n${f.venueName}`;
      case "ask_details":
        return `${hi}お問い合わせありがとうございます。ご予約のため、次の点をお知らせください：${missing.join("、")}。\n${f.venueName}`;
      case "too_many_guests":
        return `${hi}「${f.offeringName}」は1回${f.maxGuests}名様までとなっております。2組に分けてのご案内は可能ですので、ご希望をお知らせください。\n${f.venueName}`;
      case "waitlisted":
        return `${hi}申し訳ありません、${f.when}は満席です。キャンセル待ちに登録しました。空きが出ましたらすぐにご連絡します。\n${f.venueName}`;
      case "hold_lapsed":
        return `${hi}お支払いの確認ができなかったため、${f.when}のお取り置きを解除しました。まだご希望でしたらお知らせください。\n${f.venueName}`;
      case "cancelled":
        return `${hi}${f.when}のご予約をキャンセルしました。${f.refund ? `${f.refund} を返金しました` : "返金はありません"}（${f.refundRule}）。\n${f.venueName}`;
      case "booking_not_found":
        return `${hi}ご予約が見つかりませんでした。ご予約時のメールアドレスをお知らせください。\n${f.venueName}`;
      case "declined":
        return `${hi}申し訳ありませんが、今回はご希望に沿うことができません。\n${f.venueName}`;
      case "moved":
        return `${hi}ご予約の変更のお知らせです。「${f.offeringName}」（${f.guests}名様）は${f.when}に変更となりました。${f.payUrl ? `\n${f.holdMinutes}分以内に下記のリンクから予約金 ${f.deposit} をお支払いいただくと確定します。\n${f.payUrl}` : "\nお支払い済みの予約金はそのまま有効です。"}\nご都合が合わない場合はお知らせください。\n${f.venueName}`;
    }
  }

  if (f.lang === "ko") {
    const hi = name ? `${name}님, ` : "";
    switch (f.kind) {
      case "pay_link":
        return `${hi}문의 감사합니다. ${f.when} "${f.offeringName}" (${f.guests}명) 자리를 ${f.holdMinutes}분 동안 잡아 두었습니다.\n아래 링크에서 예약금 ${f.deposit}(총 ${f.total})를 PayPal로 결제하시면 예약이 확정됩니다.\n${f.payUrl}\n${f.venueName}`;
      case "alternative_held":
        return `${hi}죄송합니다. 원하신 시간은 이미 찼습니다. 대신 ${f.when} "${f.offeringName}" (${f.guests}명) 자리를 ${f.holdMinutes}분 동안 잡아 두었습니다.\n괜찮으시면 아래 링크에서 예약금 ${f.deposit}를 결제해 주세요.\n${f.payUrl}\n${f.venueName}`;
      case "ask_details":
        return `${hi}문의 감사합니다. 예약을 위해 다음 내용을 알려 주세요: ${missing.join(", ")}.\n${f.venueName}`;
      case "too_many_guests":
        return `${hi}"${f.offeringName}"은 한 번에 ${f.maxGuests}명까지 가능합니다. 두 팀으로 나누어 진행할 수 있으니 원하시면 알려 주세요.\n${f.venueName}`;
      case "waitlisted":
        return `${hi}죄송합니다. ${f.when}은 이미 찼습니다. 대기 명단에 올려 두었고, 자리가 나면 바로 연락드리겠습니다.\n${f.venueName}`;
      case "hold_lapsed":
        return `${hi}결제가 확인되지 않아 ${f.when} 자리를 풀었습니다. 아직 원하시면 알려 주세요.\n${f.venueName}`;
      case "cancelled":
        return `${hi}${f.when} 예약을 취소했습니다. ${f.refund ? `${f.refund}를 환불했습니다` : "환불 금액은 없습니다"} (${f.refundRule}).\n${f.venueName}`;
      case "booking_not_found":
        return `${hi}예약 내역을 찾지 못했습니다. 예약하실 때 쓰신 이메일 주소를 알려 주세요.\n${f.venueName}`;
      case "declined":
        return `${hi}죄송합니다. 이번에는 요청하신 내용을 도와드리기 어렵습니다.\n${f.venueName}`;
      case "moved":
        return `${hi}예약 시간 변경 안내입니다. "${f.offeringName}" (${f.guests}명) 일정이 ${f.when}으로 바뀌었습니다.${f.payUrl ? `\n${f.holdMinutes}분 안에 아래 링크에서 예약금 ${f.deposit}를 결제하시면 확정됩니다.\n${f.payUrl}` : "\n이미 결제하신 예약금은 그대로 유효합니다."}\n새 시간이 맞지 않으면 알려 주세요.\n${f.venueName}`;
    }
  }

  const hi = `Hi ${name},\n`;
  switch (f.kind) {
    case "pay_link":
      return `${hi}Thanks for getting in touch. I'm holding ${f.offeringName} for ${f.guests} on ${f.when} for the next ${f.holdMinutes} minutes.\nPay the ${f.deposit} deposit (total ${f.total}) with PayPal to confirm:\n${f.payUrl}\n${f.venueName}`;
    case "alternative_held":
      return `${hi}Sorry, the time you asked for is already taken. I'm holding ${f.offeringName} for ${f.guests} on ${f.when} instead, for the next ${f.holdMinutes} minutes.\nIf that works, pay the ${f.deposit} deposit with PayPal to confirm:\n${f.payUrl}\n${f.venueName}`;
    case "ask_details":
      return `${hi}Thanks for getting in touch. To book you in I still need ${joinEn(missing)}.\n${f.venueName}`;
    case "too_many_guests":
      return `${hi}${f.offeringName} takes up to ${f.maxGuests} guests per session. We can split your group across two sessions; tell me if you'd like that.\n${f.venueName}`;
    case "waitlisted":
      return `${hi}Sorry, ${f.when} is fully booked. I've put you on the waitlist and will write the moment it opens up.\n${f.venueName}`;
    case "hold_lapsed":
      return `${hi}We didn't receive the deposit, so I've released your hold for ${f.when}. Write back if you'd still like to come.\n${f.venueName}`;
    case "cancelled":
      return `${hi}Your booking on ${f.when} is cancelled. ${f.refund ? `${f.refund} has been refunded to your PayPal account` : "No refund is due"} (${f.refundRule}).\n${f.venueName}`;
    case "booking_not_found":
      return `${hi}I couldn't find an open booking for this address. Which email did you book with?\n${f.venueName}`;
    case "declined":
      return `${hi}Sorry, we can't help with this request this time.\n${f.venueName}`;
    case "moved":
      return `${hi}A quick update: your ${f.offeringName} for ${f.guests} is now on ${f.when}.${f.payUrl ? ` The ${f.deposit} deposit still confirms it, within the next ${f.holdMinutes} minutes:\n${f.payUrl}` : " Your deposit stays as it is; nothing more to do."}\nReply if the new time doesn't work for you.\n${f.venueName}`;
  }
}

function joinEn(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

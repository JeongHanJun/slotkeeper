// Reads 20 guest messages through the running desk's model and through the
// rule-based reader, scores both against what each message actually says, and
// writes the table to docs/READER_COMPARISON.md.
//
// Needs a desk on http://127.0.0.1:8794 started with LLM_MODE=workers-ai (or
// openai); with the stub the two columns are the same by definition.

import { writeFileSync } from "node:fs";

const BASE = process.env.DESK_URL ?? "http://127.0.0.1:8794";

// Dates are written for a desk whose "today" is any day in October 2026; the
// expected date is given as m/d, the weekday cases as "next <weekday>".
const CASES = [
  { text: "Hi! We're 3 friends visiting Seoul next week. Could we book the wheel throwing class on Oct 14 at 2pm? Thanks! Maya (maya.r@example.com)", want: { intent: "book", lang: "en", offeringId: "wheel-class", date: "10/14", hour: 14, guests: 3, email: "maya.r@example.com" } },
  { text: "こんにちは、10月15日の午後2時にろくろ体験を2人で予約できますか？ 田中 kenji.t@example.com", want: { intent: "book", lang: "ja", offeringId: "wheel-class", date: "10/15", hour: 14, guests: 2, email: "kenji.t@example.com" } },
  { text: "토요일 오전 11시에 물레 체험 4명 예약 가능할까요? jisoo@example.com", want: { intent: "book", lang: "ko", offeringId: "wheel-class", hour: 11, guests: 4, email: "jisoo@example.com" } },
  { text: "Hello, do you have any classes this week? We are a family of 5. - Tom, tom.b@example.com", want: { intent: "book", lang: "en", guests: 5, email: "tom.b@example.com" } },
  { text: "We'd love a glaze painting session for 6 people on Oct 16 at 11am for a team outing. Priya, priya.k@example.com", want: { intent: "book", lang: "en", offeringId: "glaze-class", date: "10/16", hour: 11, guests: 6, email: "priya.k@example.com" } },
  { text: "Sorry, something came up and we have to cancel our booking. Maya, maya.r@example.com", want: { intent: "cancel", lang: "en", email: "maya.r@example.com" } },
  { text: "My wife and I would like to try the wheel on the 20th of October around 3:30pm. dan@example.com", want: { intent: "book", lang: "en", offeringId: "wheel-class", date: "10/20", hour: 15, minute: 30, guests: 2, email: "dan@example.com" } },
  { text: "Is the glazing workshop suitable for kids? Two adults and two children, Sunday morning if possible. lee.family@example.com", want: { intent: "book", lang: "en", offeringId: "glaze-class", guests: 4, email: "lee.family@example.com" } },
  { text: "予約のキャンセルをお願いします。来週の絵付けの予約です。sato@example.com", want: { intent: "cancel", lang: "ja", email: "sato@example.com" } },
  { text: "10/18 午前10時から、絵付け体験を3名でお願いしたいです。yuki@example.com", want: { intent: "book", lang: "ja", offeringId: "glaze-class", date: "10/18", hour: 10, guests: 3, email: "yuki@example.com" } },
  { text: "10월 19일 오후 4시에 페인팅 수업 2명 예약하고 싶어요. minji@example.com", want: { intent: "book", lang: "ko", offeringId: "glaze-class", date: "10/19", hour: 16, guests: 2, email: "minji@example.com" } },
  { text: "예약 취소하려고요. 지난주에 물레 체험 예약했던 사람입니다. hoon@example.com", want: { intent: "cancel", lang: "ko", email: "hoon@example.com" } },
  { text: "Hey, just me, wheel class tomorrow afternoon? sam@example.com", want: { intent: "book", lang: "en", offeringId: "wheel-class", guests: 1, hour: 14, email: "sam@example.com" } },
  { text: "Do you sell gift vouchers? Asking for a friend's birthday. nora@example.com", want: { intent: "other", lang: "en", email: "nora@example.com" } },
  { text: "Can 8 of us do the pottery wheel together on Friday 10/17 at 1pm? It's a bachelorette party. chloe@example.com", want: { intent: "book", lang: "en", offeringId: "wheel-class", date: "10/17", hour: 13, guests: 8, email: "chloe@example.com" } },
  { text: "Booking request: glaze painting, 2026-10-21, 17:00, 4 guests. Contact: park.j@example.com", want: { intent: "book", lang: "en", offeringId: "glaze-class", date: "10/21", hour: 17, guests: 4, email: "park.j@example.com" } },
  { text: "ろくろ体験、10月22日水曜の夕方に友人と二人で参加したいです。hana@example.com", want: { intent: "book", lang: "ja", offeringId: "wheel-class", date: "10/22", guests: 2, email: "hana@example.com" } },
  { text: "다음 주 수요일 오후 2시 반에 물레 체험 셋이서 가능한가요? yj@example.com", want: { intent: "book", lang: "ko", offeringId: "wheel-class", hour: 14, minute: 30, guests: 3, email: "yj@example.com" } },
  { text: "What's your address and is there parking nearby? We booked for Saturday. chris@example.com", want: { intent: "other", lang: "en", email: "chris@example.com" } },
  { text: "Hi, I'd like to move my glaze session from the 16th to the 23rd, same time 11am, still 6 people. priya.k@example.com", want: { intent: "book", lang: "en", offeringId: "glaze-class", date: "10/23", hour: 11, guests: 6, email: "priya.k@example.com" } },
];

const FIELDS = ["intent", "lang", "offeringId", "date", "hour", "minute", "guests", "email"];

function got(u, field) {
  if (field === "date") return u.date ? `${u.date.m}/${u.date.d}` : undefined;
  return u[field];
}

function score(u, want) {
  const misses = [];
  for (const f of FIELDS) {
    if (!(f in want)) continue;
    if (got(u, f) !== want[f]) misses.push(`${f}=${JSON.stringify(got(u, f) ?? null)}`);
  }
  return misses;
}

const rows = [];
let modelHits = 0;
let rulesHits = 0;
let reader = "";
for (const c of CASES) {
  const res = await fetch(`${BASE}/api/demo/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: c.text }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { reader: r, model, rules } = await res.json();
  reader = r;
  const m = score(model, c.want);
  const k = score(rules, c.want);
  if (m.length === 0) modelHits++;
  if (k.length === 0) rulesHits++;
  rows.push(`| ${c.want.lang} | ${c.text.slice(0, 60).replace(/\|/g, "/")}… | ${m.length ? "✗ " + m.join(", ") : "✓"} | ${k.length ? "✗ " + k.join(", ") : "✓"} |`);
}

const n = CASES.length;
const doc = `# Reading messages: model vs rules

${n} guest messages (English, Japanese, Korean) read by the model behind the desk
(\`${reader}\`) and by the rule-based reader (\`src/llm/stub.ts\`). A row is ✓ when
every field the message states (intent, language, class, date, time, guests,
email) came out right; otherwise the wrong fields are listed. The email is always
taken from the rules, so it never differs.

Generated by \`node scripts/compare-readers.mjs\` on ${new Date().toISOString().slice(0, 10)}.

| lang | message | model | rules |
|---|---|---|---|
${rows.join("\n")}

**All fields right: model ${modelHits}/${n}, rules ${rulesHits}/${n}.**
`;
writeFileSync(new URL("../docs/READER_COMPARISON.md", import.meta.url), doc);
console.log(doc);

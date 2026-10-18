// Owner's desk. Plain DOM, no build step. The schedule is a Bryntum Scheduler
// when its bundle is present (scripts/vendor.mjs), and a plain board otherwise.

const $ = (id) => document.getElementById(id);
const MIN = 60_000;
const DAY = 86_400_000;

let data = null;
let dayIndex = 0;
// Holds already shown, so the board can jump to the day of a new one.
const seenHolds = new Set();
const ACTORS = { agent: "Agent", owner: "Owner", paypal: "PayPal", system: "System" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) node.append(c);
  }
  return node;
}

class SignedOut extends Error {}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== "/api/login") throw new SignedOut();
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

// Run something that talks to the server; show the sign-in form or the error
// instead of failing silently.
async function attempt(fn) {
  try {
    await fn();
    notice("");
  } catch (err) {
    if (err instanceof SignedOut) {
      $("login").hidden = false;
      $("desk").hidden = true;
    } else {
      notice(err.message);
    }
  }
}

function act(path, body = {}) {
  return attempt(async () => {
    try {
      await api(path, body);
    } finally {
      await refresh();
    }
  });
}

// Venue-local time, independent of the viewer's time zone.
function local(ms) {
  const t = new Date(ms + data.state.venue.utcOffsetMinutes * MIN);
  return {
    date: t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
    time: t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }),
    dayStart: Math.floor((ms + data.state.venue.utcOffsetMinutes * MIN) / DAY) * DAY - data.state.venue.utcOffsetMinutes * MIN,
  };
}

const money = (cents) => "$" + (cents / 100).toFixed(2);

async function refresh() {
  data = await api("/api/state");
  const { state, mode, now } = data;
  const { venue } = state;

  $("venue").textContent = `${venue.name}, ${venue.city}`;
  $("clock").textContent = `${local(now).date} ${local(now).time} studio time`;
  $("login").hidden = true;
  $("desk").hidden = false;
  const badges = [
    el("span", { class: "badge " + mode.paypal }, mode.paypal === "mock" ? "PayPal: mock (no real calls)" : "PayPal: " + mode.paypal),
    el("span", { class: "badge" }, "Reader: " + mode.llm + (mode.llmUsage ? ` · ${mode.llmUsage.neurons}/${mode.llmUsage.budget} neurons today` : "")),
  ];
  if (mode.paypal !== "mock") {
    badges.splice(1, 0, el("span", { class: "badge" }, mode.webhooks === "on" ? "Webhooks: on" : "Webhooks: off (return URL + polling)"));
  }
  $("badges").replaceChildren(...badges);
  $("demo").hidden = !mode.demo;

  const samples = $("samples");
  if (data.samples.length && samples.options.length === 1) {
    samples.hidden = false;
    data.samples.forEach((s, i) => samples.append(el("option", { value: i }, s.label)));
  }

  const today = local(now).dayStart;
  for (const b of state.bookings) {
    if (b.status !== "held" || seenHolds.has(b.id)) continue;
    seenHolds.add(b.id);
    const ahead = Math.round((local(b.start).dayStart - today) / DAY);
    if (ahead >= 0 && ahead < 7) dayIndex = ahead;
  }

  drawInbox(state);
  drawDays(state, now);
  await drawBoard(state, now);
  drawBookings(state);
  drawPolicy(venue);
  drawLog(state);
}

function drawInbox(state) {
  const cards = [...state.inquiries].reverse().map((inq) => {
    const p = inq.proposal;
    const buttons = [];
    if (inq.status === "new") {
      buttons.push(el("button", { onclick: () => act(`/api/inquiries/${inq.id}/run`) }, "Run agent"));
    }
    if (inq.status === "awaiting_owner" && p) {
      if (p.kind === "refund") {
        buttons.push(el("button", { onclick: () => act(`/api/inquiries/${inq.id}/approve`) }, `Approve refund ${money(p.refundCents)}`));
      }
      p.options.forEach((slot, i) => {
        const when = `${local(slot.start).date} ${local(slot.start).time}`;
        buttons.push(el("button", { onclick: () => act(`/api/inquiries/${inq.id}/approve`, { option: i }) }, `Hold ${when}`));
      });
      if (p.kind === "alternative") {
        buttons.push(el("button", { class: "quiet", onclick: () => act(`/api/inquiries/${inq.id}/waitlist`) }, "Waitlist"));
      }
      buttons.push(el("button", { class: "quiet", onclick: () => act(`/api/inquiries/${inq.id}/decline`) }, "Decline"));
    }
    return el("article", { class: "card " + inq.status },
      el("p", { class: "meta" },
        el("span", { class: "status" }, inq.status.replace("_", " ")),
        ` ${inq.id} · ${inq.channel} · ${local(inq.receivedAt).time}`),
      el("p", { class: "message" }, inq.text),
      p && el("p", { class: "proposal" }, "Needs you: " + p.reason),
      inq.reply && el("details", { open: inq.status === "awaiting_payment" || undefined },
        el("summary", {}, "Draft reply"),
        el("pre", {}, inq.reply)),
      buttons.length ? el("p", { class: "actions" }, buttons) : null,
    );
  });
  $("inbox").replaceChildren(...cards);
}

function drawDays(state, now) {
  const today = local(now).dayStart;
  const tabs = [];
  for (let i = 0; i < 7; i++) {
    const day = today + i * DAY;
    const busy = state.bookings.filter(
      (b) => (b.status === "held" || b.status === "confirmed") && local(b.start).dayStart === day,
    ).length;
    tabs.push(el("button", {
      class: i === dayIndex ? "tab on" : "tab",
      onclick: () => { dayIndex = i; attempt(refresh); },
    }, i === 0 ? "Today" : local(day).date, busy ? el("sup", {}, String(busy)) : null));
  }
  $("days").replaceChildren(...tabs);
}

// ---- schedule board ----

let Scheduler = null;
let scheduler = null;
// Opening and closing time of the day on the board, kept current for the
// drag check below (the scheduler is built once and the day changes under it).
let boardOpen = null;
let boardClose = null;
let dragging = false;

async function loadScheduler() {
  if (Scheduler !== null) return Scheduler;
  try {
    ({ Scheduler } = await import("/vendor/scheduler/scheduler.module.js"));
  } catch {
    Scheduler = false;
  }
  return Scheduler;
}

// The board shows studio time whatever zone the viewer is in: venue wall-clock
// values are put into Dates as if they were the browser's own, and read back
// the same way after a drag.
function venueDate(ms) {
  const t = new Date(ms + data.state.venue.utcOffsetMinutes * MIN);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes());
}

function venueMs(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes())
    - data.state.venue.utcOffsetMinutes * MIN;
}

function boardEvents(state, now) {
  return state.bookings
    .filter((b) => b.status === "held" || b.status === "confirmed")
    .map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      startDate: venueDate(b.start),
      endDate: venueDate(b.end),
      name: `${b.guestName} ×${b.guests}`,
      status: b.status,
      note: b.status === "held"
        ? `held, ${Math.max(0, Math.ceil(((b.holdExpiresAt ?? now) - now) / MIN))} min left`
        : `${local(b.start).time}–${local(b.end).time}`,
      tip: `${b.id} · ${b.guestEmail} · deposit ${money(b.depositCents)}`,
    }));
}

async function drawBoard(state, now) {
  const S = await loadScheduler();
  if (!S) {
    $("board-hint").hidden = true;
    return drawPlainBoard(state, now);
  }
  const { venue } = state;
  const dayStart = local(now).dayStart + dayIndex * DAY;
  const open = dayStart + venue.openHour * 60 * MIN;
  const close = dayStart + venue.closeHour * 60 * MIN;
  const events = boardEvents(state, now);

  if (!scheduler) {
    scheduler = new S({
      appendTo: "board",
      detectCSSCompatibilityIssues: false,
      height: 190,
      rowHeight: 60,
      barMargin: 8,
      viewPreset: "hourAndDay",
      startDate: venueDate(open),
      endDate: venueDate(close),
      snap: true,
      timeResolution: { unit: "minute", increment: 30 },
      zoomOnMouseWheel: false,
      zoomOnTimeAxisDoubleClick: false,
      eventStyle: "plain",
      columns: [{ text: "Room", field: "name", width: 110 }],
      resources: venue.resources,
      events,
      features: {
        eventEdit: false,
        eventResize: false,
        eventDragCreate: false,
        eventMenu: false,
        scheduleMenu: false,
        cellMenu: false,
        scheduleTooltip: false,
        eventTooltip: { template: ({ eventRecord: e }) => e.data.tip },
        eventDrag: {
          constrainDragToResource: true,
          // Same checks the desk makes, for immediate feedback while dragging.
          validatorFn: ({ startDate, endDate }) => {
            const s = venueMs(startDate);
            const e = venueMs(endDate);
            if (s < boardOpen || e > boardClose) return { valid: false, message: "Outside opening hours" };
            if (s < data.now + venue.policy.leadMinutes * MIN) return { valid: false, message: "Too soon" };
            return true;
          },
        },
      },
      eventRenderer({ eventRecord: e, renderData }) {
        renderData.cls.add(e.data.status);
        return [{ tag: "strong", text: e.name }, { tag: "span", text: e.data.note }];
      },
      listeners: {
        eventDragStart() { dragging = true; },
        eventDragAbort() { dragging = false; },
        // The desk has the last word: it re-checks the slot and rewrites the reply.
        beforeEventDropFinalize({ context }) {
          context.async = true;
          const start = venueMs(context.startDate);
          api(`/api/bookings/${context.eventRecord.id}/move`, { start })
            .then(() => { notice(""); context.finalize(true); })
            .catch((err) => { notice(err.message); context.finalize(false); })
            .finally(() => { dragging = false; attempt(refresh); });
        },
      },
    });
  } else {
    if (boardOpen !== open) scheduler.setTimeSpan(venueDate(open), venueDate(close));
    if (!dragging) scheduler.eventStore.data = events;
  }
  boardOpen = open;
  boardClose = close;
}

// One row per resource, one column per opening hour.
function drawPlainBoard(state, now) {
  const { venue } = state;
  const dayStart = local(now).dayStart + dayIndex * DAY;
  const open = dayStart + venue.openHour * 60 * MIN;
  const span = (venue.closeHour - venue.openHour) * 60 * MIN;

  const hours = el("div", { class: "row hours" }, el("div", { class: "label" }));
  const scale = el("div", { class: "track" });
  for (let h = venue.openHour; h < venue.closeHour; h++) {
    scale.append(el("span", { style: `left:${((h - venue.openHour) * 60 * MIN / span) * 100}%` }, `${h}:00`));
  }
  hours.append(scale);

  const rows = venue.resources.map((r) => {
    const track = el("div", { class: "track" });
    for (const b of state.bookings) {
      if (b.resourceId !== r.id || b.end <= open || b.start >= open + span) continue;
      if (b.status !== "held" && b.status !== "confirmed") continue;
      const left = ((b.start - open) / span) * 100;
      const width = ((b.end - b.start) / span) * 100;
      const minutesLeft = b.holdExpiresAt ? Math.max(0, Math.ceil((b.holdExpiresAt - now) / MIN)) : 0;
      track.append(el("div", {
        class: "event " + b.status,
        style: `left:${left}%;width:${width}%`,
        title: `${b.id} · ${b.guestEmail}`,
      },
        el("strong", {}, `${b.guestName} ×${b.guests}`),
        el("span", {}, b.status === "held" ? `held, ${minutesLeft} min left` : `${local(b.start).time}–${local(b.end).time}`),
      ));
    }
    return el("div", { class: "row" }, el("div", { class: "label" }, r.name), track);
  });
  $("board").replaceChildren(hours, ...rows);
}

function drawBookings(state) {
  const rows = [...state.bookings].sort((a, b) => a.start - b.start).map((b) => {
    const paypal = [];
    if (b.status === "held" && b.approveUrl && !b.paymentPending) {
      paypal.push(el("a", { href: b.approveUrl, target: "_blank", rel: "noopener" }, "open pay link"));
    }
    if (b.orderId && !b.captureId) paypal.push(el("code", {}, " order " + b.orderId));
    if (b.captureId) paypal.push(el("code", {}, "capture " + b.captureId));
    if (b.paymentPending) paypal.push(el("span", {}, " · pending at PayPal"));
    if (b.refundedCents) paypal.push(el("span", {}, ` · refunded ${money(b.refundedCents)}`));
    return el("tr", { class: b.status },
      el("td", {}, el("code", {}, b.id)),
      el("td", {}, `${local(b.start).date} ${local(b.start).time}`),
      el("td", {}, `${b.guestName} ×${b.guests}`),
      el("td", {}, `${money(b.depositCents)} of ${money(b.totalCents)}`),
      el("td", {}, b.status),
      el("td", {}, paypal),
    );
  });
  $("bookings").querySelector("tbody").replaceChildren(...rows);
}

function drawPolicy(venue) {
  const p = venue.policy;
  const tiers = p.refundTiers.map((t) => `${t.percent}% back ${t.hoursBefore}h+ before`).join(", ");
  $("policy").replaceChildren(
    el("li", {}, `Deposit ${p.depositPercent}%, slot held ${p.holdMinutes} min while the guest pays.`),
    el("li", {}, `Holds on its own up to a ${money(p.autoHoldLimitCents)} deposit; refunds on its own up to ${money(p.autoRefundLimitCents)}.`),
    el("li", {}, `Cancellations: ${tiers}, nothing after that.`),
    el("li", {}, "Never offers a time someone else holds, and never moves a paid booking."),
  );
}

function drawLog(state) {
  const items = [...state.log].reverse().map((e) =>
    el("li", { class: e.actor },
      el("span", { class: "who" }, ACTORS[e.actor] ?? e.actor),
      el("span", { class: "muted" }, " " + local(e.at).time),
      el("p", {}, e.text),
      e.ref && el("code", {}, e.ref),
    ));
  $("log").replaceChildren(...items);
}

$("run-all").addEventListener("click", () => attempt(async () => {
  // In order, so the first guest to write gets the first claim on a slot.
  try {
    for (const inq of data.state.inquiries.filter((i) => i.status === "new")) {
      await api(`/api/inquiries/${inq.id}/run`, {});
    }
  } finally {
    await refresh();
  }
}));

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  attempt(async () => {
    await api("/api/login", { passcode: $("passcode").value });
    $("passcode").value = "";
    await refresh();
  });
});

$("samples").addEventListener("change", (e) => {
  const sample = data.samples[e.target.value];
  if (sample) $("text").value = sample.text;
  e.target.value = "";
});

$("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  await act("/api/inquiries", { text });
});

$("reset").addEventListener("click", () => act("/api/demo/reset"));
for (const b of document.querySelectorAll("[data-skip]")) {
  b.addEventListener("click", () => act("/api/demo/skip", { minutes: Number(b.dataset.skip) }));
}

await attempt(refresh);
// Payments arrive from another tab or from PayPal, so keep the view fresh.
setInterval(() => {
  if (!document.hidden && !$("desk").hidden) attempt(refresh);
}, 4000);

import { seedState } from "./seed";
import type { Store } from "./store";
import type { AppState, Booking, Inquiry, LogEntry, Venue } from "./types";

// The desk's state, one storage key per thing that changes on its own:
//
//   desk:meta        revision, demo clock offset, log counter
//   desk:venue       venue and house rules
//   desk:bk:<id>     one booking
//   desk:inq:<id>    one inquiry
//   desk:log:<seq>   one activity line
//   desk:evt:<id>    a PayPal webhook event already handled
//
// A step of work loads everything, changes it in memory and writes back only
// the keys that differ, in one transaction. The revision in desk:meta is checked
// just before the write, so two writers that started from the same state can
// never both land.

const P = "desk:";
const MAX_LOG = 300;
const MAX_EVENTS = 500;

interface Meta {
  rev: number;
  clockOffsetMs: number;
  logSeq: number;
}

export interface Loaded {
  state: AppState;
  rev: number;
  // Key -> JSON as it was read, to find out later what changed.
  snapshot: Map<string, string>;
}

export class ConflictError extends Error {
  constructor() {
    super("state changed underneath this request");
  }
}

export async function loadState(store: Store, now: number): Promise<Loaded> {
  const rows = await store.list<unknown>(P);
  if (!rows.has(P + "meta")) {
    const state = seedState(now);
    await saveState(store, { state, rev: 0, snapshot: new Map() });
    return loadState(store, now);
  }

  const snapshot = new Map<string, string>();
  const state: AppState = {
    venue: undefined as unknown as Venue,
    inquiries: [],
    bookings: [],
    log: [],
    seenEvents: [],
    clockOffsetMs: 0,
    logSeq: 0,
  };
  let rev = 0;
  for (const [key, value] of rows) {
    snapshot.set(key, JSON.stringify(value));
    const name = key.slice(P.length);
    if (name === "meta") {
      const meta = value as Meta;
      rev = meta.rev;
      state.clockOffsetMs = meta.clockOffsetMs;
      state.logSeq = meta.logSeq;
    } else if (name === "venue") state.venue = value as Venue;
    else if (name.startsWith("bk:")) state.bookings.push(value as Booking);
    else if (name.startsWith("inq:")) state.inquiries.push(value as Inquiry);
    else if (name.startsWith("log:")) state.log.push(value as LogEntry);
    else if (name.startsWith("evt:")) state.seenEvents.push(value as AppState["seenEvents"][number]);
  }
  state.bookings.sort((a, b) => a.createdAt - b.createdAt || a.start - b.start);
  state.inquiries.sort((a, b) => a.receivedAt - b.receivedAt);
  state.log.sort((a, b) => a.seq - b.seq);
  state.seenEvents.sort((a, b) => a.at - b.at);
  return { state, rev, snapshot };
}

export async function saveState(store: Store, loaded: Loaded): Promise<void> {
  const { state } = loaded;
  state.log = state.log.slice(-MAX_LOG);
  state.seenEvents = state.seenEvents.slice(-MAX_EVENTS);

  const next = new Map<string, unknown>();
  next.set(P + "venue", state.venue);
  for (const b of state.bookings) next.set(`${P}bk:${b.id}`, b);
  for (const i of state.inquiries) next.set(`${P}inq:${i.id}`, i);
  for (const e of state.log) next.set(`${P}log:${String(e.seq).padStart(9, "0")}`, e);
  for (const e of state.seenEvents) next.set(`${P}evt:${e.id}`, e);

  const puts: Record<string, unknown> = {};
  for (const [key, value] of next) {
    if (loaded.snapshot.get(key) !== JSON.stringify(value)) puts[key] = value;
  }
  const deletes = [...loaded.snapshot.keys()].filter((key) => key !== P + "meta" && !next.has(key));

  const meta: Meta = { rev: loaded.rev, clockOffsetMs: state.clockOffsetMs, logSeq: state.logSeq };
  const metaChanged = loaded.snapshot.get(P + "meta") !== JSON.stringify(meta);
  if (Object.keys(puts).length === 0 && deletes.length === 0 && !metaChanged) return;

  const current = await store.get<Meta>(P + "meta");
  if ((current?.rev ?? 0) !== loaded.rev) throw new ConflictError();
  puts[P + "meta"] = { ...meta, rev: loaded.rev + 1 };
  await store.write(puts, deletes);
}

// Start the demo over. Goes through saveState so it obeys the same revision check.
export async function resetState(store: Store, now: number): Promise<void> {
  const loaded = await loadState(store, now);
  const fresh = seedState(now);
  await saveState(store, { ...loaded, state: fresh });
}

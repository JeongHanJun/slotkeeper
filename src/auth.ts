// Owner's desk sign-in for a public demo: one shared passcode from the
// environment, exchanged for a signed, expiring cookie. Not user accounts.

const COOKIE = "sk_session";
const TTL_MS = 12 * 60 * 60 * 1000;

export async function passcodeMatches(given: string, expected: string): Promise<boolean> {
  // Compare digests so the time taken does not depend on where the strings differ.
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function sessionCookie(passcode: string, now: number, secure: boolean): Promise<string> {
  const expires = now + TTL_MS;
  const value = `${expires}.${await sign(passcode, expires)}`;
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_MS / 1000}`];
  if (secure) flags.push("Secure");
  return `${COOKIE}=${value}; ${flags.join("; ")}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function hasSession(cookieHeader: string | null, passcode: string, now: number): Promise<boolean> {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + "="))
    ?.slice(COOKIE.length + 1);
  if (!value) return false;
  const [expires, mac] = value.split(".");
  const until = Number(expires);
  if (!mac || !Number.isFinite(until) || until < now) return false;
  return passcodeMatches(mac, await sign(passcode, until));
}

// Changing the passcode invalidates every cookie signed with the old one.
async function sign(passcode: string, expires: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`slotkeeper-session|${expires}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Fixed-window counter per caller. Lives in memory, which inside a Durable
// Object means one counter for the whole desk.
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  allow(key: string, limit: number, windowMs: number, now: number): boolean {
    if (this.windows.size > 5000) {
      for (const [k, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= limit;
  }
}

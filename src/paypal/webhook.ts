// Checking that a webhook delivery was signed by PayPal, without calling PayPal.
//
// PayPal signs the text "<transmission id>|<transmission time>|<webhook id>|<crc32 of body>"
// with RSA-SHA256 and names the certificate in a header. The CRC is taken over
// the raw bytes received and written in decimal.

export interface Transmission {
  id: string;
  time: string;
  sig: string;
  algo: string;
  certUrl: string;
}

export function readTransmission(headers: Headers): Transmission | undefined {
  const t = {
    id: headers.get("paypal-transmission-id"),
    time: headers.get("paypal-transmission-time"),
    sig: headers.get("paypal-transmission-sig"),
    algo: headers.get("paypal-auth-algo"),
    certUrl: headers.get("paypal-cert-url"),
  };
  if (!t.id || !t.time || !t.sig || !t.algo || !t.certUrl) return undefined;
  return t as Transmission;
}

// The certificate must come from PayPal itself; otherwise anyone could sign
// with their own key and point us at their own certificate.
export function trustedCertUrl(certUrl: string, sandbox: boolean): boolean {
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return false;
  }
  const host = sandbox ? "api.sandbox.paypal.com" : "api.paypal.com";
  return url.protocol === "https:" && url.hostname === host && url.pathname.startsWith("/v1/notifications/certs/");
}

export function signedMessage(t: Transmission, webhookId: string, rawBody: string): string {
  return `${t.id}|${t.time}|${webhookId}|${crc32(new TextEncoder().encode(rawBody))}`;
}

export async function verifyWithCertificate(
  t: Transmission,
  webhookId: string,
  rawBody: string,
  certPem: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    spkiFromCertificate(certPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return verifyWithKey(key, t, webhookId, rawBody);
}

export async function verifyWithKey(
  key: CryptoKey,
  t: Transmission,
  webhookId: string,
  rawBody: string,
): Promise<boolean> {
  if (t.algo !== "SHA256withRSA") return false;
  let sig: Uint8Array;
  try {
    sig = fromBase64(t.sig);
  } catch {
    return false;
  }
  const message = new TextEncoder().encode(signedMessage(t, webhookId, rawBody));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, message);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// WebCrypto imports public keys, not certificates, so cut the
// SubjectPublicKeyInfo out of the X.509 structure:
//   Certificate ::= SEQUENCE { tbsCertificate SEQUENCE {
//     [0] version, serial, signature, issuer, validity, subject, subjectPublicKeyInfo, ... } ... }
export function spkiFromCertificate(pem: string): Uint8Array {
  const block = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!block) throw new Error("not a PEM certificate");
  const der = fromBase64(block[1]!.replace(/\s+/g, ""));

  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.start);
  let at = tbs.start;
  let field = readTlv(der, at);
  if (field.tag === 0xa0) {
    at = field.end;
    field = readTlv(der, at);
  }
  // Skip serial, signature algorithm, issuer, validity and subject.
  for (let i = 0; i < 5; i++) {
    at = field.end;
    field = readTlv(der, at);
  }
  if (field.tag !== 0x30) throw new Error("unexpected certificate layout");
  return der.slice(at, field.end);
}

function readTlv(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = der[at];
  let length = der[at + 1];
  if (tag === undefined || length === undefined) throw new Error("truncated certificate");
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error("unsupported length in certificate");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (der[start + i] ?? 0);
    start += count;
  }
  const end = start + length;
  if (end > der.length) throw new Error("truncated certificate");
  return { tag, start, end };
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

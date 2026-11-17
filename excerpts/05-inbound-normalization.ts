// EXCERPT 05 — Defensive normalization of inbound WhatsApp webhook payloads.
//
// What this shows: the payload shape is not trusted. Pure functions, no I/O, no imports:
//   · Two payload shapes are accepted (the full webhook body, or just the `value` that a relay
//     forwards), and delivery `statuses` (delivered / read) are ignored: they are not messages.
//   · The user identifier falls back from phone to a username-based id, because users who enable
//     WhatsApp usernames arrive without a phone number.
//   · A message with no id or no sender cannot be de-duplicated or attributed, so it is COUNTED as
//     discarded instead of vanishing silently (the counter is returned to the caller).
//   · The provider timestamp is rejected if it is implausible (before 2020, or more than a minute in
//     the future); the database then uses its own clock. A late webhook retry must not stretch the
//     24-hour messaging window that reminders are measured against.
// Source: the pure-logic module of the production webhook (trimmed, translated from Spanish).
// Omitted: media-id extraction and the per-status notices.

export type Incoming = {
  wamid: string;          // provider message id: the idempotency key
  waId: string;           // phone or username-based id
  type: string;
  content: string | null;
  sentAt: string | null;  // ISO, or null if not trustworthy
};

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : null);
const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** One `value` per change, or the body itself if it already comes without `entry`. */
export function valuesOf(body: unknown): Obj[] {
  const b = obj(body);
  if (!b) return [];
  if (!Array.isArray(b.entry)) return [b];
  return list(b.entry).flatMap((e) => list(obj(e)?.changes).map((c) => obj(obj(c)?.value)).filter((v): v is Obj => v !== null));
}

export function identifier(message: Obj, contacts: unknown[]): string | null {
  const direct = str(message.from) ?? str(message.from_user_id);
  if (direct) return direct;
  const c = obj(contacts[0]);
  return str(c?.wa_id) ?? str(c?.user_id);
}

/** The provider sends seconds since 1970 as text. Anything implausible becomes null. */
export function messageDate(timestamp: unknown, nowMs: number): string | null {
  const s = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Number(timestamp) : NaN;
  if (!Number.isFinite(s)) return null;
  const ms = s * 1000;
  if (ms < Date.UTC(2020, 0, 1) || ms > nowMs + 60_000) return null;
  return new Date(ms).toISOString();
}

export function extractIncoming(body: unknown, nowMs: number): { incoming: Incoming[]; discarded: number } {
  const incoming: Incoming[] = [];
  let discarded = 0;
  for (const value of valuesOf(body)) {
    const contacts = list(value.contacts);
    for (const m of list(value.messages)) {          // `statuses` live elsewhere and are never read
      const message = obj(m);
      const wamid = message ? str(message.id) : null;
      const waId = message ? identifier(message, contacts) : null;
      if (!message || !wamid || !waId) { discarded++; continue; }
      const type = str(message.type) ?? "unknown";
      incoming.push({
        wamid, waId, type,
        content: type === "text" ? str(obj(message.text)?.body) : null,
        sentAt: messageDate(message.timestamp, nowMs),
      });
    }
  }
  return { incoming, discarded };
}

// EXCERPT 03 — Deterministic message handling around one model call.
//
// What this shows: what to do with an incoming text is decided by CODE, not by the model.
//   · `decide()` classifies the message (confirm / cancel / "no" / correction / new entry) from the
//     text and from whether a pending estimate exists. Confirmations are deliberately strict:
//     "yes, but it was 3 eggs" is a correction, not a confirmation (any extra word or any number
//     turns it into one).
//   · Estimates are saved as PENDING and only count once the user confirms. Corrections replace the
//     pending one (the model sees both and returns the complete corrected estimate).
//   · The pipeline order matters: quota first, then model, then validation, then save. A failed or
//     implausible estimate never consumes a pending slot and never reaches the database.
//   · `handleActive()` never throws: every failure becomes a friendly message plus a log line that
//     has the user id but never the phone number or the text.
//   · All state transitions are RPCs (see 04-pending-and-quota.sql); this layer only calls them,
//     and receives them as injected dependencies so the whole cycle is tested with `node --test`
//     without a database or a model.
// Source: the text-handling and active-user modules of the production webhook (heavily trimmed,
// translated; RPC names simplified). Omitted: audio and photo branches, profile commands, reports, milestone messages,
// event logging, and the full message texts. The vocabulary below is Spanish in production (the
// product speaks Spanish); a small English set is shown instead.

// ── How the user's text is understood ───────────────────────────────────────────────
const words = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[✅👍👌❌]/gu, " $& ").replace(/[.,;:!¡¿?()"“”]+/g, " ").split(/\s+/).filter(Boolean);

const CONFIRM = new Set(["yes", "ok", "okay", "yep", "correct", "right", "confirm", "done", "✅", "👍", "👌"]);
const FILLER = new Set(["and", "that", "is", "it", "thanks", "all", "the", "so"]);
const CANCEL = new Set(["cancel", "discard", "delete", "forget", "❌"]);
const hasNumber = (ps: string[]) => ps.some((p) => /\d/.test(p));

export function isConfirmation(text: string): boolean {
  const ps = words(text);
  if (ps.length === 0 || ps.length > 5 || hasNumber(ps)) return false;
  return ps.some((p) => CONFIRM.has(p)) && ps.every((p) => CONFIRM.has(p) || FILLER.has(p));
}
export function isCancellation(text: string): boolean {
  const ps = words(text);
  return ps.length > 0 && ps.length <= 4 && !hasNumber(ps) && ps.some((p) => CANCEL.has(p));
}
/** A short bare "no" means "that's wrong" but has not said what is right yet. */
export function isBareNo(text: string): boolean {
  const ps = words(text);
  return ps.length > 0 && ps.length <= 3 && !hasNumber(ps) && ps[0] === "no";
}

export type Action = "confirm" | "cancel" | "ask_correction" | "correct" | "nothing_pending" | "estimate";

export function decide(text: string, hasPending: boolean): Action {
  const confirms = isConfirmation(text), cancels = isCancellation(text), no = isBareNo(text);
  if (hasPending) {
    if (confirms) return "confirm";
    if (cancels) return "cancel";
    if (no) return "ask_correction";
    return "correct";
  }
  // With nothing pending, a lone "yes" or "no" has nothing to refer to.
  return confirms || cancels || no ? "nothing_pending" : "estimate";
}

// ── The cycle ───────────────────────────────────────────────────────────────────────
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
type Estimator = (text: string, pending: unknown | null) => Promise<{ ok: true; data: unknown } | { ok: false; detail: string }>;
type Deps = { rpc: Rpc; estimate: Estimator; log: (m: string) => void };
declare function validateEstimate(raw: unknown): { ok: true; e: any } | { ok: false; reason: string }; // see 01-estimation-contract.ts

const firstRow = (data: unknown) => (Array.isArray(data) && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, any>) : null);

export async function handleActive(d: Deps, userId: string, text: string): Promise<string> {
  try {
    const pend = await d.rpc("get_pending_entry", { p_user: userId }); // also sweeps entries older than 3 h
    if (pend.error) { d.log(`get_pending_entry failed (user ${userId}): ${pend.error.message}`); return "😅 Something went wrong, can you try again?"; }
    const pending = firstRow(pend.data);

    switch (decide(text, pending !== null)) {
      case "nothing_pending": return "Nothing pending to confirm 🙂 Tell me what you ate or drank.";
      case "ask_correction":  return "Got it 👍 What is the correction? Or say «cancel» to discard it.";
      case "confirm":
      case "cancel": {
        const action = decide(text, true) === "confirm" ? "confirm" : "cancel";
        const r = await d.rpc("resolve_pending_entry", { p_user: userId, p_action: action }); // atomic
        const done = firstRow(r.data);
        if (r.error || !done) return "Nothing pending to confirm 🙂"; // expired, or another message resolved it first
        return action === "cancel" ? "Discarded 👍 Nothing was recorded." : `✅ Recorded: ${done.description}`;
      }
      default: { // estimate | correct
        // 1) Quota BEFORE spending a model call (see 04-pending-and-quota.sql).
        const q = firstRow((await d.rpc("reserve_estimate", { p_user: userId, p_kind: "text" })).data);
        if (!q || typeof q.allowed !== "boolean") return "😅 Something went wrong, can you try again?";
        if (!q.allowed) return "You reached today's estimate limit. You can still confirm or cancel what is pending.";

        // 2) Model. With a pending entry it is a correction: the model sees the previous estimate.
        const ia = await d.estimate(text, pending);
        if (!ia.ok) { d.log(`Estimate failed (user ${userId}): ${ia.detail}`); return "😅 I could not analyze that. Can you write it again?"; }

        // 3) Validate with code; the schema alone does not make the numbers sensible.
        const v = validateEstimate(ia.data);
        if (!v.ok) { d.log(`Invalid estimate (user ${userId}): ${v.reason}`); return "That does not look right 🤔 Can you write it again, with amounts?"; }
        if (v.e.type === "none") return pending ? "I could not apply that to your pending entry 🤔" : "I did not get that as food or water 🤔";

        // 4) Save as PENDING (replaces the previous one). Meal type, if not said, is decided by the DB.
        const g = await d.rpc("save_pending_entry", { p_user: userId, p_estimate: v.e });
        if (g.error) { d.log(`save_pending_entry failed (user ${userId}): ${g.error.message}`); return "😅 Something went wrong, can you try again?"; }
        return `I detected: ${v.e.description} — ${v.e.calories} kcal. Reply ✅ to confirm, write a correction, or «cancel».`;
      }
    }
  } catch (err) {
    d.log(`Unexpected error for user ${userId}: ${String((err as Error).message).slice(0, 300)}`);
    return "😅 Something went wrong, can you try again?";
  }
}

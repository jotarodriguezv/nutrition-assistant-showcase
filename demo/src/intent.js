// ── HOW THE USER'S TEXT IS UNDERSTOOD (deterministic, no model) ────────────────────────
// What to do with a message is decided by code from the text and from whether something is pending.

const words = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[✅👍👌❌]/gu, " $& ").replace(/[.,;:!?()"]+/g, " ").split(/\s+/).filter(Boolean);

const CONFIRM = new Set(["yes", "ok", "okay", "yep", "correct", "right", "confirm", "done", "✅", "👍", "👌"]);
const FILLER = new Set(["and", "that", "is", "it", "thanks", "all", "the", "so"]);
const CANCEL = new Set(["cancel", "discard", "delete", "forget", "❌"]);
const hasNumber = (ps) => ps.some((p) => /\d/.test(p));

// "yes", "ok", "✅"... but NOT "yes, but it was 3 eggs": any extra word or any number makes it a correction.
export function isConfirmation(text) {
  const ps = words(text);
  if (ps.length === 0 || ps.length > 5 || hasNumber(ps)) return false;
  return ps.some((p) => CONFIRM.has(p)) && ps.every((p) => CONFIRM.has(p) || FILLER.has(p));
}
export function isCancellation(text) {
  const ps = words(text);
  return ps.length > 0 && ps.length <= 4 && !hasNumber(ps) && ps.some((p) => CANCEL.has(p));
}
/** A short bare "no" means "that is wrong" without saying what is right. */
export function isBareNo(text) {
  const ps = words(text);
  return ps.length > 0 && ps.length <= 3 && !hasNumber(ps) && ps[0] === "no";
}

export function command(text) {
  const t = words(text).join(" ");
  if (t === "help") return "help";
  if (t === "report" || t === "today") return "report";
  return null;
}

/** → confirm | cancel | ask_correction | correct | nothing_pending | estimate */
export function decide(text, hasPending) {
  const confirms = isConfirmation(text), cancels = isCancellation(text), no = isBareNo(text);
  if (hasPending) {
    if (confirms) return "confirm";
    if (cancels) return "cancel";
    if (no) return "ask_correction";
    return "correct";
  }
  return confirms || cancels || no ? "nothing_pending" : "estimate";
}

// ── ONE MESSAGE → ONE REPLY ─────────────────────────────────────────────────────────────
// Order of operations: commands → pending lookup → deterministic decision → (quota → model →
// validation → save pending). A failed or implausible estimate never reaches the store.
// Never throws: every failure becomes a friendly message plus a log line (user id, never the text).

import { command, decide } from "./intent.js";
import { validateEstimate } from "./estimate.js";
import { GOALS } from "./store.js";

const MILESTONE_TEXT = {
  50: "🔥 You are halfway to your daily goal!",
  75: "🔥 75% of your daily goal. Almost there!",
  100: "🎉 You reached your daily calorie goal!",
};

const publicEstimate = (p) => p && { type: p.type, description: p.description, calories: p.calories, protein_g: p.protein_g, carbs_g: p.carbs_g, fat_g: p.fat_g, water_ml: p.water_ml };

const describe = (e) =>
  e.type === "water"
    ? `💧 ${e.description}: ${e.water_ml} ml`
    : `🍽️ ${e.description}: ${e.calories} kcal (P ${e.protein_g} g, C ${e.carbs_g} g, F ${e.fat_g} g)`;

const FOOTER = "Reply ✅ to confirm, write a correction ✏️, or «cancel» to discard it.";

export async function handleMessage({ store, userId, text, estimate, log = console.error }) {
  try {
    const cmd = command(text);
    if (cmd === "help") return { reply: "Tell me what you ate or drank (text only in this demo). Say «report» for today's totals.", action: "help" };
    if (cmd === "report") {
      const t = store.today(userId);
      return { reply: `Today: ${t.calories}/${GOALS.calories} kcal · P ${t.protein_g} g · C ${t.carbs_g} g · F ${t.fat_g} g · 💧 ${t.water_ml}/${GOALS.water_ml} ml`, action: "report" };
    }

    const pending = store.getPending(userId);
    const action = decide(text, pending !== null);

    switch (action) {
      case "nothing_pending":
        return { reply: "Nothing pending to confirm 🙂 Tell me what you ate or drank.", action };
      case "ask_correction":
        return { reply: "Got it 👍 What is the correction? Or say «cancel» to discard it.", action };
      case "confirm":
      case "cancel": {
        const done = store.resolvePending(userId, action);
        if (!done) return { reply: "Nothing pending to confirm 🙂", action }; // expired, or resolved a moment ago
        if (action === "cancel") return { reply: "Discarded 👍 Nothing was recorded.", action };
        const hito = done.milestone ? `\n\n${MILESTONE_TEXT[done.milestone]}` : "";
        return { reply: `✅ Recorded! ${describe(done.entry)}${hito}`, action, milestone: done.milestone };
      }
      default: { // estimate | correct
        // 1) Quota BEFORE spending a model call.
        const q = store.reserveEstimate(userId);
        if (!q.allowed) return { reply: "You reached today's estimate limit. You can still confirm or cancel what is pending.", action: "limit" };

        // 2) Model. With a pending entry it is a correction: the model sees the previous estimate.
        const ia = await estimate(text, action === "correct" ? publicEstimate(pending) : null);
        if (!ia.ok) {
          log(`Estimate failed (user ${userId}): ${ia.detail}`);
          return { reply: "😅 I could not analyze that. Can you write it again?", action: "error" };
        }

        // 3) Validate with code.
        const v = validateEstimate(ia.data);
        if (!v.ok) {
          log(`Invalid estimate (user ${userId}): ${v.reason}`);
          return { reply: "That does not look right 🤔 Can you write it again, with amounts?", action: "invalid" };
        }
        if (v.e.type === "none") {
          return { reply: pending ? `I could not apply that to your pending entry 🤔\n${FOOTER}` : "I did not get that as food or water 🤔 Try «two eggs and toast». Say «help» for commands.", action: "none" };
        }

        // 4) Save as PENDING (replaces the previous one).
        store.savePending(userId, v.e);
        return { reply: `I detected:\n${describe(v.e)}\n\n${FOOTER}`, action };
      }
    }
  } catch (err) {
    log(`Unexpected error (user ${userId}): ${String(err?.message).slice(0, 300)}`);
    return { reply: "😅 Something went wrong, can you try again?", action: "error" };
  }
}

// ── IN-MEMORY STORE ─────────────────────────────────────────────────────────────────────
// Stands in for Postgres. The rules are the same ones the production database enforces:
//   · one pending entry per user, replaced by the next estimate, expiring after 3 hours;
//   · only CONFIRMED entries count towards the day;
//   · the meal type is the user's word, else decided here from the user's clock (never by the model);
//   · a daily quota is consumed BEFORE calling the model;
//   · milestones (50 / 75 / 100 % of the calorie goal): when a confirmation crosses several at once,
//     only the highest is announced, once.

export const GOALS = { calories: 2000, water_ml: 2000 }; // fictional user
const PENDING_TTL_MS = 3 * 60 * 60 * 1000;
const MILESTONES = [50, 75, 100];

export function createStore({ now = () => new Date(), timeZone = "UTC", dailyLimit = 30 } = {}) {
  const users = new Map();
  const user = (id) => {
    if (!users.has(id)) users.set(id, { pending: null, entries: [], usage: new Map() });
    return users.get(id);
  };
  const localDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(d); // YYYY-MM-DD
  const localHour = (d) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(d));

  const mealByClock = (hour) => (hour >= 4 && hour < 9 ? "breakfast" : hour >= 11 && hour < 14 ? "lunch" : hour >= 18 && hour < 20 ? "dinner" : null);

  const totals = (u, day) => {
    const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 0 };
    for (const e of u.entries) if (e.day === day) for (const k of Object.keys(t)) t[k] += e[k];
    return t;
  };

  return {
    /** Also sweeps an expired entry, like the database function does. */
    getPending(id) {
      const u = user(id);
      if (u.pending && now() - u.pending.createdAt > PENDING_TTL_MS) u.pending = null;
      return u.pending;
    },
    /** Replaces the previous pending entry. */
    savePending(id, estimate) {
      const u = user(id);
      const at = now();
      const meal_type = estimate.type === "food" ? estimate.meal_type ?? mealByClock(localHour(at)) : null;
      u.pending = { ...estimate, meal_type, createdAt: at.getTime() };
      return u.pending;
    },
    /** → { entry, milestone } | null (nothing pending: expired or already resolved). */
    resolvePending(id, action) {
      const u = user(id);
      const entry = this.getPending(id);
      if (!entry) return null;
      u.pending = null;
      if (action === "cancel") return { entry, milestone: null };
      const day = localDay(now());
      const before = totals(u, day).calories;
      u.entries.push({ ...entry, day });
      const pct = (c) => (c / GOALS.calories) * 100;
      const crossed = MILESTONES.filter((m) => pct(before) < m && pct(before + entry.calories) >= m);
      return { entry, milestone: crossed.length ? Math.max(...crossed) : null };
    },
    /** Atomic in the database; trivially so here. Consumes one unit of today's quota. */
    reserveEstimate(id) {
      const u = user(id);
      const day = localDay(now());
      const used = u.usage.get(day) ?? 0;
      if (used >= dailyLimit) return { allowed: false, used, limit: dailyLimit };
      u.usage.set(day, used + 1);
      return { allowed: true, used: used + 1, limit: dailyLimit };
    },
    today(id) {
      return totals(user(id), localDay(now()));
    },
    entries(id) {
      return user(id).entries;
    },
  };
}

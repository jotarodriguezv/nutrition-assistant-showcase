// EXCERPT 06 — The webhook entrypoint: authenticate, de-duplicate, answer 200, work in background.
//
// What this shows:
//   · The function is deployed without JWT (the anon key is public), so the caller must present a
//     shared secret. It is validated INSIDE the database against a vault-stored value, so the secret
//     never has to live in application code.
//   · Idempotency: every inbound message is upserted with `ignoreDuplicates` on the provider message
//     id, so a retry by the provider (or by the relay in front of it) inserts nothing and is
//     counted as a duplicate instead of being answered twice.
//   · The HTTP response goes out immediately; the replies are produced in the background
//     (`EdgeRuntime.waitUntil`) because a model call takes seconds and the provider does not wait.
//   · Fail closed: a kill switch (`responder`) decides whether the system may reply at all. If the
//     settings cannot be read, it behaves as OFF. In "shadow mode" (OFF) it records messages of known
//     users and does nothing else: no replies, no user creation, no model calls. That is how the new
//     system ran side by side with the old n8n workflow before the cut-over.
//   · No phone numbers or message text in logs: the internal user id is enough.
// Source: the handler of the production webhook (heavily trimmed, translated). Omitted: the
// registration flow, status notices, per-type task queue, and the dependency factory.
// Note on webhook security: this function does NOT verify the provider's own request signature. In this
// deployment the provider's webhook reaches a relay, and only the relay (which holds the shared secret
// above) can call this function. Verifying the provider signature at the edge is a separate concern
// and is not shown here.

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
declare const supabase: any; // service-role client, injected by the adapter
declare function extractIncoming(body: unknown, nowMs: number): { incoming: { wamid: string; waId: string; type: string; content: string | null; sentAt: string | null }[]; discarded: number };
declare function inBackground(tasks: unknown[]): Promise<void>; // sends replies; never throws

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // 1) Authenticate: compare the secret inside the database.
  const secret = req.headers.get("x-relay-secret");
  if (!secret) return new Response("Unauthorized", { status: 401 });
  const { data: ok } = await supabase.rpc("validate_relay_secret", { p_value: secret });
  if (ok !== true) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => null);
  if (body === null) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const { incoming, discarded } = extractIncoming(body, Date.now());
  const total = { received: incoming.length, new: 0, duplicates: 0, unknown: 0, discarded };

  // 2) Fail closed: if the settings cannot be read, act as if replies were OFF.
  const { data: settings } = await supabase.from("settings").select("reply_enabled").maybeSingle();
  const replyEnabled = settings?.reply_enabled === true;

  const tasks: unknown[] = [];
  for (const m of incoming) {
    const { data: user } = await supabase.from("users").select("id, status").eq("wa_id", m.waId).maybeSingle();
    if (!user && !replyEnabled) { total.unknown++; continue; }        // shadow mode creates nobody

    // 3) Idempotency: the unique provider message id decides. No row inserted → duplicate.
    const row: Record<string, unknown> = { user_id: user?.id, wamid: m.wamid, direction: "inbound", type: m.type, content: m.content };
    if (m.sentAt) row.created_at = m.sentAt;                          // when the USER wrote, not when we processed
    const { data: inserted, error } = await supabase.from("messages")
      .upsert(row, { onConflict: "wamid", ignoreDuplicates: true }).select("id");
    if (error) return Response.json({ error: error.message, ...total }, { status: 500 });
    if (!inserted || inserted.length === 0) { total.duplicates++; continue; }
    total.new++;

    if (user?.status === "active" && replyEnabled) tasks.push({ user, text: m.content });
  }

  // 4) Answer now; the work continues after the response.
  if (tasks.length > 0) EdgeRuntime.waitUntil(inBackground(tasks));
  return Response.json(total);
}

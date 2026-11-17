// EXCERPT 02 — Calling the model: strict structured output, errors as values, voice-note guard.
//
// What this shows:
//   · One function asks the model for JSON that matches a strict schema. It NEVER throws: every
//     failure (timeout, HTTP error, refusal, empty content, invalid JSON) comes back as
//     `{ ok: false, detail }`, so the caller always has something to answer the user with.
//   · The detail that goes to logs contains neither the user's message nor the API key.
//   · Token usage is recorded best-effort: a failure to record it must never fail the user's request.
//   · Speech-to-text models invent subtitle-like phrases when given silence or noise. In a rehearsal,
//     a voice note with no speech came back as a "subtitles by the community" credit and was shown
//     to the user as if they had said it. A short, deliberately conservative filter treats those as
//     "no speech": better to let one odd phrase through than to discard something the user said.
// Source: the shared OpenAI module of the production functions (trimmed and translated from Spanish).
// Omitted: the multipart audio upload, image input, and the list of language-specific phrases
// (only English-style examples are kept here).

export type ModelConfig = { apiKey: string; model: string };
export type TokenUsage = { input: number; output: number };
export type RecordUsage = (usage: TokenUsage) => Promise<void>;

export type JsonResult =
  | { ok: true; data: unknown }
  // No user message and no key in here: this goes to the logs.
  | { ok: false; detail: string };

export const MODEL_TIMEOUT_MS = 30_000;

export async function askForJson(
  cfg: ModelConfig,
  req: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    /** Low by default: the same dish should get the same estimate, not creativity. `null` omits the
     *  parameter (newer reasoning models reject it). */
    temperature?: number | null;
  },
  fetchFn: typeof fetch = fetch,
  recordUsage?: RecordUsage,
): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        ...(req.temperature === null ? {} : { temperature: req.temperature ?? 0.2 }),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return { ok: false, detail: timedOut ? "Model did not answer in time" : String(e.message).slice(0, 200) };
  }

  const body = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
    error?: { message?: string; code?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const u = body?.usage;
  if (recordUsage && Number.isSafeInteger(u?.prompt_tokens) && Number.isSafeInteger(u?.completion_tokens)
      && u!.prompt_tokens! >= 0 && u!.completion_tokens! >= 0) {
    try {
      await recordUsage({ input: u!.prompt_tokens!, output: u!.completion_tokens! });
    } catch {
      console.error("Could not record model usage"); // never fail the request over bookkeeping
    }
  }

  if (!res.ok) {
    return { ok: false, detail: `OpenAI ${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim().slice(0, 300) };
  }
  const message = body?.choices?.[0]?.message;
  if (message?.refusal) return { ok: false, detail: "The model refused to answer" };
  if (!message?.content) return { ok: false, detail: "Model answered without content" };
  try {
    return { ok: true, data: JSON.parse(message.content) };
  } catch {
    return { ok: false, detail: "Model did not return valid JSON" };
  }
}

/**
 * Speech-to-text hallucination on silence. The list is short and conservative on purpose.
 * The last pattern only counts when it is the WHOLE text: "thanks for watching my photo" could be real.
 */
export function looksLikeSilenceHallucination(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/amara\.org|subtitles? (made )?by|subtitled by/.test(t)) return true;
  return /^(thanks for watching( this)?( video)?|subscribe( to the channel)?|see you next time)\.?$/.test(t);
}

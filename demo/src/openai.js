// ── THE MODEL CALL: STRICT STRUCTURED OUTPUT, ERRORS AS VALUES ───────────────────────────
// Never throws. Every failure (timeout, HTTP error, refusal, empty content, invalid JSON) comes back
// as { ok: false, detail }, so the caller always has something to answer the user with.
// The detail contains neither the user's message nor the key (it goes to the logs).

import OpenAI from "openai";
import { SCHEMA, SCHEMA_NAME, SYSTEM_PROMPT, userMessage } from "./estimate.js";

export function createEstimator({ apiKey, model, baseURL, timeoutMs = 30_000 }) {
  const client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 1 });

  /** (text, pending|null) → { ok: true, data } | { ok: false, detail } */
  return async (text, pending) => {
    let res;
    try {
      res = await client.chat.completions.create({
        model,
        temperature: 0.2, // the same dish should get the same estimate, not creativity
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage(text, pending) },
        ],
        response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: true, schema: SCHEMA } },
      });
    } catch (err) {
      const timedOut = err?.name === "APIConnectionTimeoutError";
      return { ok: false, detail: timedOut ? "Model did not answer in time" : `OpenAI ${err?.status ?? ""} ${String(err?.message ?? "").slice(0, 200)}`.trim() };
    }
    const message = res.choices?.[0]?.message;
    if (message?.refusal) return { ok: false, detail: "The model refused to answer" };
    if (!message?.content) return { ok: false, detail: "Model answered without content" };
    try {
      return { ok: true, data: JSON.parse(message.content) };
    } catch {
      return { ok: false, detail: "Model did not return valid JSON" };
    }
  };
}

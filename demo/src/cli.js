// CLI: write what you ate or drank, then confirm, correct or cancel the pending estimate.
//   report  today's totals     help  commands     /state  raw store     /reset  start over     /exit  quit

import readline from "node:readline/promises";
import { handleMessage } from "./agent.js";
import { createEstimator } from "./openai.js";
import { createStore } from "./store.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and fill it in, or export the variable.");
  process.exit(1);
}

const estimate = createEstimator({
  apiKey,
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});
let store = createStore();
const USER = "demo-user";

console.log("Nutrition tracker demo (fictional user, text only). Try: «two scrambled eggs and a slice of toast». /state, /reset, /exit\n");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you > " });
rl.prompt();

// for-await keeps working when input is piped (a loop of rl.question() drops buffered lines)
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "/exit") break;
  if (line === "/reset") { store = createStore(); console.log("  session reset"); }
  else if (line === "/state") {
    console.log("  pending:", JSON.stringify(store.getPending(USER)));
    console.log("  confirmed entries:", store.entries(USER).length, "| today:", JSON.stringify(store.today(USER)));
  } else if (line) {
    const r = await handleMessage({ store, userId: USER, text: line, estimate });
    console.log(`bot > ${r.reply}`);
    console.log(`  [action=${r.action}]`);
  }
  rl.prompt();
}
rl.close();

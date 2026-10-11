// Preloaded (node --import) into a smoke-test MCP server with Jev enabled.
// Answers every TypeSafe/Jev request locally, so the real server's wiring runs
// end to end without the network. Everything else goes to the real fetch.
// Each request body is appended to $FAKE_JEV_LOG, one JSON line per call.
//
// ANY request to a typesafe.ai host is intercepted, not just the exact
// JEV_URL: a test must never reach the real service. A typesafe.ai request
// that is not the known endpoint is logged as {"unexpected": url} and fails
// with a 599, so a drifted URL goes red instead of leaking to the network.
import fs from "node:fs";
import { isTypesafe, urlOf } from "./typesafe-host.mjs";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const realFetch = globalThis.fetch;

const log = (line) => {
  if (process.env.FAKE_JEV_LOG) fs.appendFileSync(process.env.FAKE_JEV_LOG, JSON.stringify(line) + "\n");
};
globalThis.fetch = async (input, init) => {
  const url = urlOf(input);
  if (!isTypesafe(url)) return realFetch(input, init);
  if (url !== JEV_URL) {
    log({ unexpected: url });
    return new Response("fake-jev: unexpected typesafe.ai URL", { status: 599 });
  }
  const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
  const body = JSON.parse(raw);
  log(body);
  const answers = {};
  for (const k of Object.keys(body.questions ?? {})) {
    if (k.startsWith("same_")) answers[k] = { noul: 0.95 }; // same subject
    else if (k.startsWith("both_")) answers[k] = { noul: 0.05 }; // cannot both hold
    else if (k.startsWith("rel_")) answers[k] = { score: 2 }; // directly answers
    else if (k.startsWith("pair_")) answers[k] = { choice: "conflicting", confidence: 0.9 };
    else answers[k] = { noul: 0.9 }; // miss judge: results do contain the answer
  }
  return new Response(JSON.stringify({ answers, model: "fake-jev" }), { status: 200, headers: { "content-type": "application/json" } });
};

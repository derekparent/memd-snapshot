// vitest setupFile: no test may reach the real TypeSafe service.
//
// Unit tests inject opts.fetch, but one that forgets would fall through to the
// real globalThis.fetch, and a developer shell may hold a live
// TYPESAFE_API_KEY. So in every test worker:
//  - any fetch to a typesafe.ai host throws before the network (askJev fails
//    open on a throw, so the product path sees "no answer", never a real one);
//    each blocked URL is recorded for tests to assert on;
//  - MEMD_JEV and TYPESAFE_API_KEY are removed from process.env, so a CLI or
//    server a test spawns with {...process.env} cannot inherit a live key.
//    Tests that need Jev on pass their own env explicitly.
import { isTypesafe, urlOf } from "../fixtures/typesafe-host.mjs";

export const blockedTypesafe: string[] = [];
(globalThis as any).__blockedTypesafe = blockedTypesafe;

delete process.env.MEMD_JEV;
delete process.env.TYPESAFE_API_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = urlOf(input);
  if (isTypesafe(url)) {
    blockedTypesafe.push(url);
    throw new Error(`test guard: blocked a request to ${url}; inject opts.fetch or use test/fixtures/fake-jev.mjs`);
  }
  return realFetch(input, init);
}) as typeof fetch;

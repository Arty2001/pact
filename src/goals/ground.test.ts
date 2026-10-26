import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ground, needsGrounding, queryFor, shape } from "./ground.ts";

/**
 * Grounding a target that the sentence did not state.
 *
 * The thing worth testing is restraint. This runs on every goal anyone
 * writes, so searching when it should not costs a credit and a second of
 * latency each time - and worse, overriding a number the person already gave
 * would have Pact hold someone to a figure they did not choose.
 */

describe("needsGrounding", () => {
  it("leaves a stated number alone", () => {
    assert.equal(needsGrounding("do 20 squats every day"), false);
    assert.equal(needsGrounding("read for 30 minutes"), false);
  });

  it("recognises numbers written as words", () => {
    // "do ten squats" and "do 10 squats" are the same instruction and only
    // one of them has a digit in it.
    assert.equal(needsGrounding("do ten squats every day"), false);
    assert.equal(needsGrounding("read for half an hour"), false);
    assert.equal(needsGrounding("floss twice"), true, "twice is not in the list, and that is fine");
  });

  it("grounds a sentence that names no quantity", () => {
    assert.equal(needsGrounding("do some squats every day"), true);
    assert.equal(needsGrounding("stop watching youtube shorts so much"), true);
    assert.equal(needsGrounding("drink more water"), true);
  });
});

describe("queryFor", () => {
  it("asks the question a person would type", () => {
    const q = queryFor("I want to do some squats every day please");
    assert.match(q, /^how many /);
    assert.match(q, /squats/);
    // The filler is what makes a raw-sentence search return blog posts about
    // the phrasing rather than guideline pages.
    assert.doesNotMatch(q, /\b(want|please|every ?day)\b/);
  });

  it("never produces an empty query", () => {
    // Every word stripped: the fallback has to be the sentence itself, or
    // Tavily is asked "how many  per day" and answers about nothing.
    const q = queryFor("I want to every day please");
    assert.match(q, /\S/);
    assert.ok(q.length > "how many  per day recommended guideline".length - 1);
  });
});

describe("shape", () => {
  it("prefers Tavily's own answer to a snippet", () => {
    const g = shape({
      answer: "Most guidelines suggest 20 to 30 squats daily for beginners.",
      results: [{ title: "NHS strength guidance", url: "https://example.org/a", content: "snippet" }],
    });
    assert.match(g?.summary ?? "", /20 to 30/);
    assert.equal(g?.sources[0]?.url, "https://example.org/a");
  });

  it("falls back to the best result's content when there is no answer", () => {
    const g = shape({
      results: [{ title: "Guidance", url: "https://example.org/a", content: "about 25 a day" }],
    });
    assert.equal(g?.summary, "about 25 a day");
  });

  it("returns null rather than a source that says nothing", () => {
    // An empty summary with a live URL is the worst outcome: the planner
    // would cite a page that did not inform the number at all.
    assert.equal(shape({ results: [{ title: "T", url: "https://example.org/a" }] }), null);
    assert.equal(shape({ answer: "something", results: [] }), null);
    assert.equal(shape({}), null);
  });

  it("drops results with no usable url", () => {
    const g = shape({
      answer: "guidance",
      results: [{ title: "No url" }, { title: "Good", url: "https://example.org/b" }] as never,
    });
    assert.equal(g?.sources.length, 1);
    assert.equal(g?.sources[0]?.url, "https://example.org/b");
  });

  it("caps the summary so it cannot crowd out the planner's rules", () => {
    const g = shape({ answer: "x".repeat(5000), results: [{ title: "T", url: "https://e.org/a" }] });
    assert.ok((g?.summary.length ?? 0) <= 600);
  });
});

describe("ground", () => {
  it("degrades to null on a failed search rather than throwing", async () => {
    // A goal must never be lost because a third-party index had a bad
    // minute. Without grounding the planner picks a number, which is exactly
    // the behaviour that existed before this file.
    const boom = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    assert.equal(await ground("tvly-x", "do some squats", boom), null);

    const refused = (() =>
      Promise.resolve(new Response("nope", { status: 429 }))) as unknown as typeof fetch;
    assert.equal(await ground("tvly-x", "do some squats", refused), null);
  });

  it("sends a bearer token and the shaped query", async () => {
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const spy = ((url: string, init: RequestInit) => {
      seen = {
        url,
        auth: new Headers(init.headers).get("Authorization"),
        body: JSON.parse(String(init.body)),
      };
      return Promise.resolve(
        Response.json({
          answer: "20 to 30 a day",
          results: [{ title: "Guide", url: "https://example.org/a" }],
        }),
      );
    }) as unknown as typeof fetch;

    const g = await ground("tvly-secret", "do some squats every day", spy);
    assert.equal(seen!.url, "https://api.tavily.com/search");
    assert.equal(seen!.auth, "Bearer tvly-secret");
    assert.match(String(seen!.body.query), /squats/);
    assert.equal(seen!.body.max_results, 3);
    assert.equal(g?.summary, "20 to 30 a day");
  });
});

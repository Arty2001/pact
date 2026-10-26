/**
 * Where a target number came from.
 *
 * Pact's whole claim is that it does not take your word for whether something
 * happened - a camera confirms it. That claim sits oddly beside a target the
 * system invented. Say "do some squats every day" and the planner has to pick
 * a number; with nothing to go on it picks one that sounds plausible, and
 * then holds you to it with a straight face. Proving you hit a figure nobody
 * can source is a more subtle kind of lying than not checking at all.
 *
 * So when the sentence carries no number, the number is looked up and the
 * goal keeps the source. A person can then disagree with the guidance rather
 * than with Pact, which is the right argument to be having.
 *
 * Only when the sentence has no number. "Ten squats" means ten; searching
 * the web to second-guess somebody's own stated intention would be both
 * useless and rude.
 */

const API = "https://api.tavily.com/search";

export interface Grounding {
  /** One or two sentences of guidance, for the planner's prompt. */
  summary: string;
  /** Where it came from, newest-authority first. Shown on the goal. */
  sources: Array<{ title: string; url: string }>;
}

/**
 * Whether this sentence needs a number found for it.
 *
 * Digits and the small written numbers, because "do ten squats" and "do 10
 * squats" are the same instruction and only one of them contains a digit.
 * Erring toward NOT searching: a wrong search costs a credit and a second of
 * latency on every goal anyone ever writes, while a missed one costs a
 * number the planner would have invented anyway.
 */
export function needsGrounding(sentence: string): boolean {
  if (/\d/.test(sentence)) return false;
  return !/\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|half|an hour|a minute)\b/i.test(
    sentence,
  );
}

/**
 * The search to run for a goal sentence.
 *
 * Phrased as the question a person would actually type, because that is what
 * a search index is good at. "How much/many ... recommended per day" pulls
 * guideline pages; pasting the raw sentence pulls blog posts about the
 * phrasing. The filler is stripped so "I want to start doing squats every
 * day please" becomes a query about squats rather than about wanting things.
 */
export function queryFor(sentence: string): string {
  const subject = sentence
    .toLowerCase()
    .replace(
      /\b(i|want|to|would|like|need|should|start|starting|try|trying|please|my|me|get|make|sure|every ?day|daily|each day|a day|everyday)\b/g,
      " ",
    )
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `how many ${subject || sentence.trim()} per day recommended guideline`;
}

/**
 * Ask Tavily for guidance on a goal with no number in it.
 *
 * Returns null rather than throwing on anything at all. A search that fails
 * must degrade to the behaviour that existed before it: the planner picks a
 * number and the goal carries no source. Taking a goal away from somebody
 * because a third-party index had a bad minute would be a far worse bug than
 * an unsourced target.
 */
export async function ground(
  apiKey: string,
  sentence: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Grounding | null> {
  try {
    const res = await fetchImpl(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: queryFor(sentence),
        // `advanced` costs more credits for pages this does not need. The
        // answer is the useful part and it is cheap to ask for.
        search_depth: "basic",
        include_answer: "basic",
        // Three is enough to cite and few enough to read. The planner's
        // prompt is already long and every extra result crowds out the
        // instructions that make the rest of the plan correct.
        max_results: 3,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return shape(body);
  } catch {
    return null;
  }
}

/**
 * The useful half of a Tavily response.
 *
 * Separate and pure so the trimming is testable without a network call. The
 * summary is capped because it lands in a system prompt beside instructions
 * that matter more: a search result allowed to run long starts to outweigh
 * the rules it was meant to inform.
 */
export function shape(body: {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}): Grounding | null {
  const results = (body.results ?? []).filter(
    (r): r is { title: string; url: string; content?: string } =>
      typeof r.url === "string" && r.url.length > 0 && typeof r.title === "string",
  );
  // Tavily's own answer when there is one, else the best result's snippet.
  // An empty summary is worse than no grounding at all - it would have the
  // planner cite a source that says nothing.
  const summary = (body.answer ?? results[0]?.content ?? "").trim().slice(0, 600);
  if (!summary || results.length === 0) return null;
  return {
    summary,
    sources: results.slice(0, 3).map((r) => ({ title: r.title.slice(0, 120), url: r.url })),
  };
}

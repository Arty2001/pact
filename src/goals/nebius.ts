/**
 * Nebius Token Factory client.
 *
 * OpenAI-compatible, so this is deliberately thin: a base URL, a bearer
 * token, and one method. What it adds is the two things that are easy to get
 * wrong against these particular models.
 *
 * The first is `max_tokens`. Nemotron spends on the order of a hundred
 * tokens reasoning before it answers, and that reasoning is counted against
 * the same budget. Set the budget too low and the call returns successfully
 * with empty `content` - not an error, not a wrong answer, just nothing,
 * which looks exactly like a network failure and sends you debugging the
 * wrong layer. The floor here is not a tuning choice.
 *
 * The second is that the reasoning arrives in its own field. Reading only
 * `content` is right for the answer, but when `content` is empty the
 * reasoning is the only evidence of what happened, so it is surfaced rather
 * than dropped.
 *
 * Model ids come from the live catalogue rather than the documentation:
 * every id in Nebius's own examples is decommissioned, including the one in
 * their quickstart, so copying from the docs gives a 404 on the model field.
 */

const BASE = "https://api.tokenfactory.nebius.com/v1";

/**
 * Below this, reasoning eats the whole budget and `content` comes back
 * empty. 512 is the floor, not the target.
 */
const MIN_MAX_TOKENS = 512;

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Completion {
  content: string;
  /** Why it answered the way it did. Empty content plus this is a budget problem. */
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { prompt: number; completion: number; reasoning: number };
}

export class Nebius {
  constructor(private apiKey: string) {}

  async chat(opts: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Tool[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<Completion> {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: opts.tools ? "auto" : undefined,
        max_tokens: Math.max(opts.maxTokens ?? 2048, MIN_MAX_TOKENS),
        temperature: opts.temperature ?? 0.2,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Nebius ${res.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: Record<string, number>;
    };

    const message = body.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      try {
        toolCalls.push({ name, args: JSON.parse(call.function?.arguments ?? "{}") });
      } catch {
        // A tool call we cannot parse is worse than none: acting on half an
        // object would write a malformed skill into the ledger.
      }
    }

    const usage = body.usage ?? {};
    return {
      content: message.content ?? "",
      reasoning: message.reasoning_content ?? "",
      toolCalls,
      usage: {
        prompt: usage.prompt_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        reasoning: usage.reasoning_tokens ?? 0,
      },
    };
  }
}

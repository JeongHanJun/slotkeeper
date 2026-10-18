import type { Store } from "../store";
import { ModelLlm, UNDERSTANDING_SCHEMA } from "./model";
import type { Usage } from "./types";

// Workers AI through the Worker's `AI` binding, behind a daily spend cap.
//
// Workers AI bills in "neurons" (10,000 a day are free on the account). The
// cap below counts what this desk spends in a day and refuses calls past the
// budget; the agent then reads with the rules and answers with the templates,
// so the desk keeps working, just less politely.

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Prices {
  // Neurons per million tokens, from the Workers AI pricing page for the model.
  neuronsPerMInput: number;
  neuronsPerMOutput: number;
  dailyBudget: number;
}

interface SpendRecord {
  day: string;
  calls: number;
  neurons: number;
}

const SPEND_KEY = "llm:spend";
const MAX_OUTPUT_TOKENS = 400;

const roughTokens = (s: string) => Math.ceil(s.length / 3.2);

export function pricesFromEnv(env: Record<string, unknown>): Prices {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d;
  };
  // Defaults are for @cf/meta/llama-3.3-70b-instruct-fp8-fast at 11 µ$ a neuron.
  return {
    neuronsPerMInput: n("LLM_NEURONS_PER_M_INPUT", 26_364),
    neuronsPerMOutput: n("LLM_NEURONS_PER_M_OUTPUT", 204_545),
    dailyBudget: n("DAILY_NEURON_BUDGET", 2_000),
  };
}

export class WorkersAiLlm extends ModelLlm {
  readonly name: string;

  constructor(
    private ai: AiBinding,
    private model: string,
    private store: Store,
    private prices: Prices,
    private clock: () => number = () => Date.now(),
  ) {
    super();
    this.name = model.replace(/^@cf\//, "");
  }

  private day(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  private async spend(): Promise<SpendRecord> {
    const rec = await this.store.get<SpendRecord>(SPEND_KEY);
    return rec && rec.day === this.day() ? rec : { day: this.day(), calls: 0, neurons: 0 };
  }

  private neurons(inputTokens: number, outputTokens: number): number {
    return (inputTokens * this.prices.neuronsPerMInput + outputTokens * this.prices.neuronsPerMOutput) / 1_000_000;
  }

  async usage(): Promise<Usage> {
    const s = await this.spend();
    return { day: s.day, calls: s.calls, neurons: Math.round(s.neurons), budget: this.prices.dailyBudget };
  }

  protected async chat(system: string, user: string, json: boolean): Promise<string> {
    const before = await this.spend();
    const estimate = this.neurons(roughTokens(system) + roughTokens(user), MAX_OUTPUT_TOKENS);
    if (before.neurons + estimate > this.prices.dailyBudget) throw new Error("over today's model budget");

    const out = (await this.ai.run(this.model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      ...(json ? { response_format: { type: "json_schema", json_schema: UNDERSTANDING_SCHEMA } } : {}),
    })) as {
      response?: unknown;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // Workers AI answers with `response`; in JSON mode it may already be an object.
    const text =
      typeof out?.response === "string"
        ? out.response
        : out?.response && typeof out.response === "object"
          ? JSON.stringify(out.response)
          : (out?.choices?.[0]?.message?.content ?? "");

    const inTok = Number(out?.usage?.prompt_tokens) || roughTokens(system) + roughTokens(user);
    const outTok = Number(out?.usage?.completion_tokens) || roughTokens(text);
    const after = await this.spend();
    await this.store.put<SpendRecord>(SPEND_KEY, {
      day: after.day,
      calls: after.calls + 1,
      neurons: after.neurons + this.neurons(inTok, outTok),
    });
    return text;
  }
}

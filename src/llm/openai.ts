import { ModelLlm } from "./model";

// Optional real model behind any OpenAI-compatible /chat/completions endpoint.

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAiLlm extends ModelLlm {
  readonly name: string;

  constructor(private cfg: OpenAiConfig) {
    super();
    this.name = cfg.model;
  }

  protected async chat(system: string, user: string, json: boolean): Promise<string> {
    const res = await fetch(this.cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

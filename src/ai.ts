// Workers AI: rewrite title + meta description from the audited page's own signals.
import type { PageSignals } from "./audit";

export interface AiSuggestion {
  title: string;
  metaDescription: string;
  model: string;
}

export async function suggestMeta(ai: Ai, model: string, s: PageSignals): Promise<AiSuggestion> {
  const context = [
    `URL: ${s.finalUrl}`,
    `Current title: ${s.title || "(none)"}`,
    `Current meta description: ${s.metaDescription || "(none)"}`,
    `H1: ${s.h1[0] || "(none)"}`,
    `Schema types: ${s.schemaTypes.join(", ") || "(none)"}`,
  ].join("\n");

  const out = (await ai.run(model as keyof AiModels, {
    messages: [
      {
        role: "system",
        content:
          "You are a senior SEO copywriter. Return ONLY compact JSON: " +
          '{"title":"...","metaDescription":"..."}. Title 50-60 characters, primary keyword first, brand last if obvious. ' +
          "Meta description 140-155 characters, specific benefit and a call to action. No quotes inside values, no emojis.",
      },
      { role: "user", content: context },
    ],
    max_tokens: 200,
    temperature: 0.4,
  } as never)) as { response?: string };

  const text = out.response || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model returned no JSON");
  const parsed = JSON.parse(match[0]) as { title?: string; metaDescription?: string };

  return {
    title: (parsed.title || "").trim(),
    metaDescription: (parsed.metaDescription || "").trim(),
    model,
  };
}

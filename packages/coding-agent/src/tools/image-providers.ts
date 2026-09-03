/**
 * Image Generation Providers
 *
 * Leaf module (no runtime deps) shared by the image_gen tool, the settings
 * schema, and settings migrations — mirrors `web/search/types.ts` so the
 * provider list, auto order, and settings choices never drift apart.
 */

/** Image generation backends, in settings/tool vocabulary. */
export type ImageProvider = "antigravity" | "deepinfra" | "gemini" | "openai" | "openai-codex" | "openrouter" | "xai";

/** Auto-resolution fallback order when no configured entry or session provider matches. */
export const AUTO_IMAGE_PROVIDER_ORDER: readonly ImageProvider[] = [
	"openai",
	"openai-codex",
	"antigravity",
	"xai",
	"openrouter",
	"gemini",
	"deepinfra",
];

/** Settings choices for `providers.imageOrder` (labels shared with the retired single-preference enum). */
export const IMAGE_PROVIDER_CHOICES = [
	{
		value: "openai",
		label: "OpenAI",
		description: "OPENAI_API_KEY (gpt-image-2) or active GPT model; falls back to a connected Codex subscription",
	},
	{
		value: "openai-codex",
		label: "OpenAI Codex (ChatGPT)",
		description: "Uses a connected Codex / ChatGPT subscription — no OPENAI_API_KEY needed",
	},
	{
		value: "antigravity",
		label: "Antigravity",
		description: "Requires google-antigravity OAuth",
	},
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "Requires xAI Grok OAuth or XAI_API_KEY",
	},
	{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
	{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
	{ value: "deepinfra", label: "DeepInfra", description: "Requires DEEPINFRA_API_KEY" },
] as const satisfies ReadonlyArray<{ value: ImageProvider; label: string; description: string }>;

export function isImageProviderId(value: unknown): value is ImageProvider {
	return typeof value === "string" && AUTO_IMAGE_PROVIDER_ORDER.includes(value as ImageProvider);
}

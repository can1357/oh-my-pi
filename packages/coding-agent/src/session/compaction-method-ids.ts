/**
 * Compaction method ids, their settings labels, and the default fallback order. Dependency-free:
 * the settings store (`config/settings-store.ts`), which runs in the daemon, migrates legacy
 * compaction settings with {@link DEFAULT_COMPACTION_METHOD_ORDER}.
 */

/** Choices presented by the ordered compaction-method setting. */
export const COMPACTION_METHOD_CHOICES = [
	{
		value: "remote",
		label: "Server compaction",
		description:
			"Use provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta, including on Bedrock) when the active route supports it",
	},
	{
		value: "snapcompact",
		label: "Snapcompact",
		description: "Archive history onto dense bitmap images the active vision model reads back; no LLM call",
	},
	{
		value: "handoff",
		label: "Handoff",
		description: "Generate a handoff document and continue from it as the compaction summary",
	},
	{
		value: "soft",
		label: "Soft compaction",
		description: "Summarize in place with a compaction model without using server compaction",
	},
	{
		value: "shake",
		label: "Shake",
		description: "Drop recoverable heavy content in place without an LLM call",
	},
] as const;

/** One selectable automatic context-maintenance method. */
export type CompactionMethod = (typeof COMPACTION_METHOD_CHOICES)[number]["value"];

/** Default fallback order: server-native first, portable summary last. */
export const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = [
	"remote",
	"snapcompact",
	"handoff",
	"shake",
	"soft",
];

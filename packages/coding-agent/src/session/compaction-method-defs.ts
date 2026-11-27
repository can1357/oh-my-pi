/** Pure compaction-method choices and default order shared by settings and compaction runtime. */

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

const COMPACTION_METHODS: Record<CompactionMethod, true> = {
	remote: true,
	snapcompact: true,
	handoff: true,
	soft: true,
	shake: true,
};

/** Whether an unknown configuration value names a supported compaction method. */
export function isCompactionMethod(value: unknown): value is CompactionMethod {
	return typeof value === "string" && Object.hasOwn(COMPACTION_METHODS, value);
}

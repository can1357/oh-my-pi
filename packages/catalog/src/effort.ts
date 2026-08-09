/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

/**
 * Anthropic thinking-budget ladder. The wire accepts any `budget_tokens` a
 * model's maxTokens can contain, so this is the standard ladder shared by the
 * transport (stream) and provider wire layers.
 */
export const ANTHROPIC_THINKING: Record<Effort, number> = {
	[Effort.Minimal]: 1024,
	[Effort.Low]: 4096,
	[Effort.Medium]: 8192,
	[Effort.High]: 16384,
	[Effort.XHigh]: 32768,
	[Effort.Max]: 32768,
};

/** Provider metadata needed to resolve append-only context mode. */
export interface AppendOnlyContextModel {
	provider: string;
	baseUrl: string;
	/** Verbatim sparse compat config (explicit user intent), never the resolved record. */
	compatConfig?: object;
}

function shouldAutoEnableAppendOnlyContext(model: AppendOnlyContextModel | null | undefined): boolean {
	if (!model) return false;
	// Byte-stable prefixes benefit every provider: explicit prefix caches
	// (DeepSeek, SGLang/Xiaomi, llama.cpp-family local servers) require them,
	// Anthropic cache_control breakpoints hit at a higher rate with them, and
	// OpenAI-family automatic prompt caching keys on them. The manager degrades
	// safely when history is rewritten (digest detection resets the log), so
	// auto now means every provider; opt out with provider.appendOnlyContext
	// "off". Add providers here ONLY if append-only mode is actively harmful
	// for them (none known).
	return true;
}

/** Resolves whether append-only context should be active for a model and setting. */
export function shouldEnableAppendOnlyContext(
	setting: "auto" | "on" | "off" | undefined,
	model: AppendOnlyContextModel | null | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return shouldAutoEnableAppendOnlyContext(model);
	}
}

/** One entry of a `{model substring: value}` setting, pattern lowercased. */
export interface ModelPatternEntry<T> {
	readonly patternLower: string;
	readonly value: T;
}

/**
 * Compiles a `{model substring: value}` setting for {@link matchModelPattern}: patterns are
 * lowercased and ordered longest first, so the most specific key wins whatever the config order
 * (a record merged from global and project config does not keep author order). Equal lengths keep
 * key order. Values `normalize` maps to `undefined` are dropped.
 */
export function compileModelPatterns<V, T>(
	record: Readonly<Record<string, V>>,
	normalize: (value: V) => T | undefined,
): ModelPatternEntry<T>[] {
	const entries: ModelPatternEntry<T>[] = [];
	for (const pattern in record) {
		const value = normalize(record[pattern]);
		if (value !== undefined) entries.push({ patternLower: pattern.toLowerCase(), value });
	}
	// Array#sort is stable, so equal-length patterns keep key order.
	return entries.sort((a, b) => b.patternLower.length - a.patternLower.length);
}

/** Value of the longest compiled pattern occurring in `model` (case-insensitive). */
export function matchModelPattern<T>(
	entries: readonly ModelPatternEntry<T>[],
	model: string | undefined,
): T | undefined {
	if (!model) return undefined;
	const modelLower = model.toLowerCase();
	return entries.find(entry => modelLower.includes(entry.patternLower))?.value;
}

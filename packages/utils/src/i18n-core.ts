export type Messages = Readonly<Record<string, string>>;

function placeholders(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(/\{(\d+)\}/g), match => match[1]));
}

/** Context distinguishes identical English messages used with different meanings. */
export function englishSource(key: string): string {
	const separator = key.indexOf("\u0004");
	return separator < 0 ? key : key.slice(0, separator);
}

/** An absent message falls back to English; translated text may omit English plural suffixes. */
export function createTranslator(messages: unknown): (source: string, ...values: string[]) => string {
	if (typeof messages !== "object" || messages === null || Array.isArray(messages)) {
		throw new Error("Language pack must be a JSON object mapping English messages to translations.");
	}
	for (const [source, translated] of Object.entries(messages)) {
		// Arguments are dense even when English omits an earlier language-specific value.
		const maxIndex = [...placeholders(englishSource(source))].reduce(
			(max, index) => Math.max(max, Number(index)),
			-1,
		);
		if (
			typeof translated !== "string" ||
			[...placeholders(translated)].some(index => !Number.isSafeInteger(Number(index)) || Number(index) > maxIndex)
		) {
			throw new Error(`Invalid language-pack entry (text or placeholders): ${JSON.stringify(source)}`);
		}
	}
	const catalog = messages as Messages;
	return (source, ...values) => {
		const text = Object.hasOwn(catalog, source) ? catalog[source] : englishSource(source);
		if (values.length === 0) return text;
		return text.replace(/\{(\d+)\}/g, (placeholder, index: string) => values[Number(index)] ?? placeholder);
	};
}

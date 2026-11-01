export type Translator = (source: string, ...values: string[]) => string;

/** Context names meanings, not call sites, and is never displayed to users. */
export function englishSource(key: string): string {
	const separator = key.indexOf("\u0004");
	return separator < 0 ? key : key.slice(0, separator);
}

/**
 * Creates an isolated translator without environment access or I/O.
 * Numeric placeholders may be reordered, repeated, or omitted by translations.
 * Their indexes must be safe integers in the English source's argument range.
 * Missing messages use English; missing values retain their placeholder.
 */
export function createTranslator(messages: unknown): Translator {
	if (typeof messages !== "object" || messages === null || Array.isArray(messages)) {
		throw new Error("Language pack must be an object mapping English messages to translations.");
	}
	// Snapshot validated entries so a caller cannot mutate the pack after validation.
	const catalog = new Map<string, string>();
	for (const [source, translated] of Object.entries(messages)) {
		let maxIndex = -1;
		for (const match of englishSource(source).matchAll(/\{(\d+)\}/g)) {
			const index = Number(match[1]);
			if (!Number.isSafeInteger(index)) {
				throw new Error(`Invalid source placeholder: ${JSON.stringify(source)}`);
			}
			maxIndex = Math.max(maxIndex, index);
		}
		if (typeof translated !== "string") {
			throw new Error(`Invalid language-pack text: ${JSON.stringify(source)}`);
		}
		for (const match of translated.matchAll(/\{(\d+)\}/g)) {
			const index = Number(match[1]);
			if (!Number.isSafeInteger(index) || index > maxIndex) {
				throw new Error(`Invalid language-pack placeholder: ${JSON.stringify(source)}`);
			}
		}
		catalog.set(source, translated);
	}
	return (source, ...values) => {
		const text = catalog.get(source) ?? englishSource(source);
		if (values.length === 0) return text;
		return text.replace(/\{(\d+)\}/g, (placeholder, index: string) => values[Number(index)] ?? placeholder);
	};
}

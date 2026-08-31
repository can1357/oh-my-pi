type JsonRecord = Record<string, unknown>;

function goJsonString(value: string): string {
	return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** Serialize a JSON-compatible value using Go's UTF-8 object-key ordering. */
export function stableJson(value: unknown): string {
	if (typeof value === "string") return goJsonString(value);
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value as JsonRecord)
		.map(([key, entry]) => ({ key, entry, bytes: Buffer.from(key) }))
		.sort((left, right) => left.bytes.compare(right.bytes));
	return `{${entries.map(({ key, entry }) => `${goJsonString(key)}:${stableJson(entry)}`).join(",")}}`;
}

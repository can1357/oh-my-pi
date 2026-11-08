/** Validate local intent identity at RPC and SDK submission boundaries. */
export function assertClientMessageId(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) {
		throw new Error("clientMessageId must be a nonempty string of at most 128 characters");
	}
}

export function assertClientMessageIds(value: unknown): asserts value is readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		throw new Error("clientMessageIds must contain between 1 and 32 unique IDs");
	}
	for (const id of value) assertClientMessageId(id);
	if (new Set(value).size !== value.length) throw new Error("clientMessageIds must be unique");
}

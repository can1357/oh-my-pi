/** Recognize explicit upstream failures without rejecting new vendor finish reasons. */
export function getNativeFinishReasonError(nativeFinishReason: unknown): string | undefined {
	if (typeof nativeFinishReason !== "string") return undefined;
	switch (nativeFinishReason.toUpperCase()) {
		case "MALFORMED_RESPONSE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "NETWORK_ERROR":
			return `Provider returned error (native_finish_reason: ${nativeFinishReason})`;
		default:
			return undefined;
	}
}

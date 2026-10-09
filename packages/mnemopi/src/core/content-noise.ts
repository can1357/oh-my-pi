const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;

/** Remove retention framing before content quality decisions, embeddings, or recall display. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CONTENT_CHAR = /[\p{L}\p{N}]/u;
const CHITCHAT = /^(?:(?:hi|hello|hey|hello there|good morning|good afternoon|good evening|good night|bye|goodbye|see you|thanks|thank you|thanks a lot|thank you very much|you're welcome|you are welcome|no problem|ok|okay|yes|no|yep|yeah|sure|alright|all right|got it|understood|sounds good|agreed|great|perfect|done|how are you|i'm fine|i am fine|selam|merhaba|gunaydin|iyi gunler|iyi aksamlar|iyi geceler|gorusuruz|hosca kal|hoscakal|tesekkurler|tesekkur ederim|cok tesekkurler|cok tesekkur ederim|sag ol|sagol|rica ederim|tamam|peki|evet|hayir|olur|anladim|aynen|harika|super|bitti|nasilsin|nasilsiniz|iyiyim)(?:\s+|$))+$/u;
const ADDRESSED_GREETING = /^(?:hi|hello|hey|selam|merhaba)\s+[\p{L}]{1,32}$/u;
const HELP_GREETING = /^(?:how can i help(?: you)?(?: today)?|how may i help(?: you)?|what can i do for you(?: today)?|size nasil yardimci olabilirim|sana nasil yardimci olabilirim|nasil yardimci olabilirim)$/u;

/** Conservative TR/EN chitchat rejection: unknown content is retained, not guessed away. */
export function hasRetainableContent(content: string): boolean {
	if (!CONTENT_CHAR.test(content)) return false;
	for (const sentence of stripRetentionProtocolMarkers(content).split(/[.!?;\n]+/u)) {
		const normalized = sentence
			.normalize("NFKD")
			.toLowerCase()
			.replace(/\p{M}/gu, "")
			.replace(/ı/g, "i")
			.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F]/gu, "")
			.replace(/[‘’]/g, "'")
			.replace(/[,，:]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!CONTENT_CHAR.test(normalized)) continue;
		if (normalized.length > 160) return true;
		if (!CHITCHAT.test(normalized) && !ADDRESSED_GREETING.test(normalized) && !HELP_GREETING.test(normalized)) {
			return true;
		}
	}
	return false;
}

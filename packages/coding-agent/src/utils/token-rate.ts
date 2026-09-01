/**
 * Token-throughput calculator shared by the status line (main session tok/s
 * badge) and the vibe worker aggregation ({@link aggregateVibeWorkerTokensPerSecond}).
 * Lives in `utils/` so neither the render layer nor the vibe runtime has to
 * depend on the other for a pure arithmetic helper.
 */
const MIN_DURATION_MS = 100;

type AssistantUsage = {
	output: number;
};

type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	ttft?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	ttft?: number;
	usage?: {
		output?: number;
	};
};

export type CalculateTokensPerSecondOptions = {
	/**
	 * Exclude time-to-first-token from the denominator so the rate reflects
	 * generation-only throughput (the initial latency before the first token
	 * is not counted). Falls back to the full duration when the message has
	 * no usable TTFT or the subtraction would leave less than
	 * {@link MIN_DURATION_MS}.
	 */
	excludeTtft?: boolean;
};

function isAssistantMessage(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
	options?: CalculateTokensPerSecondOptions,
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const outputTokens = assistant.usage.output;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	if (resolvedDurationMs === null || resolvedDurationMs < MIN_DURATION_MS) return null;

	let denominatorMs = resolvedDurationMs;
	if (options?.excludeTtft) {
		const ttftMs = assistant.ttft;
		if (typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs > 0) {
			const generationMs = resolvedDurationMs - ttftMs;
			// Only honor TTFT when it leaves a measurable generation window;
			// otherwise keep the full duration so the rate stays sane.
			if (generationMs >= MIN_DURATION_MS) {
				denominatorMs = generationMs;
			}
		}
	}

	const tokensPerSecond = (outputTokens * 1000) / denominatorMs;
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

	return tokensPerSecond;
}

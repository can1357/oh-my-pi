import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai";
import { isContextOverflow } from "@pk-nerdsaver-ai/pi-ai/error";

/** Current date in the "Mon Jan 15, 2024" format used across the prompts. */
export function getTodayStr(now: Date = new Date()): string {
	const day = now.toLocaleDateString("en-US", { weekday: "short" });
	const month = now.toLocaleDateString("en-US", { month: "short" });
	return `${day} ${month} ${now.getDate()}, ${now.getFullYear()}`;
}

/** True when a failed completion indicates the model's context/token limit was exceeded. */
export function isTokenLimitExceeded(message: AssistantMessage, contextWindow?: number | null): boolean {
	return isContextOverflow(message, contextWindow ?? undefined);
}

/** Throw when a completion came back as a provider error instead of content. */
export function assertCompletionOk(message: AssistantMessage): void {
	if (message.stopReason === "error") {
		throw new DeepResearchCompletionError(message.errorMessage ?? "Model request failed", message);
	}
}

/** Error wrapping a failed completion, keeping the assistant message for overflow checks. */
export class DeepResearchCompletionError extends Error {
	readonly message_: AssistantMessage;
	constructor(text: string, message: AssistantMessage) {
		super(text);
		this.name = "DeepResearchCompletionError";
		this.message_ = message;
	}
}

/** Recover the AssistantMessage from an error thrown by assertCompletionOk, if any. */
export function completionErrorMessage(error: unknown): AssistantMessage | undefined {
	if (error instanceof DeepResearchCompletionError) return error.message_;
	return undefined;
}

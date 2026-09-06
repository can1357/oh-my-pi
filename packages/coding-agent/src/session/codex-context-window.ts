import { calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	Context,
	DeveloperMessage,
	EncryptedContent,
	ImageContent,
	Message,
	TextContent,
} from "@oh-my-pi/pi-ai";
import type { CodexContextWindowIdentity } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { CodexContextWindows } from "@oh-my-pi/pi-catalog/types";
import { compile } from "@oh-my-pi/pi-utils/prompt";
import remainingTemplate from "../prompts/system/codex-context-remaining.md" with { type: "text" };
import contextTemplate from "../prompts/system/codex-context-window.md" with { type: "text" };
import guidanceTemplate from "../prompts/system/codex-context-window-guidance.md" with { type: "text" };
import cancelledText from "../prompts/system/new-context-cancelled.md" with { type: "text" };

const renderRemaining = compile(remainingTemplate);
const renderContext = compile(contextTemplate);
const renderGuidance = compile(guidanceTemplate);

/** Tools the reset protocol must own itself: the checkpoint writes and the reset. */
export const WINDOW_RESET_CONTROL_TOOLS: ReadonlySet<string> = new Set([
	"notes.write_file",
	"notes.append_to_file",
	"new_context",
]);

/** Stable source-entry references; only the outgoing projection gets the suffix. */
export function appendCodexHistoryItemId(message: Message, id: string | undefined): Message {
	if (!id || message.role === "assistant") return message;
	const marker = `[id: ${id}]`;
	if (message.role === "toolResult") return { ...message, content: appendMarker(message.content, marker) };
	if (typeof message.content === "string") {
		return message.content.endsWith(marker) ? message : { ...message, content: `${message.content}\n${marker}` };
	}
	return { ...message, content: appendMarker(message.content, marker) };
}

function appendMarker<T extends TextContent | ImageContent | EncryptedContent>(
	parts: T[],
	marker: string,
): (T | TextContent)[] {
	const index = parts.findLastIndex(block => block.type === "text");
	const last = parts[index];
	if (last?.type === "text" && last.text.endsWith(marker)) return parts;
	const content: (T | TextContent)[] = [...parts];
	if (last?.type === "text") content[index] = { ...last, text: `${last.text}\n${marker}` };
	else content.push({ type: "text", text: marker });
	return content;
}

/** Per-window claims. Callers persist generated developer items in the normal journal. */
export class CodexContextWindowProtocol {
	#windowId?: string;
	#remaining?: number;
	#lastResponse?: AssistantMessage;
	#reminderClaimed = false;
	#fallbackClaimed = false;
	#fallbackDelivered = false;
	#fallbackResponses = 0;
	#fallbackFailed = false;
	#staticContext?: { key: string; messages: DeveloperMessage[] };

	constructor(readonly agentName: string) {}

	get remaining(): number | undefined {
		return this.#remaining;
	}
	get fallbackPending(): boolean {
		return this.#fallbackClaimed && !this.#fallbackFailed;
	}
	get fallbackFailed(): boolean {
		return this.#fallbackFailed;
	}
	get resetAllowed(): boolean {
		return !this.#fallbackDelivered || (!this.#fallbackFailed && this.#fallbackResponses === 2);
	}

	reset(identity: CodexContextWindowIdentity): void {
		if (this.#windowId === identity.windowId) return;
		this.#windowId = identity.windowId;
		this.#remaining = undefined;
		this.#lastResponse = undefined;
		this.#reminderClaimed = false;
		this.#fallbackClaimed = false;
		this.#fallbackDelivered = false;
		this.#fallbackResponses = 0;
		this.#fallbackFailed = false;
		this.#staticContext = undefined;
	}

	remainingText(): string {
		return renderRemaining({ remaining: this.#remaining ?? "unknown" }).trimEnd();
	}

	/** A failed or missing notes result is not a checkpoint. */
	observe(
		message: AssistantMessage,
		effectiveLimit: number,
		policy: CodexContextWindows,
		checkpointCompleted?: (toolCallId: string) => boolean,
	): DeveloperMessage[] {
		if (message === this.#lastResponse || message.stopReason === "error" || message.stopReason === "aborted")
			return [];
		this.#lastResponse = message;
		if (this.#fallbackDelivered) {
			this.#fallbackResponses++;
			const calls = message.content.filter(block => block.type === "toolCall");
			const writesCheckpoint =
				calls.length === 1 &&
				(calls[0].name === "notes.write_file" || calls[0].name === "notes.append_to_file") &&
				checkpointCompleted?.(calls[0].id) === true;
			const resetsWindow = calls.length === 1 && calls[0].name === "new_context";
			if (
				(this.#fallbackResponses === 1 && !writesCheckpoint) ||
				(this.#fallbackResponses === 2 && !resetsWindow) ||
				this.#fallbackResponses > 2
			)
				this.#fallbackFailed = true;
		}
		return this.observeInputTokens(calculatePromptTokens(message.usage), effectiveLimit, policy);
	}

	/** Tells the model the window still stands, and yields to summarization. */
	resetCancelled(): DeveloperMessage {
		this.#fallbackFailed = true;
		return { role: "developer", content: cancelledText.trimEnd(), timestamp: Date.now(), synthetic: true };
	}

	observeInputTokens(inputTokens: number, effectiveLimit: number, policy: CodexContextWindows): DeveloperMessage[] {
		this.#remaining = Math.max(0, Math.floor(effectiveLimit - inputTokens - policy.autoCompactFallbackBufferTokens));
		const items: DeveloperMessage[] = [
			{ role: "developer", content: this.remainingText(), timestamp: Date.now(), synthetic: true },
		];
		if (this.#remaining <= policy.reminderThresholdTokens && !this.#reminderClaimed) {
			this.#reminderClaimed = true;
			items.push({
				role: "developer",
				content: policy.reminderMessageTemplate.replaceAll("{n_remaining}", String(this.#remaining)),
				timestamp: Date.now(),
				synthetic: true,
			});
		}
		if (this.#remaining === 0 && !this.#fallbackClaimed) {
			this.#fallbackClaimed = true;
			items.push({
				role: "developer",
				content: policy.autoCompactFallbackPrompt,
				timestamp: Date.now(),
				synthetic: true,
			});
		}
		return items;
	}

	transform(
		context: Context,
		options: {
			identity: CodexContextWindowIdentity;
			policy?: CodexContextWindows;
			threadHint?: string;
			getMessageId: (message: Message) => string | undefined;
		},
	): Context {
		this.reset(options.identity);
		const guidance = options.policy?.guidanceMessage;
		const key = JSON.stringify([options.identity, guidance, options.threadHint]);
		if (this.#staticContext?.key !== key) {
			const messages: DeveloperMessage[] = [
				{
					role: "developer",
					content: renderContext({
						...options.identity,
						agentName: this.agentName,
						threadHint: options.threadHint,
					}).trimEnd(),
					timestamp: 0,
				},
			];
			if (guidance)
				messages.push({ role: "developer", content: renderGuidance({ guidance }).trimEnd(), timestamp: 0 });
			this.#staticContext = { key, messages };
		}
		const messages = [
			...this.#staticContext.messages,
			...context.messages.map(message => appendCodexHistoryItemId(message, options.getMessageId(message))),
		];
		if (this.#fallbackClaimed) this.#fallbackDelivered = true;
		return { ...context, messages };
	}
}

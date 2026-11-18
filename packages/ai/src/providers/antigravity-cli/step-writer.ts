/**
 * Emits one omp assistant message (a "step") from agy's ACP events: thinking
 * and text deltas, at most one tool call, then a terminal `done` or `error`.
 */
import type { PromptResponse } from "@oh-my-pi/pi-utils/acp";
import type { Api, AntigravityCliPayload, AssistantMessage, Model, ToolCall } from "../../types";
import type { AssistantMessageEventStream } from "../../utils/event-stream";

export class StepWriter {
	readonly output: AssistantMessage;
	#stream: AssistantMessageEventStream;
	#textIndex: number | undefined;
	#thinkingIndex: number | undefined;

	/** Start one assistant stream; subsequent methods are inert after its terminal event. */
	constructor(model: Model<Api>, stream: AssistantMessageEventStream) {
		this.#stream = stream;
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: this.output });
	}

	/** True once `done` or `error` was emitted. */
	get done(): boolean {
		return this.#stream.done;
	}

	/** Append a visible text delta, ending any open thinking block first. */
	text(delta: string): void {
		if (!delta || this.done) return;
		this.#endThinking();
		if (this.#textIndex === undefined) {
			this.output.content.push({ type: "text", text: "" });
			this.#textIndex = this.output.content.length - 1;
			this.#stream.push({ type: "text_start", contentIndex: this.#textIndex, partial: this.output });
		}
		const block = this.output.content[this.#textIndex];
		if (block?.type !== "text") return;
		block.text += delta;
		this.#stream.push({ type: "text_delta", contentIndex: this.#textIndex, delta, partial: this.output });
	}

	/** Append a thinking delta, ending any open text block first. */
	thinking(delta: string): void {
		if (!delta || this.done) return;
		this.#endText();
		if (this.#thinkingIndex === undefined) {
			this.output.content.push({ type: "thinking", thinking: "" });
			this.#thinkingIndex = this.output.content.length - 1;
			this.#stream.push({ type: "thinking_start", contentIndex: this.#thinkingIndex, partial: this.output });
		}
		const block = this.output.content[this.#thinkingIndex];
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		this.#stream.push({ type: "thinking_delta", contentIndex: this.#thinkingIndex, delta, partial: this.output });
	}

	/** Emit the host-validated tool call with a complete argument object. */
	toolCall(call: ToolCall): void {
		if (this.done) return;
		this.#endText();
		this.#endThinking();
		this.output.content.push(call);
		const contentIndex = this.output.content.length - 1;
		this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.#stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: JSON.stringify(call.arguments),
			partial: this.output,
		});
		this.#stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
	}

	/**
	 * Records occupied context; a turn end also carries the turn's token totals,
	 * which agy reports only once for all of the turn's steps.
	 */
	usage(contextTokens: number, turn?: PromptResponse["usage"]): void {
		if (this.done) return;
		const usage = this.output.usage;
		usage.contextTokens = contextTokens;
		if (turn) {
			usage.cacheRead = turn.cachedReadTokens ?? 0;
			usage.cacheWrite = turn.cachedWriteTokens ?? 0;
			// ACP reports uncached input separately from cached reads and writes.
			usage.input = turn.inputTokens;
			usage.output = turn.outputTokens;
			if (turn.thoughtTokens != null) usage.reasoningTokens = turn.thoughtTokens;
		}
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}

	/** Finish once, retaining the conversation fingerprint needed by the next request. */
	finish(reason: "stop" | "length" | "toolUse", payload: AntigravityCliPayload): void {
		if (this.done) return;
		this.#endText();
		this.#endThinking();
		this.output.stopReason = reason;
		this.output.providerPayload = payload;
		this.#stream.push({ type: "done", reason, message: this.output });
	}

	/** Fail once without allowing later ACP events to mutate the published result. */
	fail(reason: "aborted" | "error", message: string): void {
		if (this.done) return;
		this.#endText();
		this.#endThinking();
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.#stream.push({ type: "error", reason, error: this.output });
	}

	#endText(): void {
		if (this.#textIndex === undefined) return;
		const block = this.output.content[this.#textIndex];
		if (block?.type === "text") {
			this.#stream.push({
				type: "text_end",
				contentIndex: this.#textIndex,
				content: block.text,
				partial: this.output,
			});
		}
		this.#textIndex = undefined;
	}

	#endThinking(): void {
		if (this.#thinkingIndex === undefined) return;
		const block = this.output.content[this.#thinkingIndex];
		if (block?.type === "thinking") {
			this.#stream.push({
				type: "thinking_end",
				contentIndex: this.#thinkingIndex,
				content: block.thinking,
				partial: this.output,
			});
		}
		this.#thinkingIndex = undefined;
	}
}

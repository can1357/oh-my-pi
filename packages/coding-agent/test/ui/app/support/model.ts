/**
 * Scripted model: the agent's `streamFn`. Every request becomes a {@link Turn}
 * the scenario feeds event by event (text/thinking deltas, tool calls, the
 * stop), so each stage sees exactly the partial reply the script says.
 */
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Usage a scripted stop reports; missing fields are 0. */
export interface ScriptUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export class Turn {
	readonly stream = new AssistantMessageEventStream();
	readonly partial: AssistantMessage;
	#ended = false;
	readonly #closed = new WeakSet<object>();

	constructor(
		model: Model,
		readonly context: Context,
		readonly options: SimpleStreamOptions | undefined,
	) {
		this.partial = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.stream.push({ type: "start", partial: this.partial });
		options?.signal?.addEventListener("abort", () => this.#abort(), { once: true });
	}

	get ended(): boolean {
		return this.#ended;
	}

	#openText(): { block: TextContent; contentIndex: number } {
		const contentIndex = this.partial.content.length - 1;
		const last = this.partial.content[contentIndex];
		if (last?.type === "text" && !this.#closed.has(last)) return { block: last, contentIndex };
		this.#closeLast();
		const block: TextContent = { type: "text", text: "" };
		this.partial.content.push(block);
		this.stream.push({ type: "text_start", contentIndex: contentIndex + 1, partial: this.partial });
		return { block, contentIndex: contentIndex + 1 };
	}

	#openThinking(): { block: ThinkingContent; contentIndex: number } {
		const contentIndex = this.partial.content.length - 1;
		const last = this.partial.content[contentIndex];
		if (last?.type === "thinking" && !this.#closed.has(last)) return { block: last, contentIndex };
		this.#closeLast();
		const block: ThinkingContent = { type: "thinking", thinking: "" };
		this.partial.content.push(block);
		this.stream.push({ type: "thinking_start", contentIndex: contentIndex + 1, partial: this.partial });
		return { block, contentIndex: contentIndex + 1 };
	}

	#closeLast(): void {
		const contentIndex = this.partial.content.length - 1;
		const last = this.partial.content[contentIndex];
		if (!last || this.#closed.has(last)) return;
		if (last.type === "text")
			this.stream.push({ type: "text_end", contentIndex, content: last.text, partial: this.partial });
		else if (last.type === "thinking")
			this.stream.push({ type: "thinking_end", contentIndex, content: last.thinking, partial: this.partial });
		this.#closed.add(last);
	}

	text(delta: string): void {
		const { block, contentIndex } = this.#openText();
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex, delta, partial: this.partial });
	}

	thinking(delta: string): void {
		const { block, contentIndex } = this.#openThinking();
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex, delta, partial: this.partial });
	}

	toolCall(id: string, name: string, args: Record<string, unknown>): void {
		this.#closeLast();
		const call: ToolCall = { type: "toolCall", id, name, arguments: args };
		this.partial.content.push(call);
		const contentIndex = this.partial.content.length - 1;
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.partial });
		this.stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: this.partial });
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.partial });
		this.#closed.add(call);
	}

	usage(usage: ScriptUsage): void {
		const u = this.partial.usage;
		u.input = usage.input ?? u.input;
		u.output = usage.output ?? u.output;
		u.cacheRead = usage.cacheRead ?? u.cacheRead;
		u.cacheWrite = usage.cacheWrite ?? u.cacheWrite;
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	}

	done(usage: ScriptUsage = {}): void {
		this.#closeLast();
		this.usage(usage);
		const reason = this.partial.content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
		this.partial.stopReason = reason;
		this.partial.duration = 0;
		this.#ended = true;
		this.stream.push({ type: "done", reason, message: this.partial });
	}

	error(message: string): void {
		this.#closeLast();
		this.partial.stopReason = "error";
		this.partial.errorMessage = message;
		this.#ended = true;
		this.stream.push({ type: "error", reason: "error", error: this.partial });
	}

	#abort(): void {
		if (this.#ended) return;
		this.#closeLast();
		this.partial.stopReason = "aborted";
		this.partial.errorMessage = "Request was aborted";
		this.#ended = true;
		this.stream.push({ type: "error", reason: "aborted", error: this.partial });
	}
}

/** Queue of model requests the scenario answers in order. */
export class ScriptedModel {
	readonly turns: Turn[] = [];
	#waiters: ((turn: Turn) => void)[] = [];
	#taken = 0;

	readonly streamFn = (model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const turn = new Turn(model, context, options);
		this.turns.push(turn);
		const waiter = this.#waiters.shift();
		if (waiter) waiter(turn);
		return turn.stream;
	};

	/** Whether a request is waiting that no scenario step has taken yet. */
	get pending(): boolean {
		return this.turns.length > this.#taken;
	}

	/** The next unanswered request (waits for the agent to make it). */
	next(): Promise<Turn> {
		if (this.turns.length > this.#taken) return Promise.resolve(this.turns[this.#taken++]!);
		const { promise, resolve } = Promise.withResolvers<Turn>();
		this.#waiters.push(turn => {
			this.#taken++;
			resolve(turn);
		});
		return promise;
	}
}

import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "../../types";
import { KiroStreamError } from "./errors";

interface ToolState {
	id: string;
	name?: string;
	fragments: string;
	snapshot?: Record<string, unknown>;
	contentIndex?: number;
	completed: boolean;
}

export class KiroToolAssembler {
	#states = new Map<string, ToolState>();
	#emitted = 0;

	constructor(
		private readonly output: AssistantMessage,
		private readonly stream: AssistantMessageEventStream,
		private readonly onVisibleOutput: () => void,
	) {}

	get emittedCount(): number {
		return this.#emitted;
	}

	update(event: { toolUseId: string; name?: string; input?: string | Record<string, unknown>; stop?: boolean }): void {
		let state = this.#states.get(event.toolUseId);
		if (!state) {
			state = { id: event.toolUseId, name: event.name, fragments: "", completed: false };
			this.#states.set(event.toolUseId, state);
		} else if (state.completed) {
			throw new KiroStreamError(`Tool ${event.toolUseId} received data after completion`, {
				code: "TOOL_EVENT_AFTER_COMPLETION",
			});
		}
		if (event.name) state.name = event.name;
		if (typeof event.input === "string") state.fragments += event.input;
		else if (event.input) state.snapshot = event.input;
		this.#start(state);
		if (typeof event.input === "string" && event.input.length > 0) {
			this.stream.push({
				type: "toolcall_delta",
				contentIndex: state.contentIndex!,
				delta: event.input,
				partial: this.output,
			});
		}
		if (event.stop) this.#finish(state, false);
	}

	/**
	 * Finalize every tool that never received `stop`. A truncated response
	 * (`truncated: true`) carries cut-off arguments, so those tools finalize
	 * on a best-effort `{}` instead of throwing: the caller reports `length`,
	 * and the agent loop then skips them rather than executing partial input.
	 */
	finishAll(truncated: boolean): void {
		for (const state of this.#states.values()) {
			if (!state.completed) this.#finish(state, truncated);
		}
	}

	#start(state: ToolState): void {
		if (state.contentIndex !== undefined) return;
		if (!state.name) {
			throw new KiroStreamError(`Tool ${state.id} started without a name`, { code: "MALFORMED_TOOL_EVENT" });
		}
		this.onVisibleOutput();
		state.contentIndex = this.output.content.length;
		this.output.content.push({ type: "toolCall", id: state.id, name: state.name, arguments: {} });
		this.stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: this.output });
	}

	#finish(state: ToolState, truncated: boolean): void {
		this.#start(state);
		let args = state.snapshot;
		let delta = state.fragments;
		if (!args) {
			if (delta.trim().length === 0) delta = "{}";
			try {
				const parsed: unknown = JSON.parse(delta);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("not an object");
				}
				args = parsed as Record<string, unknown>;
			} catch (cause) {
				if (!truncated) {
					throw new KiroStreamError(`Tool ${state.id} completed with malformed JSON input`, {
						code: "MALFORMED_TOOL_INPUT",
						kind: "output",
						cause,
					});
				}
				args = {};
			}
		}
		const block = this.output.content[state.contentIndex!] as ToolCall;
		block.arguments = args;
		state.completed = true;
		this.#emitted++;
		this.stream.push({
			type: "toolcall_end",
			contentIndex: state.contentIndex!,
			toolCall: block,
			partial: this.output,
		});
	}
}

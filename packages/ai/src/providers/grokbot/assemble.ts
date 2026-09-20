/**
 * Stateful assembly of Grok Bot tool-call stream parts into complete calls.
 *
 * Observed wire semantics, covered by synthetic fixtures in
 * test/grokbot-wire.test.ts:
 * - Frames for one call share a stable toolCallId; parallel calls use distinct ids.
 * - Open frames carry field 3 INCREMENTS of the raw JSON args.
 * - The completing frame (field 4 = isComplete) carries the FULL accumulated
 *   args again — appending it would corrupt the payload, it must replace.
 */
import type { InferenceStreamPart } from "./wire";

export interface AssembledToolCall {
	/** True when this part opened a new call (no prior frame with this id). */
	started: boolean;
	/** Text appended to the accumulated args by this frame, if any. */
	delta?: string;
	/** Accumulated raw args after applying this frame. */
	argsText: string;
	/** True on the completing frame. */
	completed: boolean;
}

interface ToolCallState {
	toolName?: string;
	argsText: string;
}

export class ToolCallAssembler {
	private readonly states = new Map<string, ToolCallState>();

	onToolCallPart(part: Extract<InferenceStreamPart, { kind: "toolCall" }>): {
		started: boolean;
		delta?: string;
		argsText: string;
	} {
		const key = part.toolCallId || "anon";
		let state = this.states.get(key);
		const started = !state;
		if (!state) {
			state = { argsText: "" };
			this.states.set(key, state);
		}
		if (part.toolName && !state.toolName) state.toolName = part.toolName;

		let delta: string | undefined;
		if (part.args !== undefined && part.args !== "") {
			if (part.isComplete) {
				// Completing frame: full args replace anything accumulated.
				if (part.args !== state.argsText) {
					delta = part.args;
					state.argsText = part.args;
				}
			} else {
				// Open frame: field 3 is an increment.
				delta = part.args;
				state.argsText += part.args;
			}
		}
		return { started, delta, argsText: state.argsText };
	}
}

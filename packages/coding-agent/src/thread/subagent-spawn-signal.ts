/**
 * Earliest sign that a session is about to spawn subagents: its model is
 * streaming spawning tool calls. Main-thread sessions feed their streamed
 * assistant events here and, whenever the expected number of spawns grows,
 * let the worker pool start a worker those spawns will need
 * (`prewarmSubagentWorker`), so it boots while the arguments are still
 * streaming instead of after dispatch.
 *
 * Spawning calls: a `task` call (one spawn from its first event, then one per
 * `tasks[]` item whose opening brace has streamed), and an `eval` call once its streamed code
 * mentions `agent(` or `workpool(` (the eval subagent helpers; most cells never
 * spawn, so the name alone is no signal; counted as one spawn).
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { BatchArgsScanner } from "../task/speculative-launch";

/** Eval helpers that spawn subagents, as they appear in streamed cell code. */
const EVAL_SPAWN_CALL = /\b(?:agent|workpool)\s*\(/;
/** Characters of an eval call's streamed arguments kept so a helper name split across deltas still matches. */
const EVAL_TAIL_CHARS = 16;

/** One streaming tool call of the current message. */
type CallState =
	| { readonly kind: "task"; readonly scanner: BatchArgsScanner; raw: string; spawns: number }
	| { readonly kind: "eval"; tail: string; spawns: number }
	| { readonly kind: "other"; spawns: 0 };

/** Per-message counter of spawns its streaming tool calls are about to make; see the module doc. */
export class SubagentSpawnSignal {
	/** Streaming tool calls of the current message, by content index. */
	readonly #calls = new Map<number, CallState>();
	/** Spawns last reported for the current message. */
	#reported = 0;

	/**
	 * Feed one streamed assistant event; returns the number of spawns the message's tool
	 * calls are expected to make whenever it grows, else `undefined`.
	 */
	observe(event: AssistantMessageEvent): number | undefined {
		if (event.type === "start") {
			this.#calls.clear();
			this.#reported = 0;
			return undefined;
		}
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta") return undefined;
		const block = event.partial.content[event.contentIndex];
		if (block?.type !== "toolCall" || !block.name) return undefined;
		let call = this.#calls.get(event.contentIndex);
		if (!call) {
			call =
				block.name === "task"
					? { kind: "task", scanner: new BatchArgsScanner(), raw: "", spawns: 1 }
					: block.name === "eval"
						? { kind: "eval", tail: "", spawns: 0 }
						: { kind: "other", spawns: 0 };
			this.#calls.set(event.contentIndex, call);
		}
		if (event.type === "toolcall_delta") this.#feed(call, event.delta);
		let expected = 0;
		for (const state of this.#calls.values()) expected += state.spawns;
		if (expected <= this.#reported) return undefined;
		this.#reported = expected;
		return expected;
	}

	#feed(call: CallState, delta: string): void {
		if (call.kind === "task") {
			call.raw += delta;
			call.scanner.feed(call.raw);
			// Count an item once its `{` streams: its assignment text still gives the worker time to boot.
			call.spawns = Math.max(1, call.scanner.itemsOpened);
		} else if (call.kind === "eval" && call.spawns === 0) {
			const scanned = call.tail + delta;
			if (EVAL_SPAWN_CALL.test(scanned)) call.spawns = 1;
			else call.tail = scanned.slice(-EVAL_TAIL_CHARS);
		}
	}
}

import { describe, expect, it } from "bun:test";
import { buildResponsesDeltaInput } from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";
import {
	kStreamingArgumentsDone,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "@pk-nerdsaver-ai/pi-ai/utils/block-symbols";
import type { ResponseInputItem } from "../src/providers/openai-responses-wire";

// Both stateful callers store the previous request/response through
// `structuredCloneJSON`, so the baseline side is always symbol-free, while the
// current request input is live and can still carry the transient decode
// symbols providers stamp onto stream blocks. These build the symbol-free
// baseline shape both sides share.
function baselineItems(): ResponseInputItem[] {
	return [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "foo", arguments: "{}" },
	];
}

describe("buildResponsesDeltaInput streaming-symbol scrub", () => {
	it("returns only the appended delta when live current items carry streaming symbols", () => {
		const previous = { input: [baselineItems()[0]] };
		const previousResponseItems = [baselineItems()[1]];

		const live = baselineItems();
		// Transient decode bookkeeping stamped on the live blocks — `deepEquals`
		// sees these keys, so they must be scrubbed before comparing against the
		// symbol-free baseline.
		Reflect.set(live[0], kStreamingBlockIndex, 3);
		Reflect.set(live[1], kStreamingPartialJson, '{"par');
		Reflect.set(live[1], kStreamingLastParseLen, 4);
		Reflect.set(live[1], kStreamingArgumentsDone, true);
		Reflect.set(live[1], kStreamingBlockKind, "mcp");
		const appended: ResponseInputItem = {
			type: "function_call",
			id: "fc_2",
			call_id: "call_2",
			name: "bar",
			arguments: "{}",
		};
		const current = { input: [...live, appended] };

		const delta = buildResponsesDeltaInput(previous, previousResponseItems, current);

		expect(delta).toEqual([appended]);
		// The delta carries the original live item, not a scrubbed copy — the scrub
		// is comparison-only and symbols never reach the wire anyway.
		expect(delta?.[0]).toBe(appended);
	});

	it("still breaks the chain on a real content change, not just symbol noise", () => {
		const previous = { input: [baselineItems()[0]] };
		const previousResponseItems = [baselineItems()[1]];

		const mutated = baselineItems();
		Reflect.set(mutated[1], "name", "renamed"); // genuine prefix mutation, not a symbol
		const current = {
			input: [...mutated, { type: "function_call", id: "fc_2" } as ResponseInputItem],
		};
		expect(buildResponsesDeltaInput(previous, previousResponseItems, current)).toBeNull();
	});

	it("breaks the chain when a top-level request option changes (undefined → value)", () => {
		// `deepEqualsWithout` must not treat a present-`undefined` option as equal
		// to a defined one, or chaining would survive a real option change.
		const items = baselineItems();
		const appended: ResponseInputItem = {
			type: "function_call",
			id: "fc_2",
			call_id: "call_2",
			name: "bar",
			arguments: "{}",
		};
		const previous: { input: ResponseInputItem[]; reasoning?: unknown } = {
			input: [items[0]],
			reasoning: undefined,
		};
		const current: { input: ResponseInputItem[]; reasoning?: unknown } = {
			input: [items[0], items[1], appended],
			reasoning: { effort: "high" },
		};
		expect(buildResponsesDeltaInput(previous, [items[1]], current)).toBeNull();
	});

	it("treats assistant message phase as part of chained-prefix equality", () => {
		const user = baselineItems()[0]!;
		const previousAssistant: ResponseInputItem = {
			type: "message",
			role: "assistant",
			content: "intermediate update",
			phase: "commentary",
		};
		const appended: ResponseInputItem = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "follow-up" }],
		};
		const previous = { input: [user] };

		expect(
			buildResponsesDeltaInput(previous, [previousAssistant], { input: [user, previousAssistant, appended] }),
		).toEqual([appended]);

		const wrongPhaseAssistant: ResponseInputItem = { ...previousAssistant, phase: "final_answer" };
		expect(
			buildResponsesDeltaInput(previous, [previousAssistant], { input: [user, wrongPhaseAssistant, appended] }),
		).toBeNull();
	});
});

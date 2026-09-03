import { describe, expect, it } from "bun:test";
import { buildResponsesDeltaInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import {
	kStreamingArgumentsDone,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
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

	it("chains a replay-sanitized custom tool call when live history retains its output id", () => {
		const user: ResponseInputItem = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "edit the file" }],
		};
		const previousCustomCall = {
			type: "custom_tool_call",
			call_id: "call_eval_1",
			name: "eval",
			input: "print('ok')",
		} as ResponseInputItem;
		const liveCustomCall = {
			...previousCustomCall,
			id: "ctc_eval_1",
			status: "completed",
		} as ResponseInputItem;
		const output = {
			type: "custom_tool_call_output",
			call_id: "call_eval_1",
			output: "ok",
		} as ResponseInputItem;

		expect(
			buildResponsesDeltaInput({ input: [user] }, [previousCustomCall], { input: [user, liveCustomCall, output] }),
		).toEqual([output]);
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

	it("keeps service_tier chain-breaking unless the caller explicitly excludes it", () => {
		const items = baselineItems();
		const appended: ResponseInputItem = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "follow-up" }],
		};
		const previous = { input: [items[0]!], service_tier: "default" };
		const current = { input: [items[0]!, items[1]!, appended], service_tier: "priority" };

		expect(buildResponsesDeltaInput(previous, [items[1]!], current)).toBeNull();
		expect(buildResponsesDeltaInput(previous, [items[1]!], current, { service_tier: true })).toEqual([appended]);
	});

	const semanticOptionChanges = [
		["model", { model: "gpt-before" }, { model: "gpt-after" }],
		["instructions", { instructions: "before" }, { instructions: "after" }],
		[
			"tool schema",
			{ tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] },
			{
				tools: [
					{
						type: "function",
						name: "lookup",
						parameters: { type: "object", properties: { query: { type: "string" } } },
					},
				],
			},
		],
		["reasoning mode", { reasoning: { effort: "low" } }, { reasoning: { effort: "high" } }],
		["text verbosity", { text: { verbosity: "low" } }, { text: { verbosity: "high" } }],
		[
			"response format",
			{ text: { format: { type: "text" } } },
			{
				text: {
					format: {
						type: "json_schema",
						name: "result",
						schema: { type: "object", properties: { result: { type: "string" } } },
					},
				},
			},
		],
	] as const;

	for (const [name, before, after] of semanticOptionChanges) {
		it(`keeps a ${name} change chain-breaking when service_tier is excluded`, () => {
			const items = baselineItems();
			const appended: ResponseInputItem = {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "follow-up" }],
			};
			const previous = { input: [items[0]!], service_tier: "default", ...before };
			const current = { input: [items[0]!, items[1]!, appended], service_tier: "priority", ...after };

			expect(buildResponsesDeltaInput(previous, [items[1]!], current, { service_tier: true })).toBeNull();
		});
	}

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

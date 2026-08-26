import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	appendResponsesToolResultMessages,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("repairOrphanResponsesToolCalls", () => {
	it("appends a synthetic function_call_output after a call with no result", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		const callIndex = repaired.findIndex(
			item =>
				(item as { type?: string }).type === "function_call" && (item as { call_id?: string }).call_id === "call_a",
		);
		const output = repaired[callIndex + 1] as { type?: string; call_id?: string; output?: unknown };
		expect(output.type).toBe("function_call_output");
		expect(output.call_id).toBe("call_a");
		expect(output.output).toMatch(/interrupted/i);
	});

	it("uses custom_tool_call_output for an orphan custom_tool_call", () => {
		const input: ResponseInput = [
			{ type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "patch" } as ResponseInput[number],
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		const output = repaired.find(item => (item as { type?: string }).type === "custom_tool_call_output") as
			| { call_id?: string }
			| undefined;
		expect(output?.call_id).toBe("call_c");
	});

	it("returns the input unchanged when every call is paired", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "ok" } as ResponseInput[number],
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		expect(repaired).toBe(input);
	});

	it("does not pair a call with an output that appears earlier in replay order", () => {
		const input: ResponseInput = [
			{ type: "function_call_output", call_id: "call_a", output: "stale" } as ResponseInput[number],
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		expect(repaired.at(-1)).toMatchObject({
			type: "function_call_output",
			call_id: "call_a",
			output: expect.stringMatching(/interrupted/i),
		});
	});

	it("composes with output repair so a tree-branch snapshot stays API-valid", () => {
		// Branching to a node that ends on a tool call drops the result child:
		// the assistant turn keeps the call, but no matching output remains.
		const input: ResponseInput = [
			{ role: "user", content: [{ type: "input_text", text: "do it" }] },
			{ type: "function_call", call_id: "call_x", name: "bash", arguments: "{}" },
		];

		const repaired = repairOrphanResponsesToolCalls(repairOrphanResponsesToolOutputs(input));
		const callIds = new Set(
			repaired
				.filter(i => (i as { type?: string }).type === "function_call")
				.map(i => (i as { call_id: string }).call_id),
		);
		const outputIds = new Set(
			repaired
				.filter(i => (i as { type?: string }).type === "function_call_output")
				.map(i => (i as { call_id: string }).call_id),
		);
		for (const id of callIds) expect(outputIds.has(id)).toBe(true);
	});
});

describe("repairOrphanResponsesToolOutputs", () => {
	it("preserves orphan images as user-message fallbacks", () => {
		const imageData = Buffer.from("orphan image").toString("base64");
		const imageUrl = `data:image/png;base64,${imageData}`;
		const output = [
			{ type: "input_text", text: "rendered image" },
			{ type: "input_image", detail: "high", image_url: imageUrl },
		];
		const repaired = repairOrphanResponsesToolOutputs([
			{ type: "function_call_output", call_id: "call_orphan", output } as ResponseInput[number],
		]);

		expect(repaired).toEqual([
			{
				type: "message",
				role: "assistant",
				content: expect.stringContaining("rendered image"),
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", detail: "high", image_url: imageUrl }],
			},
		]);
		expect((repaired[0] as { content: string }).content).not.toContain(imageData);

		const strictMessages: ResponseInput = [];
		appendResponsesToolResultMessages(
			strictMessages,
			{
				role: "toolResult",
				toolCallId: "call_strict_orphan",
				toolName: "read",
				content: [
					{ type: "text", text: "rendered image" },
					{ type: "image", data: imageData, mimeType: "image/png", detail: "high" },
				],
				isError: false,
				timestamp: 0,
			},
			getBundledModel<"openai-responses">("openai", "gpt-5-mini"),
			true,
			true,
			new Set(),
		);
		expect(strictMessages).toEqual([
			{
				type: "message",
				role: "assistant",
				content: expect.stringContaining("rendered image"),
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", detail: "high", image_url: imageUrl }],
			},
		]);
	});

	it("does not pair an output with a call that appears later in replay order", () => {
		const input: ResponseInput = [
			{ type: "function_call_output", call_id: "call_a", output: "stale" } as ResponseInput[number],
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
		];

		const repaired = repairOrphanResponsesToolOutputs(input);
		expect(repaired[0]).toMatchObject({
			type: "message",
			role: "assistant",
			content: expect.stringContaining("stale"),
		});
		expect(repaired[1]).toBe(input[1]);
	});

	it("returns the input unchanged when every output follows its matching call", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "ok" } as ResponseInput[number],
		];

		expect(repairOrphanResponsesToolOutputs(input)).toBe(input);
	});
});

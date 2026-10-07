import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { finalizeSubprocessOutput } from "../../src/task/executor";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import type { ToolSession } from "../../src/tools";
import { buildOutputValidator } from "../../src/tools/output-schema-validator";
import { YieldTool } from "../../src/tools/yield";
import type { YieldItem } from "@oh-my-pi/pi-tui/tools/task";

function session(outputSchema: unknown): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		outputSchema,
	};
}

async function submit(tool: YieldTool, args: Record<string, unknown>, terminal: boolean): Promise<YieldItem> {
	const result = await tool.execute("consumer-fixture", args);
	const handler = subprocessToolRegistry.getHandler("yield");
	if (!handler?.extractData || !handler.shouldTerminate) throw new Error("yield registration unavailable");
	// Match the subprocess JSONL boundary, including omitted undefined fields.
	const event = JSON.parse(
		JSON.stringify({ toolName: "yield", toolCallId: "consumer-fixture", args, result, isError: false }),
	);
	expect(handler.shouldTerminate(event)).toBe(terminal);
	const item = handler.extractData(event);
	expect(item).toBeDefined();
	return item as YieldItem;
}

function finalize(items: YieldItem[], outputSchema: unknown) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: items,
		outputSchema,
		outputSchemaMode: "strict",
		outputSchemaSource: "caller",
	});
}

const findingSchema = {
	type: "object",
	properties: { title: { type: "string" }, detail: { type: "string" } },
	required: ["title"],
	additionalProperties: false,
};
const schema = {
	type: "object",
	properties: { findings: { type: "array", items: findingSchema }, note: { type: "string" } },
	required: ["findings", "note"],
	additionalProperties: false,
};

describe("yield core production consumers", () => {
	it("flattens a legal batch after a single item through registry and executor", async () => {
		const tool = new YieldTool(session(schema));
		const items = [
			await submit(tool, { type: ["findings"], data: { title: "one", detail: null } }, false),
			await submit(tool, { type: ["findings"], data: [{ title: "two" }, { title: "three" }] }, false),
			await submit(tool, { type: ["note"], data: "done" }, false),
			await submit(tool, { type: "result" }, true),
		];
		const output = finalize(items, schema);
		expect(output.exitCode).toBe(0);
		expect(output.structuredOutput?.status).toBe("valid");
		expect(JSON.parse(output.rawOutput)).toEqual({
			findings: [{ title: "one" }, { title: "two" }, { title: "three" }],
			note: "done",
		});
	});

	it("splits multi-label object values instead of broadcasting the wrapper", async () => {
		const tool = new YieldTool(session(schema));
		const sections = await submit(
			tool,
			{ type: ["findings", "note"], data: { findings: [{ title: "one", detail: null }], note: "summary" } },
			false,
		);
		const terminal = await submit(tool, { type: "result" }, true);
		const output = finalize([sections, terminal], schema);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [{ title: "one" }], note: "summary" });
	});

	it("prefers a valid nested array item and a same-label item field over wrappers", async () => {
		const nested = {
			type: "object",
			properties: {
				matrix: { type: "array", items: { type: "array", items: { type: "number" } } },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: { findings: { type: "string" } },
						required: ["findings"],
						additionalProperties: false,
					},
				},
			},
			required: ["matrix", "findings"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(nested));
		const items = [
			await submit(tool, { type: ["matrix"], data: [1, 2] }, false),
			await submit(tool, { type: ["matrix"], data: [[3], [4, 5]] }, false),
			await submit(tool, { type: ["findings"], data: { findings: "item field" } }, false),
			await submit(tool, { type: "result" }, true),
		];
		const output = finalize(items, nested);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({
			matrix: [[1, 2], [3], [4, 5]],
			findings: [{ findings: "item field" }],
		});
	});

	it("preserves a required null declared by a different allOf branch and rejects it at the final consumer", async () => {
		const combined = {
			type: "object",
			allOf: [{ properties: { note: { type: "string" } } }, { required: ["note"] }],
		};
		const validator = buildOutputValidator(combined).validator;
		expect(validator?.normalize({ note: null })).toEqual({ note: null });
		const tool = new YieldTool(session(combined));
		await expect(tool.execute("required-null", { data: { note: null } })).rejects.toThrow(/does not match schema/);
		const output = finalize([{ status: "success", data: { note: null } }], combined);
		expect(output.exitCode).toBe(1);
		expect(output.structuredOutput?.status).toBe("invalid");
	});

	it("combines section item schemas across allOf and retains final whole-array constraints", async () => {
		const combined = {
			type: "object",
			allOf: [
				{
					properties: {
						rows: {
							type: "array",
							minItems: 2,
							items: {
								type: "object",
								properties: { title: { type: "string" }, detail: { type: "string" } },
								required: ["title"],
							},
						},
					},
				},
				{
					properties: { rows: { type: "array", items: { type: "object", required: ["detail"] } } },
					required: ["rows"],
				},
			],
		};
		const tool = new YieldTool(session(combined));
		await expect(tool.execute("missing-detail", { type: ["rows"], data: { title: "missing" } })).rejects.toThrow(
			/does not match schema/,
		);
		const first = await submit(tool, { type: ["rows"], data: { title: "one", detail: "required" } }, false);
		expect(finalize([first], combined).exitCode).toBe(1);
		const second = await submit(tool, { type: ["rows"], data: [{ title: "two", detail: "required" }] }, false);
		const terminal = await submit(tool, { type: "result" }, true);
		expect(finalize([first, second, terminal], combined).exitCode).toBe(0);
	});
});

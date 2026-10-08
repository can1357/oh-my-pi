import { describe, expect, it } from "bun:test";
import type { YieldItem } from "@oh-my-pi/pi-tui/tools/task";
import { assembleYieldResult } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import { enforceStrictSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "../../src/config/settings";
import { finalizeSubprocessOutput } from "../../src/task/executor";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";
import { yieldSectionShapes } from "../../src/task/yield-assembly";
import type { ToolSession } from "../../src/tools";
import { buildOutputValidator } from "../../src/tools/output-schema-validator";
import { YieldTool } from "../../src/tools/yield";

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

describe("yield shape production consumers", () => {
	it("flattens legal batches, including an empty batch, after a single item through registry and executor", async () => {
		const tool = new YieldTool(session(schema));
		const items = [
			await submit(tool, { type: ["findings"], data: { title: "one", detail: null } }, false),
			await submit(tool, { type: ["findings"], data: [] }, false),
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

	it("splits multi-label object values and normalizes each independently", async () => {
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

	it("keeps single-label data direct and rejects a label wrapper rather than unwrapping it", async () => {
		const tool = new YieldTool(session(schema));
		await expect(tool.execute("wrapped-item", { type: ["findings"], data: { findings: [{ title: "wrapped" }] } }))
			.rejects.toThrow(/does not match schema/);
		await expect(tool.execute("wrapped-scalar", { type: ["note"], data: { note: "wrapped" } }))
			.rejects.toThrow(/does not match schema/);
		const items = [
			await submit(tool, { type: ["findings"], data: { title: "direct" } }, false),
			await submit(tool, { type: ["note"], data: "direct note" }, false),
			await submit(tool, { type: "result" }, true),
		];
		expect(JSON.parse(finalize(items, schema).rawOutput)).toEqual({ findings: [{ title: "direct" }], note: "direct note" });
	});

	it("prefers a valid nested array item and preserves an object item whose field matches its label", async () => {
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
			await submit(tool, { type: ["matrix"], data: [] }, false),
			await submit(tool, { type: ["matrix"], data: [[3], [4, 5]] }, false),
			await submit(tool, { type: ["findings"], data: { findings: "item field" } }, false),
			await submit(tool, { type: "result" }, true),
		];
		const output = finalize(items, nested);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({
			matrix: [[1, 2], [], [3], [4, 5]],
			findings: [{ findings: "item field" }],
		});
	});

	it("retains ambiguous arrays as one item when the native item schema accepts them", async () => {
		const ambiguous = {
			type: "object",
			properties: { values: { type: "array", items: {} } },
			required: ["values"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(ambiguous));
		const item = await submit(tool, { type: ["values"], data: [1, 2] }, false);
		const output = finalize([item], ambiguous);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ values: [[1, 2]] });
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

	it("normalizes optional nulls in union section items without dropping required nulls", async () => {
		const combined = {
			type: "object",
			properties: {
				rows: {
					type: "array",
					items: {
						anyOf: [
							findingSchema,
							{
								type: "object",
								properties: { title: { type: "number" } },
								required: ["title"],
								additionalProperties: false,
							},
						],
					},
				},
			},
			required: ["rows"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(combined));
		await expect(tool.execute("bad-batch", { type: ["rows"], data: [{ title: null }] })).rejects.toThrow(/does not match schema/);
		const item = await submit(tool, { type: ["rows"], data: [{ title: "text", detail: null }, { title: 7 }] }, false);
		const output = finalize([item], combined);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ rows: [{ title: "text" }, { title: 7 }] });
	});

	it("replaces accumulated sections only with a complete terminal and never treats a partial patch as complete", async () => {
		const tool = new YieldTool(session(schema));
		const section = await submit(tool, { type: ["findings"], data: { title: "earlier" } }, false);
		await expect(tool.execute("partial-terminal", { type: "result", data: { note: "partial" } })).rejects.toThrow(/does not match schema/);
		const invalid = finalize([section, { status: "success", type: "result", data: { note: "partial" } }], schema);
		expect(invalid.exitCode).toBe(1);
		expect(invalid.structuredOutput?.status).toBe("invalid");
		const terminal = await submit(tool, { type: "result", data: { findings: [], note: "complete" } }, true);
		const output = finalize([section, terminal], schema);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [], note: "complete" });
	});

	it("keeps strict finalization a failure even after the native retry override", async () => {
		const tool = new YieldTool(session(schema));
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(tool.execute("retry", { data: { note: "incomplete" } })).rejects.toThrow(/does not match schema/);
		}
		const overridden = await submit(tool, { data: { note: "incomplete" } }, true);
		expect(overridden.schemaOverridden).toBe(true);
		const output = finalize([overridden], schema);
		expect(output.exitCode).toBe(1);
		expect(output.structuredOutput?.status).toBe("invalid");
	});

	it("does not mutate schema declarations or invalidate existing validators when content changes or the LRU evicts them", async () => {
		const declaration = {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		};
		const snapshot = JSON.stringify(declaration);
		const original = buildOutputValidator(declaration).validator!;
		const tool = new YieldTool(session(declaration));
		const items = [await submit(tool, { type: ["value"], data: "first" }, false)];
		expect(finalize(items, declaration).exitCode).toBe(0);
		expect(JSON.stringify(declaration)).toBe(snapshot);
		declaration.properties.value.type = "number";
		const changed = buildOutputValidator(declaration).validator!;
		expect(changed.validate({ value: 7 }).success).toBe(true);
		expect(changed.validate({ value: "first" }).success).toBe(false);
		for (let index = 0; index < 40; index++) {
			buildOutputValidator({ type: "object", properties: { [`field${index}`]: { type: "boolean" } } });
		}
		expect(original.validate({ value: "first" }).success).toBe(true);
		expect(original.validate({ value: 7 }).success).toBe(false);
		expect(buildOutputValidator(JSON.parse(snapshot)).validator?.validate({ value: 7 }).success).toBe(false);
	});

	it("preserves native no-schema broadcast and workpool single-item payloads", async () => {
		const tool = new YieldTool(session(undefined));
		const data = { left: "one", right: "two" };
		const item = await submit(tool, { type: ["left", "right"], data }, false);
		expect(assembleYieldResult([item], undefined, yieldSectionShapes(undefined))?.data).toEqual({ left: data, right: data });
		const pool = new YieldTool({ ...session(undefined), getWorkPoolYieldItems: () => [{ id: "entry", index: 1 }] });
		const pooled = await submit(pool, { key: 1, data: [1, 2] }, true);
		expect(assembleYieldResult([pooled], undefined, yieldSectionShapes(undefined))?.data).toEqual({ entry: [1, 2] });
	});

	it("exposes legal multi-label subsets and item batches to the provider parameter validator", async () => {
		const declaration = {
			...schema,
			properties: { ...schema.properties, count: { type: "number" } },
			required: [...schema.required, "count"],
		};
		const tool = new YieldTool(session(declaration));
		const args = {
			type: ["findings", "note"],
			data: { findings: { title: "one", detail: null }, note: "summary", count: null },
			error: null,
		};
		expect(validateJsonSchemaValue(enforceStrictSchema(tool.parameters), args).success).toBe(true);
		const sections = await submit(tool, args, false);
		const count = await submit(tool, { type: ["count"], data: 1 }, false);
		const output = finalize([sections, count], declaration);
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.rawOutput)).toEqual({ findings: [{ title: "one" }], note: "summary", count: 1 });
		await expect(tool.execute("missing-mapping-key", { type: ["findings", "note"], data: { title: "broadcast" } }))
			.rejects.toThrow(/mapping each label/);
	});

	it("keeps whole-array oneOf exclusivity at finalization even when an incremental item fits both variants", async () => {
		const exclusive = {
			type: "object",
			properties: {
				rows: {
					oneOf: [
						{ type: "array", items: { type: "number" }, minItems: 1 },
						{ type: "array", items: { type: "number" }, maxItems: 3 },
					],
				},
			},
			required: ["rows"],
			additionalProperties: false,
		};
		const tool = new YieldTool(session(exclusive));
		const section = await submit(tool, { type: ["rows"], data: 1 }, false);
		const output = finalize([section], exclusive);
		expect(output.exitCode).toBe(1);
		expect(output.structuredOutput?.status).toBe("invalid");
	});
});

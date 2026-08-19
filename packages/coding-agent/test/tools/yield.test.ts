import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@pk-nerdsaver-ai/pi-ai/types";
import { enforceStrictSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { validateToolArguments } from "@pk-nerdsaver-ai/pi-ai/utils/validation";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { evaluateCompletionGate } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/completion-gate";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { YieldTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/yield";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function toRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getSuccessDataSchema(parameters: Record<string, unknown>): Record<string, unknown> {
	const resultSchema = toRecord(toRecord(parameters.properties).result);
	const variants = Array.isArray(resultSchema.anyOf) ? resultSchema.anyOf : [];
	for (const variant of variants) {
		const variantRecord = toRecord(variant);
		const variantProperties = toRecord(variantRecord.properties);
		if ("data" in variantProperties) {
			return toRecord(variantProperties.data);
		}
	}
	throw new Error("Missing success variant with data schema");
}

describe("YieldTool", () => {
	it("accepts success payload with data", async () => {
		const tool = new YieldTool(createSession());
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-1", { result: { data: { ok: true } } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("accepts aborted payload with error only", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-2", { result: { error: "blocked" } } as never);
		expect(result.details).toEqual({ data: undefined, status: "aborted", error: "blocked" });
	});

	it("accepts arbitrary data when outputSchema is null", async () => {
		const tool = new YieldTool(createSession({ outputSchema: null }));
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-null", { result: { data: { nested: { x: 1 }, ok: true } } } as never);
		expect(result.details).toEqual({
			data: { nested: { x: 1 }, ok: true },
			status: "success",
			error: undefined,
		});
	});

	it("treats outputSchema true as unconstrained and accepts primitive and array data", async () => {
		const tool = new YieldTool(createSession({ outputSchema: true }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBeUndefined();
		const primitiveResult = await tool.execute("call-true-number", { result: { data: 42 } } as never);
		expect(primitiveResult.details).toEqual({ data: 42, status: "success", error: undefined });

		const arrayResult = await tool.execute("call-true-array", { result: { data: ["ok", 1, false] } } as never);
		expect(arrayResult.details).toEqual({
			data: ["ok", 1, false],
			status: "success",
			error: undefined,
		});
	});

	it("preserves explicit loose object output schemas and disables strict tool mode", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					additionalProperties: true,
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.additionalProperties).toBe(true);

		const result = await tool.execute("call-loose-object", {
			result: { data: { nested: { x: 1 }, ok: true } },
		} as never);
		expect(result.details).toEqual({ data: { nested: { x: 1 }, ok: true }, status: "success", error: undefined });
	});
	it("repairs strict schema generation for required-only object output schemas", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					required: ["data"],
				},
			}),
		);
		const strictParameters = enforceStrictSchema(tool.parameters as unknown as Record<string, unknown>);
		const dataSchema = getSuccessDataSchema(strictParameters);

		expect(tool.strict).toBe(true);
		expect(dataSchema.properties).toEqual({});
		expect(dataSchema.required).toEqual([]);
		expect(dataSchema.additionalProperties).toBe(false);
	});

	it("normalizes object/null type arrays into strict-compatible data variants", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: ["object", "null"],
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		expect(tool.strict).toBe(true);
		expect(Array.isArray(dataSchema.anyOf)).toBe(true);

		const variants = dataSchema.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(objectVariant).toBeDefined();
		expect((objectVariant as Record<string, unknown>).properties).toEqual({ name: { type: "string" } });
		expect((objectVariant as Record<string, unknown>).required).toEqual(["name"]);
		expect(nullVariant).toEqual({ type: "null" });
	});

	it("converts mixed JTD and JSON Schema output definitions into provider-valid schemas", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						results: {
							type: "array",
							elements: {
								properties: {
									issue: { type: "int32" },
								},
							},
						},
					},
					required: ["results"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const resultsSchema = toRecord(toRecord(dataSchema.properties).results);
		const issueSchema = toRecord(toRecord(toRecord(resultsSchema.items).properties).issue);

		expect(resultsSchema.type).toBe("array");
		expect(resultsSchema.items).toBeDefined();
		expect(resultsSchema.elements).toBeUndefined();
		expect(issueSchema.type).toBe("integer");

		await expect(
			tool.execute("call-mixed-valid", { result: { data: { results: [{ issue: 185 }] } } } as never),
		).resolves.toBeDefined();
		await expect(
			tool.execute("call-mixed-invalid", { result: { data: { results: [{ issue: "185" }] } } } as never),
		).rejects.toThrow("Output does not match schema");
	});
	it("supports $defs/$ref output schemas by inlining definitions and degrades after first runtime failure", async () => {
		const outputSchema = {
			$defs: {
				A: {
					type: "object",
					properties: {
						kind: { const: "A" },
						token: { type: "string", minLength: 10 },
					},
					required: ["kind", "token"],
					additionalProperties: false,
				},
			},
			anyOf: [
				{ $ref: "#/$defs/A" },
				{
					type: "object",
					properties: {
						kind: { const: "B" },
						n: { type: "integer", minimum: 10 },
					},
					required: ["kind", "n"],
					additionalProperties: false,
				},
			],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const parametersRecord = tool.parameters as unknown as Record<string, unknown>;
		// $defs should NOT be in parameters — refs are inlined
		expect(parametersRecord.$defs).toBeUndefined();
		const dataSchema = getSuccessDataSchema(parametersRecord);
		// The inlined anyOf[0] should be the A definition (not a $ref)
		const anyOfVariants = dataSchema.anyOf as Array<Record<string, unknown>>;
		expect(anyOfVariants).toBeDefined();
		expect(anyOfVariants[0].$ref).toBeUndefined();
		expect(toRecord(anyOfVariants[0].properties).kind).toBeDefined();

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		const firstCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-1",
			name: tool.name,
			arguments: { result: { data: { kind: "A", token: "x" } } },
		};
		// validateToolArguments should succeed (no $ref to resolve)
		const firstArgs = validateToolArguments(toolDefinition, firstCall);
		// Runtime AJV still validates the original schema — token too short.
		// First MAX_SCHEMA_RETRIES (=3) invalid yields throw with a retry hint.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-ref-${attempt}`, firstArgs as never)).rejects.toThrow(
				"Output does not match schema",
			);
		}

		const overrideCall: ToolCall = {
			type: "toolCall",
			id: "call-ref-override",
			name: tool.name,
			arguments: { result: { data: { kind: "A", token: "x" } } },
		};
		const overrideArgs = validateToolArguments(toolDefinition, overrideCall);
		const overrideResult = await tool.execute("call-ref-override", overrideArgs as never);
		expect(overrideResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 4 failed attempt(s)).",
			},
		]);
	});
	it("falls back to unconstrained object data when output schema is invalid", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						value: { type: "not-a-real-json-schema-type" },
					},
					required: ["value"],
				},
			}),
		);
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const dataSchemaProperties = toRecord(dataSchema.properties);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");
		expect(dataSchemaProperties.value).toBeUndefined();
		expect(Object.keys(dataSchemaProperties)).toHaveLength(0);

		const result = await tool.execute("call-invalid-schema", {
			result: { data: { value: 123, nested: { ok: true } } },
		} as never);
		expect(result.details).toEqual({
			data: { value: 123, nested: { ok: true } },
			status: "success",
			error: undefined,
		});
	});
	it("falls back to unconstrained data schema when output schema is circular", async () => {
		const circularSchema: Record<string, unknown> = { type: "object" };
		circularSchema.self = circularSchema;

		const tool = new YieldTool(createSession({ outputSchema: circularSchema }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-circular-schema", { result: { data: { ok: true } } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("falls back to unconstrained data schema when output schema is deeply nested", async () => {
		const buildDeepSchema = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {
				type: "object",
				properties: {},
				required: ["next"],
			};
			let current = root;

			for (let i = 0; i < depth; i++) {
				const next: Record<string, unknown> = {
					type: "object",
					properties: {},
					required: ["next"],
				};
				const currentProperties = toRecord(current.properties);
				currentProperties.next = next;
				current.properties = currentProperties;
				current = next;
			}

			current.properties = { value: { type: "string" } };
			current.required = ["value"];
			return root;
		};

		const tool = new YieldTool(createSession({ outputSchema: buildDeepSchema(20_000) }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);

		expect(tool.strict).toBe(false);
		expect(dataSchema.type).toBe("object");

		const result = await tool.execute("call-deep-schema", { result: { data: { nested: true } } } as never);
		expect(result.details).toEqual({ data: { nested: true }, status: "success", error: undefined });
	});

	it("handles non-object output schemas without blocking successful result submission", async () => {
		for (const outputSchema of [[], 123, false]) {
			const tool = new YieldTool(createSession({ outputSchema }));
			const result = await tool.execute("call-non-object-schema", {
				result: { data: { value: outputSchema } },
			} as never);
			expect(result.details).toEqual({
				data: { value: outputSchema },
				status: "success",
				error: undefined,
			});
		}
	});
	it("keeps runtime validation against the original output schema", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const dataSchema = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		const tokenSchema = toRecord(toRecord(dataSchema.properties).token);

		expect(tokenSchema.minLength).toBeUndefined();
		await expect(tool.execute("call-short", { result: { data: { token: "ab" } } } as never)).rejects.toThrow(
			"Output does not match schema",
		);

		const result = await tool.execute("call-long", { result: { data: { token: "abcd" } } } as never);
		expect(result.details).toEqual({ data: { token: "abcd" }, status: "success", error: undefined });
	});

	it("retries on schema failures up to MAX_SCHEMA_RETRIES and overrides afterward", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		// First three invalid yields throw with retry guidance.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(
				tool.execute(`call-short-${attempt}`, { result: { data: { token: "ab" } } } as never),
			).rejects.toThrow("Output does not match schema");
		}

		// Fourth invalid yield is accepted with override.
		const overrideResult = await tool.execute("call-short-override", {
			result: { data: { token: "ab" } },
		} as never);
		expect(overrideResult.details).toEqual({
			data: { token: "ab" },
			status: "success",
			error: undefined,
			schemaOverridden: true,
		});
		expect(overrideResult.content).toEqual([
			{
				type: "text",
				text: "Result submitted (schema validation overridden after 4 failed attempt(s)).",
			},
		]);
	});

	it("fails closed after repeated schema failures while an assignment contract is active", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema, assignmentContractActive: true }));

		for (let attempt = 1; attempt <= 5; attempt++) {
			await expect(
				tool.execute(`contract-invalid-${attempt}`, { result: { data: { token: "ab" } } } as never),
			).rejects.toThrow("assignment contract remains enforced");
		}
	});

	it("keeps schema degradation counter at zero when submissions are valid", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		const firstResult = await tool.execute("call-valid-1", { result: { data: { token: "abcd" } } } as never);
		expect(firstResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		const secondResult = await tool.execute("call-valid-2", { result: { data: { token: "abcde" } } } as never);
		expect(secondResult.content).toEqual([{ type: "text", text: "Result submitted." }]);

		await expect(
			tool.execute("call-invalid-after-valid", { result: { data: { token: "ab" } } } as never),
		).rejects.toThrow("Output does not match schema");
	});

	it("rejects nested-array shape mismatches with a retry hint (explore-style JTD)", async () => {
		// Regression for the GLM/explore failure mode: model invents per-file fields
		// (`ref`, `surface`, …) instead of the schema's `path` + `description`. The
		// in-tool validator MUST surface the mismatch with a retry directive so the
		// subagent can fix its output before the parent runs its post-mortem check.
		const outputSchema = {
			properties: {
				summary: { type: "string" },
				files: {
					elements: {
						properties: {
							path: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		};
		const tool = new YieldTool(createSession({ outputSchema }));
		const badPayload = {
			summary: "analysis",
			files: [
				{
					ref: "finding.md",
					surface: "gossip",
					auth: "pre-auth",
					allocation: "unbounded",
					mechanism: "loop",
				},
			],
		};

		await expect(tool.execute("call-explore-1", { result: { data: badPayload } } as never)).rejects.toThrow(
			/files\/0\/path: is required.*Call yield again with the corrected shape/,
		);

		// Third retry still throws with one attempt remaining advertised in the hint.
		await tool.execute("call-explore-2", { result: { data: badPayload } } as never).catch(() => {});
		await expect(tool.execute("call-explore-3", { result: { data: badPayload } } as never)).rejects.toThrow(
			"this is the final retry before the schema constraint is dropped",
		);
	});

	it("still throws structural errors after schema validation has been degraded", async () => {
		const outputSchema = {
			type: "object",
			properties: {
				token: {
					type: "string",
					minLength: 3,
				},
			},
			required: ["token"],
		};
		const tool = new YieldTool(createSession({ outputSchema }));

		// Exhaust the schema-retry budget.
		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(
				tool.execute(`call-struct-${attempt}`, { result: { data: { token: "ab" } } } as never),
			).rejects.toThrow("Output does not match schema");
		}
		await expect(
			tool.execute("call-struct-override", { result: { data: { token: "ab" } } } as never),
		).resolves.toBeDefined();

		// Structural errors (missing result wrapper) still throw even after override.
		await expect(tool.execute("call-struct-missing", {} as never)).rejects.toThrow(
			"result must be an object containing either data or error",
		);
	});
	it("rejects submissions without a result object", async () => {
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
			"result must be an object containing either data or error",
		);
	});
	it("sets lenientArgValidation so agent-loop bypasses validation errors", () => {
		const tool = new YieldTool(createSession());
		expect(tool.lenientArgValidation).toBe(true);
	});
	it("falls back to loose schema when outputSchema contains unresolved external $ref", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						item: { $ref: "https://example.com/missing-schema.json" },
					},
					required: ["item"],
				},
			}),
		);
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-unresolved-ref", {
			result: { data: { item: { whatever: true }, extra: 1 } },
		} as never);
		expect(result.details).toEqual({
			data: { item: { whatever: true }, extra: 1 },
			status: "success",
			error: undefined,
		});
	});

	it("does not treat literal $ref fields inside enum values as unresolved schema references", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					enum: [{ $ref: "literal" }],
				},
			}),
		);

		// Object-valued enums cannot be reduced to a single `type` keyword, so
		// strict mode falls back to non-strict — that's the strict-mode
		// contract, separately exercised in `schema-strict-mode.test.ts`. What
		// this test guards is that the literal `$ref: "literal"` inside the
		// enum value is treated as opaque data (not mistaken for an unresolved
		// schema reference that would discard the enum entirely).
		expect(tool.strict).toBe(false);
		const result = await tool.execute("call-literal-ref-enum", {
			result: { data: { $ref: "literal" } },
		} as never);
		expect(result.details?.data).toEqual({ $ref: "literal" });
		await expect(
			tool.execute("call-invalid-literal-ref-enum", {
				result: { data: { $ref: "different" } },
			} as never),
		).rejects.toThrow("Output does not match schema");
	});
	it("caps recoverable completion-gate reminders and flags the accepted escalation", async () => {
		const contract = {
			objective: "Prove the change",
			deliverables: [],
			completionCriteria: [{ id: "c1", description: "Artifact-backed evidence exists" }],
			nonSolutions: [],
			knownFailureModes: [],
		};
		const tool = new YieldTool(
			createSession({
				getActiveTaskContract: () => contract,
				evaluateRootCompletionGate: evaluateCompletionGate,
			}),
		);
		const weakResult = { evidence: [{ criterionId: "c1", passed: true, summary: "done" }] };

		await expect(tool.execute("gate-reminder-1", { result: { data: weakResult } } as never)).rejects.toThrow(
			"Completion gate",
		);
		await expect(tool.execute("gate-reminder-2", { result: { data: weakResult } } as never)).rejects.toThrow(
			"Completion gate",
		);

		const escalated = await tool.execute("gate-override", { result: { data: weakResult } } as never);
		expect(escalated.details?.gateOverridden).toBe(true);
		expect(escalated.content).toEqual([
			{ type: "text", text: "Result submitted (completion gate overridden after 2 reminder(s))." },
		]);
	});

	it("resets completion-gate reminders when the active contract changes", async () => {
		const firstContract = {
			objective: "Prove the first change",
			deliverables: [],
			completionCriteria: [{ id: "c1", description: "Artifact-backed evidence exists" }],
			nonSolutions: [],
			knownFailureModes: [],
		};
		const secondContract = {
			objective: "Prove the second change",
			deliverables: [],
			completionCriteria: [{ id: "c2", description: "Artifact-backed evidence exists" }],
			nonSolutions: [],
			knownFailureModes: [],
		};
		let activeContract = firstContract;
		const tool = new YieldTool(
			createSession({
				getActiveTaskContract: () => activeContract,
				evaluateRootCompletionGate: evaluateCompletionGate,
			}),
		);

		const weakResult = { evidence: [{ criterionId: "c1", passed: true, summary: "done" }] };
		await expect(tool.execute("gate-first-1", { result: { data: weakResult } } as never)).rejects.toThrow(
			"Completion gate",
		);
		await expect(tool.execute("gate-first-2", { result: { data: weakResult } } as never)).rejects.toThrow(
			"Completion gate",
		);
		await tool.execute("gate-first-override", { result: { data: weakResult } } as never);

		activeContract = secondContract;
		const secondWeakResult = { evidence: [{ criterionId: "c2", passed: true, summary: "done" }] };
		await expect(tool.execute("gate-second-1", { result: { data: secondWeakResult } } as never)).rejects.toThrow(
			"Completion gate",
		);
	});

	it("accepts artifact-backed contract evidence without completion-gate override", async () => {
		const contract = {
			objective: "Prove the change",
			deliverables: [],
			completionCriteria: [{ id: "c1", description: "Artifact-backed evidence exists" }],
			nonSolutions: [],
			knownFailureModes: [],
		};
		const tool = new YieldTool(
			createSession({
				getActiveTaskContract: () => contract,
				evaluateRootCompletionGate: evaluateCompletionGate,
			}),
		);

		const result = await tool.execute("gate-satisfied", {
			result: {
				data: { evidence: [{ criterionId: "c1", passed: true, artifactRefs: ["artifact://1"] }] },
			},
		} as never);

		expect(result.details?.gateOverridden).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Result submitted." }]);
	});
});

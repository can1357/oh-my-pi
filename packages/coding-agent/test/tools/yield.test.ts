import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Model, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { enforceStrictSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { arrayValuedLabels } from "../../src/task/yield-assembly";

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

function makeCodexModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("YieldTool", () => {
	it("accepts success payload with data", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-1", { result: { data: { ok: true } } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("accepts aborted payload with error only", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-2", { result: { error: "blocked" } } as never);
		expect(result.details).toEqual({ data: undefined, status: "aborted", error: "blocked" });
	});

	it("accepts typed success without data as a last-turn result", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-last-turn", { type: "summary", result: {} } as never);
		expect(result.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			type: "summary",
			useLastTurn: true,
		});
	});
	it("finalizes type:'result' with the result wrapper omitted entirely as a last-turn yield", async () => {
		// Gemini-flash traces: the description invites omitting `data`, and weak
		// callers omit the whole `result` wrapper with it. Must not bounce with
		// a retryable format error.
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-wrapperless-last-turn", { type: "result" } as never);
		expect(result.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			type: "result",
			useLastTurn: true,
		});
	});
	it("rejects a schema-bound last-turn finalize with no accumulated sections as retryable", async () => {
		// Instruction-followed punt observed in Gemini traces: `{type:"result"}`
		// with a declared output schema. Accepting it terminates the child and
		// finalization then fails post-mortem with an uncorrectable
		// schema_violation; the tool must bounce it in-band instead.
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
				},
			}),
		);
		await expect(tool.execute("call-schema-punt", { type: "result" } as never)).rejects.toThrow(
			/structured output matching the declared schema/,
		);
	});

	it("accepts a data-less finalize after incremental sections even when schema-bound", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { findings: { type: "array", items: { type: "string" } } },
					required: ["findings"],
				},
			}),
		);
		const section = await tool.execute("call-section", {
			type: ["findings"],
			result: { data: "one finding" },
		} as never);
		expect(section.details?.status).toBe("success");
		const finalize = await tool.execute("call-finalize", { type: "result" } as never);
		expect(finalize.details).toEqual({
			data: undefined,
			status: "success",
			error: undefined,
			type: "result",
			useLastTurn: true,
		});
	});

	it("salvages a top-level data payload missing the result wrapper", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-unwrapped-data", { data: { ok: true } } as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("salvages a top-level error missing the result wrapper", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-unwrapped-error", { error: "blocked" } as never);
		expect(result.details).toEqual({ data: undefined, status: "aborted", error: "blocked" });
	});

	it("parses a JSON-string result envelope losslessly", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-string-envelope", {
			result: '{"data":{"ok":true}}',
		} as never);
		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("parses JSON-string data when the schema rejects the string form", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { n: { type: "number" } },
					required: ["n"],
				},
			}),
		);
		const result = await tool.execute("call-string-data", { result: { data: '{"n":4}' } } as never);
		expect(result.details).toEqual({ data: { n: 4 }, status: "success", error: undefined });
	});

	it("arg validation serializes object payloads for string-typed output fields", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
				},
			}),
		);
		expect(
			validateToolArguments(tool as never, {
				type: "toolCall",
				id: "call-dict-summary",
				name: "yield",
				arguments: { result: { data: { summary: { purge: 13, keep: 20 } } } },
			}),
		).toEqual({ result: { data: { summary: '{"purge":13,"keep":20}' } } });
	});

	it("arg validation passes conforming args through unmodified", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { summary: { type: "string" } },
					required: ["summary"],
				},
			}),
		);
		const args = { result: { data: { summary: "all good" } } };
		const validated = validateToolArguments(tool as never, {
			type: "toolCall",
			id: "call-clean",
			name: "yield",
			arguments: args,
		});
		expect(validated).toEqual(args);
	});

	it("passes array-typed success through as an incremental result", async () => {
		const tool = new YieldTool(createSession());
		const result = await tool.execute("call-incremental", {
			type: ["notes", "plan"],
			result: { data: { step: 1 } },
		} as never);
		expect(result.details).toEqual({
			data: { step: 1 },
			status: "success",
			error: undefined,
			type: ["notes", "plan"],
		});
	});

	it("does not validate incremental array-typed sections against the full output schema", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: {
						overall_correctness: { type: "string" },
						explanation: { type: "string" },
						confidence: { type: "number" },
					},
					required: ["overall_correctness", "explanation", "confidence"],
				},
			}),
		);
		// A single finding cannot satisfy the full schema, but an incremental
		// (array-typed) section is a partial and must be accepted without retry.
		const result = await tool.execute("call-incremental-partial", {
			type: ["findings"],
			result: { data: { title: "bug", body: "details" } },
		} as never);
		expect(result.details).toEqual({
			data: { title: "bug", body: "details" },
			status: "success",
			error: undefined,
			type: ["findings"],
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});
	});

	it("validates incremental sections against per-label sub-schemas with retry feedback", async () => {
		// Regression for issue #3870: DeepSeek emits `type: ["overall_correctness"]` with
		// non-enum values like "Correct" or "approved". The yield tool used to skip
		// validation for incremental yields entirely, so the model got no retry feedback
		// and the parent saw a fatal `schema_violation` post-mortem.
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					properties: {
						overall_correctness: { enum: ["correct", "incorrect"] },
						explanation: { type: "string" },
						confidence: { type: "number" },
					},
					optionalProperties: {
						findings: {
							elements: { properties: { title: { type: "string" }, body: { type: "string" } } },
						},
					},
				},
			}),
		);

		// Attempt 1: off-enum value rejected with the section label in the error.
		await expect(
			tool.execute("call-bad-1", { type: ["overall_correctness"], result: { data: "Correct" } } as never),
		).rejects.toThrow(/Section "overall_correctness" does not match schema.*2 retry attempt\(s\) remain/);

		// Attempt 2 and 3 advertise dwindling retries; attempt 3 names this as the last one.
		await expect(
			tool.execute("call-bad-2", { type: ["overall_correctness"], result: { data: "correct." } } as never),
		).rejects.toThrow(/1 retry attempt\(s\) remain/);
		await expect(
			tool.execute("call-bad-3", { type: ["overall_correctness"], result: { data: "approved" } } as never),
		).rejects.toThrow(/this is the final retry/);

		// 4th invalid yield is accepted with schemaOverridden so the parent still gets a result.
		const overrideResult = await tool.execute("call-bad-4", {
			type: ["overall_correctness"],
			result: { data: "still-wrong" },
		} as never);
		expect(overrideResult.details?.schemaOverridden).toBe(true);

		// A fresh tool accepts a valid enum value without ticking the counter.
		const fresh = new YieldTool(
			createSession({
				outputSchema: {
					properties: {
						overall_correctness: { enum: ["correct", "incorrect"] },
						explanation: { type: "string" },
						confidence: { type: "number" },
					},
				},
			}),
		);
		const valid = await fresh.execute("call-good", {
			type: ["overall_correctness"],
			result: { data: "correct" },
		} as never);
		expect(valid.details).toEqual({
			data: "correct",
			status: "success",
			error: undefined,
			type: ["overall_correctness"],
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});
	});

	it("validates incremental items for array-typed labels against the element schema", async () => {
		// Each `type: ["findings"]` yield is one finding; the per-call validator runs against the
		// items schema (not the array schema), so a missing required field surfaces immediately
		// instead of being swallowed by the post-mortem assembly.
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					optionalProperties: {
						findings: {
							elements: {
								properties: {
									title: { type: "string" },
									body: { type: "string" },
								},
							},
						},
					},
				},
			}),
		);

		const accepted = await tool.execute("call-finding-ok", {
			type: ["findings"],
			result: { data: { title: "bug", body: "details" } },
		} as never);
		expect(accepted.details?.data).toEqual({ title: "bug", body: "details" });

		await expect(
			tool.execute("call-finding-missing", {
				type: ["findings"],
				result: { data: { title: "only-title" } },
			} as never),
		).rejects.toThrow(/Section "findings" does not match schema.*body/);
	});

	it("leaves user-defined section labels unconstrained", async () => {
		// Open JSON Schema output contracts can still use scratchpad/streaming
		// sections that the agent invents at runtime, so unknown labels stay loose.
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					additionalProperties: true,
					properties: {
						overall_correctness: { enum: ["correct", "incorrect"] },
						explanation: { type: "string" },
						confidence: { type: "number" },
					},
				},
			}),
		);
		const result = await tool.execute("call-scratchpad", {
			type: ["scratchpad"],
			result: { data: { anything: "goes", n: 3 } },
		} as never);
		expect(result.details?.data).toEqual({ anything: "goes", n: 3 });
	});

	it("rejects unknown incremental labels for closed caller output schemas without consuming retries", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					properties: {
						issue_key: { type: "string" },
						verdict: { enum: ["clean", "blockers"] },
					},
					optionalProperties: {
						blockers: {
							elements: { properties: { title: { type: "string" } } },
						},
						non_blocking_notes: {
							elements: { type: "string" },
						},
					},
				},
			}),
		);

		// Unknown labels are a hard contract mismatch with the caller schema. They MUST
		// reject every time with the schema's labels listed and never bump the retry
		// counter — otherwise the MAX_SCHEMA_RETRIES override accepts the stale-label
		// payload and the post-mortem finalizer takes it as success (issue #3927 review).
		for (let attempt = 1; attempt <= 5; attempt++) {
			await expect(
				tool.execute(`call-native-reviewer-label-${attempt}`, {
					type: ["findings"],
					result: { data: { title: "native reviewer finding" } },
				} as never),
			).rejects.toThrow(
				/Section "findings" uses unknown incremental yield label\(s\): "findings"\. Resubmit with one of the schema's labels: "issue_key", "verdict", "blockers", "non_blocking_notes"\./,
			);
		}

		// The last-turn short-circuit (`type: ["findings"], result: {}`) MUST also reject
		// the unknown label. Otherwise the stale section silently accepts the last assistant
		// text and rides along when a sibling section trips MAX_SCHEMA_RETRIES and
		// schemaOverridden in finalization (issue #3927 follow-up review).
		await expect(
			tool.execute("call-native-reviewer-label-last-turn", {
				type: ["findings"],
				result: {},
			} as never),
		).rejects.toThrow(
			/Section "findings" uses unknown incremental yield label\(s\): "findings"\. Resubmit with one of the schema's labels: "issue_key", "verdict", "blockers", "non_blocking_notes"\./,
		);

		// Schema-retry budget intact: a separate, shape-only mismatch still fires the
		// first-attempt retry hint (`2 retry attempt(s) remain`), proving the unknown-label
		// path didn't burn the override.
		await expect(
			tool.execute("call-shape-error", {
				type: ["verdict"],
				result: { data: "approved" },
			} as never),
		).rejects.toThrow(/Section "verdict" does not match schema.*2 retry attempt\(s\) remain/);
	});

	it("rejects unknown incremental labels when the closed caller schema is a root $ref into $defs", async () => {
		// Caller schemas exported as `{ $ref: "#/$defs/Closed", $defs: { Closed: ... } }` MUST
		// resolve the root ref before the yield tool derives the valid-label set and the
		// closed-schema flag. Otherwise stale labels slip past the yield gate and only fail
		// later as a parent-side schema_violation (#3927 follow-up review).
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					$ref: "#/$defs/Closed",
					$defs: {
						Closed: {
							type: "object",
							properties: {
								issue_key: { type: "string" },
								verdict: { enum: ["clean", "blockers"] },
							},
							required: ["issue_key", "verdict"],
							additionalProperties: false,
						},
					},
				},
			}),
		);

		await expect(
			tool.execute("call-rooted-ref-stale-label", {
				type: ["findings"],
				result: { data: { title: "native reviewer finding" } },
			} as never),
		).rejects.toThrow(
			/Section "findings" uses unknown incremental yield label\(s\): "findings"\. Resubmit with one of the schema's labels: "issue_key", "verdict"\./,
		);
	});

	it("accepts schema-declared closed labels without concrete per-section validators", async () => {
		const permissiveKnownLabel = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					properties: { notes: true },
					additionalProperties: false,
				},
			}),
		);
		const known = await permissiveKnownLabel.execute("call-boolean-schema-label", {
			type: ["notes"],
			result: { data: "plain text note" },
		} as never);
		expect(known.details?.data).toBe("plain text note");

		const patternBackedLabel = new YieldTool(
			createSession({
				outputSchema: {
					type: "object",
					patternProperties: {
						"^section_[a-z]+$": { type: "object", additionalProperties: true },
					},
					additionalProperties: false,
				},
			}),
		);
		const pattern = await patternBackedLabel.execute("call-pattern-schema-label", {
			type: ["section_alpha"],
			result: { data: { ok: true } },
		} as never);
		expect(pattern.details?.data).toEqual({ ok: true });
		await expect(
			patternBackedLabel.execute("call-pattern-schema-miss", {
				type: ["findings"],
				result: { data: { title: "native reviewer finding" } },
			} as never),
		).rejects.toThrow(/unknown incremental yield label/);
	});

	it("rejects unknown incremental labels when allOf contains a closed caller schema", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					allOf: [
						{
							type: "object",
							properties: {
								issue_key: { type: "string" },
								verdict: { enum: ["clean", "blockers"] },
							},
							required: ["issue_key", "verdict"],
							additionalProperties: false,
						},
					],
				},
			}),
		);

		await expect(
			tool.execute("call-allof-stale-label", {
				type: ["findings"],
				result: { data: { title: "native reviewer finding" } },
			} as never),
		).rejects.toThrow(
			/Section "findings" uses unknown incremental yield label\(s\): "findings"\. Resubmit with one of the schema's labels: "issue_key", "verdict"\./,
		);
	});

	it("rejects unknown incremental labels for JTD discriminator (oneOf-of-closed) caller schemas", async () => {
		// JTD discriminator output schemas compile to a top-level `oneOf` of closed object
		// variants (no root `additionalProperties: false`, no `allOf`). Closure MUST be derived
		// across the union — otherwise a stale label is accepted here and, once a sibling section
		// exhausts MAX_SCHEMA_RETRIES, finalizeSubprocessOutput honors schemaOverridden and the
		// stale label lands in a "successful" result (PR #3927 review).
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					discriminator: "verdict",
					mapping: {
						clean: {
							properties: { issue_key: { type: "string" } },
						},
						blockers: {
							properties: { issue_key: { type: "string" } },
							optionalProperties: {
								blockers: { elements: { properties: { title: { type: "string" } } } },
							},
						},
					},
				},
			}),
		);

		await expect(
			tool.execute("call-jtd-discriminator-stale-label", {
				type: ["findings"],
				result: { data: { title: "native reviewer finding" } },
			} as never),
		).rejects.toThrow(
			/Section "findings" uses unknown incremental yield label\(s\): "findings"\. Resubmit with one of the schema's labels: "issue_key", "verdict", "blockers"\./,
		);

		// A label declared by only ONE variant is known: union semantics are disjunctive, the
		// assembled output only has to match one variant.
		const singleVariantLabel = await tool.execute("call-jtd-discriminator-variant-label", {
			type: ["blockers"],
			result: { data: { title: "blocker from the blockers variant" } },
		} as never);
		expect(singleVariantLabel.details?.data).toEqual({ title: "blocker from the blockers variant" });

		// The discriminator property itself is declared by every variant.
		const discriminatorLabel = await tool.execute("call-jtd-discriminator-tag-label", {
			type: ["verdict"],
			result: { data: "blockers" },
		} as never);
		expect(discriminatorLabel.details?.data).toBe("blockers");
	});

	it("does not gate incremental labels when a oneOf variant is open", async () => {
		// One open variant (`additionalProperties` not false) accepts arbitrary top-level
		// properties, so the union places no constraint on labels — engaging the gate would
		// reject labels the schema actually allows.
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					oneOf: [
						{
							type: "object",
							properties: {
								issue_key: { type: "string" },
								verdict: { enum: ["clean", "blockers"] },
							},
							required: ["issue_key", "verdict"],
							additionalProperties: false,
						},
						{
							type: "object",
							properties: { notes: { type: "string" } },
						},
					],
				},
			}),
		);

		const result = await tool.execute("call-open-variant-label", {
			type: ["findings"],
			result: { data: { title: "accepted because one variant is open" } },
		} as never);
		expect(result.details?.data).toEqual({ title: "accepted because one variant is open" });
	});

	it("detects array-valued labels when the closed caller schema is a root $ref", () => {
		const labels = arrayValuedLabels({
			$ref: "#/$defs/Closed",
			$defs: {
				Closed: {
					type: "object",
					properties: {
						blockers: {
							type: "array",
							items: { type: "object", properties: { title: { type: "string" } } },
						},
					},
					additionalProperties: false,
				},
			},
		});

		expect(labels.has("blockers")).toBe(true);
	});

	it("rejects missing success data unless a yield type requests last-turn mode", async () => {
		const tool = new YieldTool(createSession());
		await expect(tool.execute("call-untyped-empty", { result: {} } as never)).rejects.toThrow(
			"result must contain either `data` or `error`",
		);
		await expect(tool.execute("call-empty-type", { type: [], result: {} } as never)).rejects.toThrow(
			"type must be a string or non-empty array of strings",
		);
		await expect(
			tool.execute("call-null-data", { type: "summary", result: { data: null } } as never),
		).rejects.toThrow("data is required when yield indicates success");
	});

	it("aborts instead of throwing forever after repeated untyped empty results", async () => {
		const tool = new YieldTool(createSession());
		const expectedGuidance =
			'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.';

		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-empty-retry-${attempt}`, { result: {} } as never)).rejects.toThrow(
				expectedGuidance,
			);
		}

		const abortResult = await tool.execute("call-empty-abort", { result: {} } as never);
		const details = abortResult.details;
		if (!details) throw new Error("missing abort details");
		expect(details.status).toBe("aborted");
		expect(details.data).toBeUndefined();
		expect(String(details.error)).toContain("retrying forever");
		expect(abortResult.content).toEqual([{ type: "text", text: expect.stringContaining("Task aborted") }]);
	});

	it("resets the untyped empty-result retry budget after a valid yield", async () => {
		const tool = new YieldTool(createSession());
		const expectedGuidance =
			'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.';

		for (let attempt = 1; attempt <= 2; attempt++) {
			await expect(tool.execute(`call-empty-before-valid-${attempt}`, { result: {} } as never)).rejects.toThrow(
				expectedGuidance,
			);
		}

		const validResult = await tool.execute("call-valid-reset", { result: { data: { ok: true } } } as never);
		expect(validResult.details).toEqual({ data: { ok: true }, status: "success", error: undefined });

		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(tool.execute(`call-empty-after-valid-${attempt}`, { result: {} } as never)).rejects.toThrow(
				expectedGuidance,
			);
		}

		const abortResult = await tool.execute("call-empty-after-reset-abort", { result: {} } as never);
		const details = abortResult.details;
		if (!details) throw new Error("missing abort details");
		expect(details.status).toBe("aborted");
		expect(details.data).toBeUndefined();
		expect(String(details.error)).toContain("retrying forever");
		expect(abortResult.content).toEqual([{ type: "text", text: expect.stringContaining("Task aborted") }]);
	});

	it("exposes typed last-turn mode in the argument schema", () => {
		const tool = new YieldTool(createSession());
		const parameters = tool.parameters as unknown as Record<string, unknown>;
		const typeSchema = toRecord(toRecord(parameters.properties).type);
		const variants = Array.isArray(typeSchema.anyOf) ? typeSchema.anyOf.map(toRecord) : [];

		expect(variants.map(variant => variant.type)).toEqual(["string", "array"]);
		expect(variants[1]?.minItems).toBe(1);
		expect(toRecord(variants[1]?.items).type).toBe("string");

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		// A typed yield may omit data (last-turn extraction). The untyped empty-result
		// case is rejected at runtime by execute(), NOT the schema — a top-level
		// combinator expressing that constraint would break OpenAI/Codex strict mode.
		expect(
			validateToolArguments(toolDefinition, {
				type: "toolCall",
				id: "call-schema-typed",
				name: tool.name,
				arguments: { type: "summary", result: {} },
			}),
		).toEqual({ type: "summary", result: {} });
	});

	it("emits Codex-valid yield parameters: no top-level combinator under strict mode", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			}),
		);
		expect(tool.strict).toBe(true);

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: tool.strict,
		};
		const [converted] = convertOpenAICodexResponsesTools([toolDefinition], makeCodexModel());
		if (converted.type !== "function") throw new Error("expected a function tool payload");
		expect(converted.strict).toBe(true);

		const params = converted.parameters;
		expect(params.type).toBe("object");
		// OpenAI/Codex Responses reject a function whose parameters carry any of these
		// at the top level (the bug this guards against).
		for (const combinator of ["allOf", "anyOf", "oneOf", "enum", "const", "not"]) {
			expect(params[combinator]).toBeUndefined();
		}
		// Strict enforcement makes the optional `type` property required + nullable,
		// so the model signals "no type" with `type: null`.
		const typeProp = toRecord(toRecord(params.properties).type);
		const typeVariants = Array.isArray(typeProp.anyOf) ? typeProp.anyOf.map(toRecord) : [];
		expect(typeVariants.some(variant => variant.type === "null")).toBe(true);
	});

	it("accepts a strict null `type` as an untyped final success", async () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
			}),
		);
		const result = await tool.execute("call-null-type", {
			type: null,
			result: { data: { answer: "ok" } },
		} as never);
		expect(result.details).toEqual({
			data: { answer: "ok" },
			status: "success",
			error: undefined,
			type: undefined,
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});
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
		const dataUnion = getSuccessDataSchema(tool.parameters as unknown as Record<string, unknown>);
		// `data` is now a section-variant union; the full-output object is the first branch.
		const dataSchema = toRecord(Array.isArray(dataUnion.anyOf) ? dataUnion.anyOf[0] : dataUnion);
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

	it("expands section variants so a strict reviewer can submit one incremental section", () => {
		const tool = new YieldTool(
			createSession({
				outputSchema: {
					properties: {
						overall_correctness: { enum: ["correct", "incorrect"] },
						explanation: { type: "string" },
						confidence: { type: "number" },
					},
					optionalProperties: {
						findings: {
							elements: {
								properties: {
									title: { type: "string" },
									body: { type: "string" },
									priority: { type: "number" },
								},
							},
						},
					},
				},
			}),
		);

		expect(tool.strict).toBe(true);

		const toolDefinition: Tool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: tool.strict,
		};

		// One incremental finding (a single element, not the full output) must validate.
		expect(
			validateToolArguments(toolDefinition, {
				type: "toolCall",
				id: "call-one-finding",
				name: tool.name,
				arguments: { type: ["findings"], result: { data: { title: "t", body: "b", priority: 1 } } },
			}),
		).toBeDefined();
		// A lone verdict value must validate too.
		expect(
			validateToolArguments(toolDefinition, {
				type: "toolCall",
				id: "call-verdict",
				name: tool.name,
				arguments: { type: ["overall_correctness"], result: { data: "incorrect" } },
			}),
		).toBeDefined();
		// The full terminal output still validates.
		expect(
			validateToolArguments(toolDefinition, {
				type: "toolCall",
				id: "call-full",
				name: tool.name,
				arguments: {
					result: { data: { overall_correctness: "incorrect", explanation: "x", confidence: 0.5 } },
				},
			}),
		).toBeDefined();

		// Stays Codex-valid: strict, no top-level combinator.
		const [converted] = convertOpenAICodexResponsesTools([toolDefinition], makeCodexModel());
		if (converted.type !== "function") throw new Error("expected a function tool payload");
		expect(converted.strict).toBe(true);
		for (const combinator of ["allOf", "anyOf", "oneOf", "enum", "const", "not"]) {
			expect(converted.parameters[combinator]).toBeUndefined();
		}
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

	it("rejects nested-array shape mismatches with a retry hint (scout-style JTD)", async () => {
		// Regression for the GLM/scout failure mode: model invents per-file fields
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

		await expect(tool.execute("call-scout-1", { result: { data: badPayload } } as never)).rejects.toThrow(
			/files\/0\/path: is required.*Call yield again with the corrected shape/,
		);

		// Third retry still throws with one attempt remaining advertised in the hint.
		await tool.execute("call-scout-2", { result: { data: badPayload } } as never).catch(() => {});
		await expect(tool.execute("call-scout-3", { result: { data: badPayload } } as never)).rejects.toThrow(
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
			'Submit success as {"result":{"data":<your output>}} or failure as {"result":{"error":"message"}}.',
		);
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
});

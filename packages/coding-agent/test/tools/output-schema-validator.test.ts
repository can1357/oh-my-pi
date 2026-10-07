import { describe, expect, it } from "bun:test";
import {
	buildOutputValidator,
	computeMissingRequired,
	extractRequiredFields,
	formatAllValidationIssues,
	formatValidationIssueHeadline,
	summarizeValidationFailure,
} from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";

describe("buildOutputValidator", () => {
	it("returns the empty result for an absent schema", () => {
		const result = buildOutputValidator(undefined);
		expect(result).toEqual({});
	});

	it("returns `normalized: true` (no validator) for an unconstrained schema so callers can distinguish from absent", () => {
		const result = buildOutputValidator(true);
		expect(result.validator).toBeUndefined();
		expect(result.jsonSchema).toBeUndefined();
		expect(result.normalized).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("errors on a boolean false schema (rejects all inputs)", () => {
		const result = buildOutputValidator(false);
		expect(result.error).toBe("boolean false schema rejects all outputs");
		expect(result.validator).toBeUndefined();
	});

	it("validates against a reused schema object's current declaration after it is edited", () => {
		const schema = { properties: { result: { type: "string" } } };
		expect(buildOutputValidator(schema).validator?.validate({ result: "ok" }).success).toBe(true);
		schema.properties.result.type = "int32";
		const { validator } = buildOutputValidator(schema);
		expect(validator?.validate({ result: 7 }).success).toBe(true);
		expect(validator?.validate({ result: "ok" }).success).toBe(false);
	});

	it("reuses identical content without aliasing later caller mutations or freezing normalization to the old declaration", () => {
		const schema = {
			type: "object",
			properties: {
				rows: { type: "array", items: {
					type: "object", properties: { value: { type: "string" }, detail: { type: "string" } },
					required: ["value"], additionalProperties: false,
				} },
			},
			required: ["rows"],
			additionalProperties: false,
		};
		const first = buildOutputValidator(schema);
		expect(buildOutputValidator(JSON.parse(JSON.stringify(schema)))).toBe(first);
		schema.properties.rows.items.properties.value.type = "number";
		const next = buildOutputValidator(schema);
		expect(next).not.toBe(first);
		const oldBatch = [{ value: "old", detail: null }];
		expect(first.validator?.normalizeSection("rows", oldBatch)).toEqual([{ value: "old" }]);
		expect(first.validator?.validateSection.get("rows")?.([{ value: "old" }]).success).toBe(true);
		expect(next.validator?.validateSection.get("rows")?.([{ value: "old" }]).success).toBe(false);
		expect(next.validator?.validateSection.get("rows")?.([{ value: 1 }]).success).toBe(true);
		// Exceed the native 32-entry cache and check that an evicted schema is rebuilt, not corrupted.
		for (let index = 0; index < 33; index++) {
			buildOutputValidator({ type: "string", enum: [`cache-${index}`] });
		}
		const rebuilt = buildOutputValidator(schema);
		expect(rebuilt).not.toBe(next);
		expect(rebuilt.validator?.validate({ rows: [{ value: 1 }] }).success).toBe(true);
		expect(first.validator?.validate({ rows: [{ value: "old" }] }).success).toBe(true);
	});

	it("errors on a malformed JSON Schema", () => {
		const result = buildOutputValidator({
			type: "object",
			properties: { x: { type: "not-a-real-type" } },
		});
		expect(result.error).toBe("invalid JSON schema");
	});

	it("builds a validator that accepts conforming JTD payloads and rejects shape mismatches", () => {
		const { validator, jsonSchema } = buildOutputValidator({
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
		});
		expect(validator).toBeDefined();
		expect(jsonSchema).toBeDefined();
		expect(validator?.requiredFields).toEqual(["summary", "files"]);

		const good = { summary: "ok", files: [{ path: "a.md", description: "d" }] };
		expect(validator?.validate(good).success).toBe(true);

		const bad = { summary: "ok", files: [{ ref: "a.md", surface: "g" }] };
		const r = validator?.validate(bad);
		expect(r?.success).toBe(false);
		const issues = r?.success === false ? r.issues : [];
		// All four problems surface: missing `path`, missing `description`, extra `ref`, extra `surface`.
		expect(issues.map(i => i.keyword).sort()).toEqual([
			"additionalProperties",
			"additionalProperties",
			"required",
			"required",
		]);
	});

	it("honors explicit JTD nullable properties and still rejects null for required non-nullable fields", () => {
		const { validator } = buildOutputValidator({
			properties: {
				name: { type: "string" },
				receipt: { properties: { id: { type: "string" } }, nullable: true },
			},
			optionalProperties: { blocker: { type: "string", nullable: true } },
		});
		expect(validator?.validate({ name: "done", receipt: null, blocker: null }).success).toBe(true);
		expect(validator?.validate({ name: null, receipt: null }).success).toBe(false);
	});

	it("exposes per-label validators for single items and batches while rejecting invalid elements", () => {
		const { validator } = buildOutputValidator({
			properties: {
				overall_correctness: { enum: ["correct", "incorrect"] },
				explanation: { type: "string" },
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: { title: { type: "string" }, body: { type: "string" } },
					},
				},
			},
		});
		expect(validator).toBeDefined();
		const sections = validator?.validateSection;
		expect(sections).toBeDefined();
		// Scalar enum: per-section validator enforces the enum directly.
		expect(sections?.get("overall_correctness")?.("correct").success).toBe(true);
		expect(sections?.get("overall_correctness")?.("Correct").success).toBe(false);
		// String property: any string passes, non-strings fail.
		expect(sections?.get("explanation")?.("ok").success).toBe(true);
		expect(sections?.get("explanation")?.(123).success).toBe(false);
		// Array sections accept either an item or a batch; an invalid batch element still fails.
		expect(sections?.get("findings")?.({ title: "t", body: "b" }).success).toBe(true);
		expect(sections?.get("findings")?.([{ title: "t", body: "b" }]).success).toBe(true);
		expect(sections?.get("findings")?.([{ title: "t", body: "b" }, { title: "missing body" }]).success).toBe(false);
		// Unknown labels have no validator so user-defined sections stay loose.
		expect(sections?.has("scratchpad")).toBe(false);
	});

	for (const keyword of ["oneOf", "anyOf"] as const) {
		it(`normalizes optional nulls only through a valid ${keyword} branch and preserves its required nulls`, () => {
			const { validator } = buildOutputValidator({
				[keyword]: [
					{ type: "object", properties: { kind: { const: "optional" }, note: { type: "string" } },
						required: ["kind"], additionalProperties: false },
					{ type: "object", properties: { kind: { const: "required" }, note: { type: "string" } },
						required: ["kind", "note"], additionalProperties: false },
				],
			});
			const optional = validator?.normalize({ kind: "optional", note: null });
			expect(optional).toEqual({ kind: "optional" });
			expect(validator?.validate(optional).success).toBe(true);
			const required = validator?.normalize({ kind: "required", note: null });
			expect(required).toEqual({ kind: "required", note: null });
			expect(validator?.validate(required).success).toBe(false);
			// A branch-local cleanup is not sufficient if the original union still rejects the candidate.
			const unknown = validator?.normalize({ kind: "unknown", note: null });
			expect(unknown).toEqual({ kind: "unknown", note: null });
			expect(validator?.validate(unknown).success).toBe(false);
		});
	}
});
describe("summarizeValidationFailure", () => {
	it("returns an empty summary when the result is a success", () => {
		const summary = summarizeValidationFailure({ success: true, issues: [] }, {}, []);
		expect(summary).toEqual({ message: "", missingRequired: [] });
	});

	it("uses the first issue as the headline and reports missing required fields", () => {
		const { validator } = buildOutputValidator({
			properties: { a: { type: "string" }, b: { type: "string" } },
		});
		const result = validator?.validate({ a: "hi" });
		expect(result?.success).toBe(false);
		const summary = summarizeValidationFailure(result!, { a: "hi" }, validator?.requiredFields ?? []);
		expect(summary.missingRequired).toEqual(["b"]);
		expect(summary.message).toMatch(/b: is required/);
	});
});

describe("formatValidationIssueHeadline", () => {
	it("joins paths with dots and falls back to `(root)` for empty paths", () => {
		expect(
			formatValidationIssueHeadline({ path: ["files", 0, "path"], message: "is required", keyword: "required" }),
		).toBe("files.0.path: is required");
		expect(formatValidationIssueHeadline({ path: [], message: "top-level error", keyword: "type" })).toBe(
			"(root): top-level error",
		);
		expect(formatValidationIssueHeadline(undefined)).toBeUndefined();
	});
});

describe("formatAllValidationIssues", () => {
	it("joins every issue with `; ` using slash-separated paths so callers see the whole failure set", () => {
		const out = formatAllValidationIssues([
			{ path: ["files", 0, "path"], message: "is required", keyword: "required" },
			{ path: ["files", 0, "ref"], message: "must not be present", keyword: "additionalProperties" },
		]);
		expect(out).toBe("files/0/path: is required; files/0/ref: must not be present");
	});

	it("handles the empty list with a sentinel message instead of an empty string", () => {
		expect(formatAllValidationIssues(undefined)).toBe("Unknown schema validation error.");
		expect(formatAllValidationIssues([])).toBe("Unknown schema validation error.");
	});
});

describe("extractRequiredFields / computeMissingRequired", () => {
	it("extractRequiredFields returns the top-level required array or empty", () => {
		expect(extractRequiredFields({ required: ["a", "b"] })).toEqual(["a", "b"]);
		expect(extractRequiredFields({ properties: {} })).toEqual([]);
		expect(extractRequiredFields(null)).toEqual([]);
		expect(extractRequiredFields(undefined)).toEqual([]);
	});

	it("computeMissingRequired flags absent and explicit-undefined keys, treats non-objects as having all missing", () => {
		expect(computeMissingRequired(["a", "b"], { a: 1, b: 2 })).toEqual([]);
		expect(computeMissingRequired(["a", "b"], { a: 1 })).toEqual(["b"]);
		expect(computeMissingRequired(["a", "b"], { a: 1, b: undefined })).toEqual(["b"]);
		expect(computeMissingRequired(["a"], null)).toEqual(["a"]);
		expect(computeMissingRequired(["a"], 42)).toEqual([]);
		expect(computeMissingRequired(["a"], [])).toEqual([]);
		expect(computeMissingRequired([], { x: 1 })).toEqual([]);
	});
});

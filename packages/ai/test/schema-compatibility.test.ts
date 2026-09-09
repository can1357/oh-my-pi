import { describe, expect, it } from "bun:test";
import {
	adaptSchemaForStrict,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	type SchemaCompatibilityResult,
	validateSchemaCompatibility,
	validateStrictSchemaEnforcement,
} from "@oh-my-pi/pi-ai/utils/schema";

function hasRule(result: SchemaCompatibilityResult, rule: string): boolean {
	return result.violations.some(violation => violation.rule === rule);
}

describe("schema compatibility validation", () => {
	it("validates strict-mode schemas after enforcement", () => {
		const strictResult = adaptSchemaForStrict(
			{
				type: "object",
				properties: {
					requiredText: { type: "string" },
					optionalCount: { type: "number" },
				},
				required: ["requiredText"],
			},
			true,
		);

		expect(strictResult.strict).toBe(true);

		const compatibility = validateSchemaCompatibility(strictResult.schema, "openai-strict");
		expect(compatibility.compatible).toBe(true);
		expect(compatibility.violations).toEqual([]);
	});

	it("validates strict-mode fail-open contract when enforcement falls back", () => {
		const originalSchema = {
			type: "object",
			properties: {
				broken: {
					type: "array",
					items: {},
				},
			},
			required: ["broken"],
		} as Record<string, unknown>;

		const strictResult = adaptSchemaForStrict(originalSchema, true);
		expect(strictResult.strict).toBe(false);

		const compatibility = validateStrictSchemaEnforcement(originalSchema, strictResult);
		expect(compatibility.compatible).toBe(true);
		expect(compatibility.violations).toEqual([]);
	});

	it("reports strict-mode violations for incompatible schemas", () => {
		const compatibility = validateSchemaCompatibility(
			{
				type: "object",
				properties: {
					name: { type: "string" },
				},
				required: [],
			},
			"openai-strict",
		);

		expect(compatibility.compatible).toBe(false);
		expect(hasRule(compatibility, "strict-object-required")).toBe(true);
	});

	it("validates Google-compatible schemas after sanitization", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			additionalProperties: false,
			properties: {
				pattern: { type: "string", description: "property name that matches schema keyword" },
				status: { type: ["string", "null"], const: "active" },
			},
			required: ["status"],
		});

		const compatibility = validateSchemaCompatibility(sanitized, "google");
		expect(compatibility.compatible).toBe(true);
		expect(compatibility.violations).toEqual([]);
	});

	it("reports Google violations for unsupported schema features", () => {
		const compatibility = validateSchemaCompatibility(
			{
				type: ["string", "null"],
				additionalProperties: false,
			},
			"google",
		);

		expect(compatibility.compatible).toBe(false);
		expect(hasRule(compatibility, "google-type-array")).toBe(true);
		expect(hasRule(compatibility, "google-forbidden-key")).toBe(true);
	});

	it("validates Cloud Code Assist Claude schemas after normalization", () => {
		const prepared = normalizeSchemaForCCA({
			type: "object",
			properties: {
				mode: { anyOf: [{ const: "fast" }, { const: "safe" }, { type: "null" }] },
			},
			required: ["mode"],
		});

		const compatibility = validateSchemaCompatibility(prepared, "cloud-code-assist-claude");
		expect(compatibility.compatible).toBe(true);
		expect(compatibility.violations).toEqual([]);
	});

	it("reports Cloud Code Assist residual incompatibilities", () => {
		const compatibility = validateSchemaCompatibility(
			{
				type: "object",
				properties: {
					value: {
						nullable: true,
						anyOf: [{ type: "string" }, { type: "null" }],
					},
				},
				required: ["value"],
			},
			"cloud-code-assist-claude",
		);

		expect(compatibility.compatible).toBe(false);
		expect(hasRule(compatibility, "cca-nullable-key")).toBe(true);
		expect(hasRule(compatibility, "cca-combiner")).toBe(true);
		expect(hasRule(compatibility, "cca-null-type")).toBe(true);
	});
});

import { describe, expect, it } from "bun:test";
import { normalizeSchemaForGoogle } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Problematic JSON Schema features that cause issues with various providers.
 *
 * These are checked AFTER sanitization (normalizeSchemaForGoogle) is applied,
 * so features like `const` that are transformed by sanitization are not flagged.
 *
 * Prohibited (error):
 * - $schema: Explicit schema declarations
 * - $ref / $defs: Schema references (must inline everything)
 * - prefixItems: Unsupported by the Google schema path
 * - $dynamicRef / $dynamicAnchor: Unsupported by the Google schema path
 * - unevaluatedProperties / unevaluatedItems: Unsupported by the Google schema path
 * - const: Should be converted to enum by sanitization
 * - examples: Should be stripped
 *
 * Warnings (non-blocking):
 * - additionalProperties: false - Sometimes causes validation issues
 * - format: Some validators don't recognize format keywords
 */

const PROHIBITED_KEYS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"$dynamicRef",
	"$dynamicAnchor",
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"const", // Should be converted to enum by normalizeSchemaForGoogle
	"examples",
]);

const WARNING_KEYS = new Set(["additionalProperties", "format"]);

interface SchemaViolation {
	path: string;
	key: string;
	value: unknown;
	severity: "error" | "warning";
}

function validateSchema(schema: unknown, path = "root"): SchemaViolation[] {
	const violations: SchemaViolation[] = [];

	if (schema === null || typeof schema !== "object") {
		return violations;
	}

	if (Array.isArray(schema)) {
		for (let i = 0; i < schema.length; i++) {
			violations.push(...validateSchema(schema[i], `${path}[${i}]`));
		}
		return violations;
	}

	const obj = schema as Record<string, unknown>;

	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const value = obj[key];
		const currentPath = `${path}.${key}`;

		if (PROHIBITED_KEYS.has(key)) {
			violations.push({
				path: currentPath,
				key,
				value,
				severity: "error",
			});
		}

		if (WARNING_KEYS.has(key)) {
			// additionalProperties: false is the problematic case
			if (key === "additionalProperties" && value === false) {
				violations.push({
					path: currentPath,
					key,
					value,
					severity: "warning",
				});
			}
			// format is always potentially problematic
			if (key === "format" && typeof value === "string") {
				violations.push({
					path: currentPath,
					key,
					value,
					severity: "warning",
				});
			}
		}

		// Recurse into nested objects
		if (value !== null && typeof value === "object") {
			violations.push(...validateSchema(value, currentPath));
		}
	}

	return violations;
}

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("normalizeSchemaForGoogle", () => {
	it("converts const to enum", () => {
		const schema = { type: "string", const: "active" };
		const sanitized = normalizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["active"] });
	});

	it("merges const into existing enum", () => {
		const schema = { type: "string", const: "active", enum: ["inactive"] };
		const sanitized = normalizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["inactive", "active"] });
	});

	it("does not duplicate const in enum", () => {
		const schema = { type: "string", const: "active", enum: ["active", "inactive"] };
		const sanitized = normalizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({ type: "string", enum: ["active", "inactive"] });
	});

	it("collapses anyOf with const values into enum", () => {
		const schema = {
			anyOf: [
				{ type: "string", const: "file" },
				{ type: "string", const: "dir" },
			],
		};
		const sanitized = normalizeSchemaForGoogle(schema);
		// anyOf with all const values should collapse into a single enum
		expect(sanitized).toEqual({
			type: "string",
			enum: ["file", "dir"],
		});
	});

	it("handles deeply nested schemas", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						status: { type: "string", const: "active" },
					},
				},
			},
		};
		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, unknown>;
		const nested = props.nested as Record<string, unknown>;
		const nestedProps = nested.properties as Record<string, unknown>;
		const status = nestedProps.status as Record<string, unknown>;
		expect(status.const).toBeUndefined();
		expect(status.enum).toEqual(["active"]);
	});

	it("preserves other schema properties", () => {
		const schema = {
			type: "string",
			const: "value",
			description: "A description",
			minLength: 1,
		};
		const sanitized = normalizeSchemaForGoogle(schema);
		expect(sanitized).toEqual({
			type: "string",
			enum: ["value"],
			description: "A description\n\n{minLength: 1}",
		});
	});

	it("handles arrays correctly", () => {
		const schema = {
			type: "array",
			items: { type: "string", const: "only" },
		};
		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const items = sanitized.items as Record<string, unknown>;
		expect(items.const).toBeUndefined();
		expect(items.enum).toEqual(["only"]);
	});

	it("passes through non-boolean primitives and coerces boolean schemas", () => {
		expect(normalizeSchemaForGoogle("string")).toBe("string");
		expect(normalizeSchemaForGoogle(123)).toBe(123);
		// Google's wire cannot encode JSON Schema boolean subschemas; `true`
		// (accept anything) coerces to the equivalent empty schema.
		expect(normalizeSchemaForGoogle(true)).toEqual({});
		expect(normalizeSchemaForGoogle(null)).toBe(null);
	});

	it("preserves property names that match schema keywords (e.g., 'pattern')", () => {
		const schema = {
			type: "object",
			properties: {
				pattern: { type: "string", description: "The search pattern" },
				format: { type: "string", description: "Output format" },
			},
			required: ["pattern"],
		};
		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, unknown>;
		expect(props.pattern).toEqual({ type: "string", description: "The search pattern" });
		expect(props.format).toEqual({ type: "string", description: "Output format" });
		expect(sanitized.required).toEqual(["pattern"]);
	});

	it("still strips schema keywords from non-properties contexts", () => {
		const schema = {
			type: "string",
			pattern: "^[a-z]+$",
			format: "email",
			minLength: 1,
		};
		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.pattern).toBeUndefined();
		expect(sanitized.format).toBeUndefined();
		expect(sanitized.minLength).toBeUndefined();
		expect(sanitized.type).toBe("string");
	});
});

describe("tool schema validation (post-sanitization)", () => {
	it("all builtin tool schemas are valid after sanitization", async () => {
		const session = createTestSession();
		const tools = await createTools(session);

		const allViolations: { tool: string; violations: SchemaViolation[] }[] = [];

		for (const tool of tools) {
			const schema = tool.parameters;
			if (!schema) continue;

			// Apply the same sanitization that happens before sending to providers
			const sanitized = normalizeSchemaForGoogle(schema);
			const violations = validateSchema(sanitized, tool.name);
			const errors = violations.filter(v => v.severity === "error");

			if (errors.length > 0) {
				allViolations.push({ tool: tool.name, violations: errors });
			}
		}

		if (allViolations.length > 0) {
			const message = allViolations
				.map(({ tool, violations }) => {
					const details = violations.map(v => `  - ${v.path}: ${v.key} = ${JSON.stringify(v.value)}`).join("\n");
					return `${tool}:\n${details}`;
				})
				.join("\n\n");

			throw new Error(`Prohibited JSON Schema features found after sanitization:\n\n${message}`);
		}

		expect(allViolations).toEqual([]);
	});

	it("hidden tools also have valid sanitized schemas", async () => {
		const session = createTestSession();

		// Object.entries keeps the factory typed without an index cast.
		for (const [name, factory] of Object.entries(HIDDEN_TOOLS)) {
			const tool = await factory(session);
			if (!tool) continue;

			const schema = tool.parameters;
			if (!schema) continue;

			const sanitized = normalizeSchemaForGoogle(schema);
			const violations = validateSchema(sanitized, name);
			const errors = violations.filter(v => v.severity === "error");

			if (errors.length > 0) {
				const details = errors.map(v => `  - ${v.path}: ${v.key} = ${JSON.stringify(v.value)}`).join("\n");
				throw new Error(`Hidden tool ${name} has prohibited schema features after sanitization:\n${details}`);
			}
		}
	});
});

describe("validateSchema helper", () => {
	it("detects $schema declarations", () => {
		const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$schema")).toBe(true);
	});

	it("detects $ref usage", () => {
		const schema = { type: "object", properties: { foo: { $ref: "#/$defs/Foo" } } };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$ref")).toBe(true);
	});

	it("detects $defs usage", () => {
		const schema = { $defs: { Foo: { type: "string" } }, type: "object" };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$defs")).toBe(true);
	});

	it("detects const usage (should be sanitized away)", () => {
		const schema = { type: "object", properties: { status: { const: "active" } } };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "const")).toBe(true);
	});

	it("detects examples field", () => {
		const schema = { type: "string", examples: ["foo", "bar"] };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "examples")).toBe(true);
	});

	it("detects prefixItems unsupported by the Google schema path", () => {
		const schema = { type: "array", prefixItems: [{ type: "string" }] };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "prefixItems")).toBe(true);
	});

	it("detects unevaluatedProperties unsupported by the Google schema path", () => {
		const schema = { type: "object", unevaluatedProperties: false };
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "unevaluatedProperties")).toBe(true);
	});

	it("warns on additionalProperties: false", () => {
		const schema = { type: "object", additionalProperties: false };
		const violations = validateSchema(schema);
		const warning = violations.find(v => v.key === "additionalProperties");
		expect(warning?.severity).toBe("warning");
	});

	it("warns on format keyword", () => {
		const schema = { type: "string", format: "uri" };
		const violations = validateSchema(schema);
		const warning = violations.find(v => v.key === "format");
		expect(warning?.severity).toBe("warning");
	});

	it("recursively validates nested schemas", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						deep: { $ref: "#/$defs/Deep" },
					},
				},
			},
		};
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "$ref")).toBe(true);
		expect(violations.find(v => v.key === "$ref")?.path).toContain("nested");
	});

	it("validates array prefixItems", () => {
		const schema = {
			type: "array",
			prefixItems: [{ const: "first" }, { type: "string" }],
		};
		const violations = validateSchema(schema);
		expect(violations.some(v => v.key === "const")).toBe(true);
	});
});

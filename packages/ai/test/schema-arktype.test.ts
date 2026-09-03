import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { isArkSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

// ---------------------------------------------------------------------------
// Phase-1 parity gate: ArkType schemas must flow through the same wire-emission
// + validation/coercion pipeline as Zod, with the two contracts the dispatcher
// depends on (root-extra survival on plain objects; strip-extras on closed
// objects) preserved.
// ---------------------------------------------------------------------------

// Plain object — ArkType's default `ignore` undeclared-key behavior.
const plainParams = type({
	name: type("string").describe("the display name"),
	count: type("number").describe("how many items"),
	nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
});
const plainTool: Tool = { name: "ark-plain", description: "", parameters: plainParams };

// Closed object — the `.strict()` analogue (`"+": "reject"`), applied to root
// and the nested object.
const rejectParams = type({
	"+": "reject",
	name: "string",
	count: "number",
	obj: type({ "+": "reject", inner: "string" }),
});
const rejectTool: Tool = { name: "ark-reject", description: "", parameters: rejectParams };

describe("isArkSchema", () => {
	it("accepts a live ArkType instance", () => {
		expect(isArkSchema(type({ a: "string" }))).toBe(true);
		expect(isArkSchema(type("string"))).toBe(true);
	});

	it("rejects JSON Schema objects and non-objects", () => {
		expect(isArkSchema({ type: "object", properties: {} })).toBe(false);
		expect(isArkSchema(null)).toBe(false);
		expect(isArkSchema(undefined)).toBe(false);
		expect(isArkSchema("string")).toBe(false);
		expect(isArkSchema(42)).toBe(false);
	});
});

describe("arkToWireSchema — emission", () => {
	it("emits closed declared objects with per-field descriptions and required", () => {
		const wire = toolWireSchema(plainTool);
		expect(wire.type).toBe("object");
		// Declared objects are closed to match Zod's emission.
		expect(wire.additionalProperties).toBe(false);
		expect([...(wire.required as string[])].sort()).toEqual(["count", "name", "nested"]);

		const props = wire.properties as Record<string, Record<string, unknown>>;
		expect(props.name).toMatchObject({ type: "string", description: "the display name" });
		expect(props.count).toMatchObject({ type: "number", description: "how many items" });

		const nested = props.nested as Record<string, unknown>;
		expect(nested.type).toBe("object");
		expect(nested.description).toBe("a nested object");
		expect(nested.additionalProperties).toBe(false);
		const nestedProps = nested.properties as Record<string, Record<string, unknown>>;
		expect(nestedProps.inner).toMatchObject({ type: "string", description: "inner value" });
	});

	it("never emits the $schema metadata key", () => {
		expect(toolWireSchema(plainTool).$schema).toBeUndefined();
		expect(toolWireSchema(rejectTool).$schema).toBeUndefined();
	});

	it("emits a wire structurally equal to the plain-Zod equivalent", () => {
		const zodTwin: Tool = {
			name: "zod-plain",
			description: "",
			parameters: type({
				name: type("string").describe("the display name"),
				count: type("number").describe("how many items"),
				nested: type({ inner: type("string").describe("inner value") }).describe("a nested object"),
			}),
		};
		// Normalize key + array ordering (semantically irrelevant to JSON Schema).
		const norm = (x: unknown): unknown =>
			Array.isArray(x)
				? [...x].map(norm).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
				: x && typeof x === "object"
					? Object.fromEntries(
							Object.keys(x as Record<string, unknown>)
								.sort()
								.map(k => [k, norm((x as Record<string, unknown>)[k])]),
						)
					: x;
		expect(norm(toolWireSchema(plainTool))).toEqual(norm(toolWireSchema(zodTwin)));
	});
});

describe("validateToolArguments — ArkType contracts", () => {
	it("Contract A: plain type preserves the unknown root key (and, by divergence, nested extras)", () => {
		const result = validateToolArguments(plainTool, {
			type: "toolCall",
			id: "a",
			name: "ark-plain",
			arguments: { name: "n", count: 2, nested: { inner: "v", extraNested: 9 }, extraRoot: 7 },
		}) as Record<string, unknown>;
		expect(result.name).toBe("n");
		// Root extra survives — load-bearing (preserveUnknownRootFields), matches plain z.object.
		expect(result.extraRoot).toBe(7);
		// Accepted divergence from plain z.object: nested extras also survive.
		expect((result.nested as Record<string, unknown>).extraNested).toBe(9);
	});

	it('Contract B: "+": "reject" strips both root and nested extras', () => {
		const result = validateToolArguments(rejectTool, {
			type: "toolCall",
			id: "b",
			name: "ark-reject",
			arguments: { name: "n", count: 2, obj: { inner: "v", extraNested: 9 }, extraRoot: 7 },
		}) as Record<string, unknown>;
		expect(result.name).toBe("n");
		expect(result.extraRoot).toBeUndefined();
		expect((result.obj as Record<string, unknown>).extraNested).toBeUndefined();
	});

	it("coerces a numeric string for a numeric field", () => {
		const result = validateToolArguments(plainTool, {
			type: "toolCall",
			id: "c",
			name: "ark-plain",
			arguments: { name: "n", count: "300", nested: { inner: "v" } },
		}) as Record<string, unknown>;
		expect(result.count).toBe(300);
		expect(typeof result.count).toBe("number");
	});

	it("throws the standard header on a missing required field", () => {
		expect(() =>
			validateToolArguments(plainTool, {
				type: "toolCall",
				id: "d",
				name: "ark-plain",
				arguments: { count: 2, nested: { inner: "v" } },
			}),
		).toThrow(/Validation failed for tool "ark-plain"/);
	});

	it("matches plain Zod exactly — root extras survive even through a coercion pass", () => {
		// The numeric-string forces a coercion pass. The plan predicted the closed
		// wire would strip the root extra here ("divergence 2"), but it does NOT:
		// root extras are preserved identically to plain z.object, proving full
		// wire + coercion parity between the two authoring styles.
		const args = { name: "n", count: "300", nested: { inner: "v" }, extraRoot: 1 };
		const arkResult = validateToolArguments(plainTool, {
			type: "toolCall",
			id: "e",
			name: "ark-plain",
			arguments: structuredClone(args),
		});
		const zodTwin: Tool = {
			name: "zod-plain",
			description: "",
			parameters: type({
				name: type("string"),
				count: type("number"),
				nested: type({ inner: type("string") }),
			}),
		};
		const zodResult = validateToolArguments(zodTwin, {
			type: "toolCall",
			id: "e2",
			name: "zod-plain",
			arguments: structuredClone(args),
		});
		expect(arkResult).toEqual(zodResult);
		expect((arkResult as Record<string, unknown>).count).toBe(300);
		expect((arkResult as Record<string, unknown>).extraRoot).toBe(1);
	});
});

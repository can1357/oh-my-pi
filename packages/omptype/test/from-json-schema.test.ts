import { describe, expect, it } from "bun:test";
import { fromJsonSchema, OmpErrors, type } from "../src";

describe("fromJsonSchema", () => {
	it("round-trips schemas emitted by toJsonSchema", () => {
		const original = type({
			name: "1 <= string <= 32",
			"retries?": "number.integer >= 0",
			mode: "'read' | 'write'",
			tags: "string[]",
		});
		const imported = fromJsonSchema(original.toJsonSchema());
		const valid = { name: "job", mode: "read", tags: ["a"] };
		expect(imported(valid)).toEqual(valid);
		expect(imported({ name: "job", mode: "delete", tags: [] })).toBeInstanceOf(OmpErrors);
		expect(imported({ name: "", mode: "read", tags: [] })).toBeInstanceOf(OmpErrors);
		expect(imported({ mode: "read", tags: [] })).toBeInstanceOf(OmpErrors);
		expect(imported({ name: "job", mode: "read", tags: [1] })).toBeInstanceOf(OmpErrors);
	});

	it("treats defaulted properties as fillable, matching emitted required semantics", () => {
		const imported = fromJsonSchema({
			type: "object",
			properties: { level: { type: "string", default: "info" }, source: { type: "string" } },
			required: ["source"],
		});
		expect(imported({ source: "api" })).toEqual({ source: "api", level: "info" });
		expect(imported({})).toBeInstanceOf(OmpErrors);
	});

	it("supports enum, const, unions, intersections, and boolean schemas", () => {
		expect(fromJsonSchema({ enum: ["a", "b"] })("a")).toBe("a");
		expect(fromJsonSchema({ enum: ["a", "b"] })("c")).toBeInstanceOf(OmpErrors);
		expect(fromJsonSchema({ const: 5 })(5)).toBe(5);
		expect(fromJsonSchema({ anyOf: [{ type: "string" }, { type: "null" }] })(null)).toBe(null);
		const bounded = fromJsonSchema({
			allOf: [
				{ type: "number", minimum: 0 },
				{ type: "number", maximum: 3 },
			],
		});
		expect(bounded(2)).toBe(2);
		expect(bounded(4)).toBeInstanceOf(OmpErrors);
		expect(fromJsonSchema(true)("anything")).toBe("anything");
		expect(fromJsonSchema(false)("anything")).toBeInstanceOf(OmpErrors);
	});

	it("validates string formats and patterns", () => {
		const email = fromJsonSchema({ type: "string", format: "email" });
		expect(email("a@omp.sh")).toBe("a@omp.sh");
		expect(email("nope")).toBeInstanceOf(OmpErrors);
		const patterned = fromJsonSchema({ type: "string", pattern: "^G-[A-Z0-9]+$", minLength: 3 });
		expect(patterned("G-X1")).toBe("G-X1");
		expect(patterned("bad")).toBeInstanceOf(OmpErrors);
		expect(patterned("G-")).toBeInstanceOf(OmpErrors);
	});

	it("resolves recursive $defs references", () => {
		const imported = fromJsonSchema({
			$defs: {
				node: {
					type: "object",
					properties: { value: { type: "number" }, next: { $ref: "#/$defs/node" } },
					required: ["value"],
				},
			},
			$ref: "#/$defs/node",
		});
		expect(imported({ value: 1, next: { value: 2 } })).toEqual({ value: 1, next: { value: 2 } });
		const invalid = imported({ value: 1, next: { value: "two" } });
		expect(invalid).toBeInstanceOf(OmpErrors);
		if (invalid instanceof OmpErrors) expect(invalid[0].path).toEqual(["next", "value"]);
	});

	it("imports tuples with variadic tails and rejects undeclared keys on closed objects", () => {
		const pair = fromJsonSchema({
			type: "array",
			prefixItems: [{ type: "string" }, { type: "number" }],
			minItems: 1,
			items: { type: "boolean" },
		});
		expect(pair(["x", 1, true])).toEqual(["x", 1, true]);
		expect(pair(["x"])).toEqual(["x"]);
		expect(pair([1])).toBeInstanceOf(OmpErrors);

		const closed = fromJsonSchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
			additionalProperties: false,
		});
		expect(closed({ a: "x" })).toEqual({ a: "x" });
		expect(closed({ a: "x", b: 1 })).toBeInstanceOf(OmpErrors);
	});

	it("emits recursive scopes as $defs/$ref and round-trips them", () => {
		const Node = type.scope({ Node: { value: "number", "next?": "Node" } }).export().Node;
		const emitted = Node.toJsonSchema({ target: "draft-2020-12" });
		expect(JSON.stringify(emitted)).toContain("#/$defs/");
		expect(emitted.$defs).toBeDefined();

		const imported = fromJsonSchema(emitted);
		expect(imported({ value: 1, next: { value: 2, next: { value: 3 } } })).toEqual({
			value: 1,
			next: { value: 2, next: { value: 3 } },
		});
		expect(imported({ value: 1, next: { value: "two" } })).toBeInstanceOf(OmpErrors);

		const draft7 = Node.toJsonSchema({ target: "draft-07" });
		expect(JSON.stringify(draft7)).toContain("#/definitions/");
		expect(JSON.stringify(draft7)).not.toContain("$defs");
	});

	it("emits io-aware schemas: input keeps morph sources and optional defaults, output the reverse", () => {
		const S = type({ port: "number = 8080", raw: "string.integer.parse" });

		const input = S.toJsonSchema({ io: "input" });
		const inputProps = input.properties as Record<string, Record<string, unknown>>;
		expect(inputProps.raw.type).toBe("string");
		expect(input.required).toEqual(["raw"]);
		expect(inputProps.port.default).toBe(8080);

		const output = S.toJsonSchema({ io: "output" });
		const outputProps = output.properties as Record<string, Record<string, unknown>>;
		expect(outputProps.raw.type).toBe("integer");
		expect(output.required).toEqual(["port", "raw"]);

		// The emitted input schema accepts what the source schema accepts.
		const imported = fromJsonSchema(input);
		expect(imported({ raw: "42" })).toEqual({ raw: "42", port: 8080 });
		expect(imported({ raw: 42 })).toBeInstanceOf(OmpErrors);
	});

	it("io output uses the .to() target for piped schemas", () => {
		const Uid = type("number.integer > 0 | string.integer.parse | bigint")
			.pipe(value => (typeof value === "bigint" ? Number(value) : value))
			.to("number.integer > 0");
		expect(Uid.assert("42")).toBe(42);
		expect(Uid.assert(7n)).toBe(7);
		expect(Uid(0)).toBeInstanceOf(OmpErrors);

		const output = Uid.toJsonSchema({ io: "output" });
		expect(output).toEqual({ type: "integer", exclusiveMinimum: 0 });

		const input = Uid.toJsonSchema({ io: "input" });
		expect(JSON.stringify(input)).toContain("anyOf");

		// A bare pipe AFTER .to() makes the output statically unknown again —
		// output emission degrades to the unconstrained schema, never the stale
		// .to target and never the input union.
		const stringified = Uid.pipe(value => String(value));
		expect(stringified.toJsonSchema({ io: "output" })).toEqual({});

		// Structural-only schemas keep emitting their own IR for output io.
		expect(type("string").toJsonSchema({ io: "output" })).toEqual({ type: "string" });
		// Embedded in an object property, the .to target still drives output io.
		const wrapped = type({ id: Uid });
		const wrappedOut = wrapped.toJsonSchema({ io: "output" });
		const props = wrappedOut.properties as Record<string, unknown>;
		expect(props.id).toEqual({ type: "integer", exclusiveMinimum: 0 });
	});
});

import { describe, expect, it } from "bun:test";
import { OmpErrors, Type, type } from "../src";
import { scope as arkScope } from "../src/ark";

/** Call count that guarantees the JIT has kicked in (threshold is 3). */
const JIT = 5;

/** Run `fn` against a freshly-built schema on calls 1 (interp) and JIT'd, asserting identical outcomes. */
function everyStage(build: () => (data: unknown) => unknown, data: unknown): unknown[] {
	const schema = build();
	const results: unknown[] = [];
	for (let i = 0; i < JIT; i++) results.push(schema(structuredClone(data)));
	return results;
}

function normalized(result: unknown): unknown {
	return result instanceof OmpErrors ? { error: result.summary } : result;
}

describe("validation", () => {
	const tool = type({
		path: "string",
		"offset?": "number.integer >= 1",
		mode: "'read' | 'write' | 'append'",
		"tags?": "string[]",
	});

	it("returns the input unchanged for morph-free valid data", () => {
		const input = { path: "a.ts", mode: "read" } as const;
		expect(tool(input)).toBe(input);
	});

	it("rejects wrong primitive, bad literal, broken bound, and missing key with path-aware errors", () => {
		const missing = tool({ mode: "read" });
		expect(missing).toBeInstanceOf(type.errors);
		if (missing instanceof OmpErrors) {
			expect(missing[0].path).toEqual(["path"]);
			expect(missing.summary).toContain("path");
		}
		expect(tool({ path: "x", mode: "delete" })).toBeInstanceOf(OmpErrors);
		expect(tool({ path: "x", mode: "read", offset: 0 })).toBeInstanceOf(OmpErrors);
		expect(tool({ path: "x", mode: "read", offset: 1.5 })).toBeInstanceOf(OmpErrors);
		expect(tool({ path: "x", mode: "read", tags: ["a", 1] })).toBeInstanceOf(OmpErrors);
	});

	it("bounds: numbers (exclusive/inclusive) and string length", () => {
		const s = type({ t: "0 < number <= 3600", name: "1 <= string <= 8" });
		expect(s({ t: 1, name: "ok" })).toEqual({ t: 1, name: "ok" });
		expect(s({ t: 0, name: "ok" })).toBeInstanceOf(OmpErrors);
		expect(s({ t: 3601, name: "ok" })).toBeInstanceOf(OmpErrors);
		expect(s({ t: 1, name: "" })).toBeInstanceOf(OmpErrors);
		expect(s({ t: 1, name: "toolongname" })).toBeInstanceOf(OmpErrors);
	});

	it("array suffix binds outside a trailing bound: string>0[]", () => {
		const s = type({ files: "string>0|string>0[]" });
		expect(s({ files: "a.ts" })).toEqual({ files: "a.ts" });
		expect(s({ files: ["a.ts", "b.ts"] })).toEqual({ files: ["a.ts", "b.ts"] });
		expect(s({ files: [""] })).toBeInstanceOf(OmpErrors);
		expect(s({ files: "" })).toBeInstanceOf(OmpErrors);
	});

	it("string.url validates parseability", () => {
		const s = type("string.url");
		expect(s("https://omp.sh/x")).toBe("https://omp.sh/x");
		expect(s("not a url")).toBeInstanceOf(OmpErrors);
	});

	it("index signatures validate every value", () => {
		const s = type({ env: { "[string]": "string" } });
		expect(s({ env: { A: "1" } })).toEqual({ env: { A: "1" } });
		expect(s({ env: { A: 1 } })).toBeInstanceOf(OmpErrors);
	});

	it("null/undefined union members", () => {
		const s = type("string | null");
		expect(s(null)).toBe(null);
		expect(s("x")).toBe("x");
		expect(s(5)).toBeInstanceOf(OmpErrors);
	});
});

describe("interp/JIT parity", () => {
	const cases: { def: Parameters<typeof type>[0]; inputs: unknown[] }[] = [
		{
			def: { a: "string", "b?": "number.integer >= 0", c: "'x' | 'y'" },
			inputs: [{ a: "s", c: "x" }, { a: "s", b: -1, c: "x" }, { a: 1, c: "x" }, "nope", { a: "s", c: "z" }],
		},
		{
			def: { "+": "reject", k: "string", n: "number = 10" },
			inputs: [{ k: "a" }, { k: "a", n: 3 }, { k: "a", extra: true }, { k: "a", n: "3" }],
		},
		{
			def: { "+": "delete", k: "string", "lvl?": "'low' | 'high'" },
			inputs: [{ k: "a", junk: 1 }, { k: "a", lvl: "low", z: null }, { k: 2 }],
		},
		{
			def: { items: [{ id: "string", "w?": "number" }, "[]"], env: { "[string]": "string" } },
			inputs: [
				{ items: [{ id: "a" }, { id: "b", w: 1 }], env: { X: "1" } },
				{ items: [{ id: 1 }], env: {} },
				{ items: [], env: { X: 2 } },
			],
		},
		{
			def: ["string", ["number", "?"]],
			inputs: [["x"], ["x", 1], ["x", 1, 2], [1]],
		},
		{
			def: [
				["string", "=", "x"],
				["number", "=", 1],
			],
			inputs: [[], ["y"], ["y", 2], [1]],
		},
	];

	it("every stage of the lazy swap classifies and morphs identically", () => {
		for (const c of cases) {
			for (const input of c.inputs) {
				const results = everyStage(() => type(c.def), input).map(normalized);
				for (const r of results.slice(1)) {
					expect(r).toEqual(results[0] as never);
				}
			}
		}
	});
});

describe("morphs", () => {
	it("fills defaults on a fresh object without touching the input", () => {
		const s = type({ action: "'get' | 'put'", count: "number.integer = 10" });
		const input = { action: "get" };
		const out = s(input);
		expect(out).toEqual({ action: "get", count: 10 });
		expect(out).not.toBe(input);
		expect(input).toEqual({ action: "get" });
	});

	it("deletes extras on a fresh object", () => {
		const s = type({ "+": "delete", name: "string" });
		const input = { name: "x", junk: 1 };
		expect(s(input)).toEqual({ name: "x" });
		expect(input).toEqual({ name: "x", junk: 1 });
	});

	it(".default() factory values are invoked per fill", () => {
		const s = type({ list: type("string[]").default(() => []) });
		const a = s({});
		const b = s({});
		expect(a).toEqual({ list: [] });
		if (typeof a === "object" && a !== null && "list" in a && typeof b === "object" && b !== null && "list" in b) {
			expect(a.list).not.toBe(b.list);
		}
	});
});

describe("methods", () => {
	it("supports ArkType-compatible Type checks", () => {
		const schema = type({ kind: "'first'" }).or({ kind: "'second'", enabled: "boolean = false" });
		expect(schema).toBeInstanceOf(Type);
		expect((schema as unknown as { bind?: unknown }).bind).toBeUndefined();
		expect(schema({ kind: "second" })).toEqual({ kind: "second", enabled: false });
	});

	it(".or() unions with string defs and Types", () => {
		const s = type("string").or("null").or(type("number"));
		expect(s("x")).toBe("x");
		expect(s(null)).toBe(null);
		expect(s(5)).toBe(5);
		expect(s(true)).toBeInstanceOf(OmpErrors);
	});

	it(".array() with length bounds", () => {
		const s = type({ id: "string" }).array().atLeastLength(1).atMostLength(2);
		expect(s([{ id: "a" }])).toEqual([{ id: "a" }]);
		expect(s([])).toBeInstanceOf(OmpErrors);
		expect(s([{ id: "a" }, { id: "b" }, { id: "c" }])).toBeInstanceOf(OmpErrors);
	});

	it(".pipe() transforms output; chained after validation", () => {
		const s = type("string").pipe(v => Number.parseInt(v, 10));
		expect(s("42")).toBe(42);
		expect(s(42)).toBeInstanceOf(OmpErrors);
	});

	it(".narrow() with ctx.mustBe records the expectation", () => {
		const s = type({ action: "string", "body?": "string" }).narrow(
			(p, ctx) => p.action === "delete" || p.body !== undefined || ctx.mustBe("a body unless deleting"),
		);
		expect(s({ action: "delete" })).toEqual({ action: "delete" });
		const bad = s({ action: "create" });
		expect(bad).toBeInstanceOf(OmpErrors);
		if (bad instanceof OmpErrors) expect(bad.summary).toContain("a body unless deleting");
	});

	it(".narrow() runs after morphs (sees defaults)", () => {
		const s = type({ n: "number = 5" }).narrow(v => v.n === 5);
		expect(s({})).toEqual({ n: 5 });
		expect(s({ n: 6 })).toBeInstanceOf(OmpErrors);
	});

	it(".allows() checks without running pipes", () => {
		let piped = 0;
		const s = type("string").pipe(v => {
			piped++;
			return v;
		});
		expect(s.allows("x")).toBe(true);
		expect(s.allows(5)).toBe(false);
		expect(piped).toBe(0);
	});

	it(".allows() preserves nested and optional-property validation", () => {
		const s = type({
			context: "string",
			tasks: [{ "name?": "1 <= string <= 32", task: "string" }, "[]"],
		});
		expect(s.allows({ context: "goal", tasks: [{ task: "run" }] })).toBe(true);
		expect(s.allows({ context: "goal", tasks: [{ name: "", task: "run" }] })).toBe(false);
		expect(s.allows({ context: "goal", tasks: [{ name: undefined, task: "run" }] })).toBe(false);
		expect(s.allows({ context: "goal", tasks: [{ task: 1 }] })).toBe(false);
	});

	it(".assert() returns output or throws with the summary", () => {
		const s = type({ a: "string" });
		expect(s.assert({ a: "x" })).toEqual({ a: "x" });
		expect(() => s.assert({ a: 5 })).toThrow(/must be/);
	});

	it(".and() merges object schemas", () => {
		const s = type({ a: "string" }).and({ "b?": "number" });
		expect(s({ a: "x" })).toEqual({ a: "x" });
		expect(s({ a: "x", b: 2 })).toEqual({ a: "x", b: 2 });
		expect(s({ b: 2 })).toBeInstanceOf(OmpErrors);
	});

	it("type.enumerated builds literal unions from runtime arrays", () => {
		const langs = ["py", "js"];
		const s = type.enumerated(...langs);
		expect(s("py")).toBe("py");
		expect(s("rs")).toBeInstanceOf(OmpErrors);
	});

	it(".describe() lands in JSON Schema and keeps validation identical", () => {
		const s = type("string").describe("a name");
		expect(s.toJsonSchema()).toEqual({ type: "string", description: "a name" });
		expect(s("x")).toBe("x");
	});
});

describe("embedded schemas", () => {
	it("stepped sub-schemas morph inside parents and prefix error paths", () => {
		const num = type("string").pipe(v => Number.parseInt(v, 10));
		const parent = type({ meta: { port: num } });
		expect(parent({ meta: { port: "8080" } })).toEqual({ meta: { port: 8080 } });
		const bad = parent({ meta: { port: 8080 } });
		expect(bad).toBeInstanceOf(OmpErrors);
		if (bad instanceof OmpErrors) {
			expect(bad[0].path).toEqual(["meta", "port"]);
		}
	});

	it("parity holds for stepped sub-schemas across the JIT swap", () => {
		const num = type("string").pipe(v => Number.parseInt(v, 10));
		const results = everyStage(() => type({ port: num }), { port: "1" }).map(normalized);
		for (const r of results) expect(r).toEqual({ port: 1 });
	});

	it("union failures descend into the kind-matched member across the JIT swap", () => {
		// string | array-of-objects: an array input must produce the array
		// member's element-level error, not the coarse union expectation
		const item = type({ kind: "'a' | 'b'", id: "string" });
		const results = everyStage(() => type("string").or(item.array()), [{ kind: "a" }]).map(normalized);
		for (const r of results) {
			expect(r).toEqual(results[0] as never);
			const err = (r as { error: string }).error;
			expect(err).toContain("id");
			expect(err).toContain("missing");
		}
	});

	it("union failures discriminate object members by literal props", () => {
		const move = type({ op: "'move'", to: "string" });
		const wait = type({ op: "'wait'", ms: "number" });
		const s = type(move.or(wait));
		for (let i = 0; i < JIT; i++) {
			const out = s({ op: "wait", ms: "soon" });
			expect(out).toBeInstanceOf(OmpErrors);
			if (out instanceof OmpErrors) {
				expect(out[0].path).toEqual(["ms"]);
				expect(out.summary).toContain("a number");
			}
		}
	});
});

describe("error contract", () => {
	it("entries support stable indexing, iteration, map(), and filter()", () => {
		const s = type({ server: { port: "number.integer" } });
		const out = s({ server: { port: "80" } });
		expect(out).toBeInstanceOf(OmpErrors);
		if (out instanceof OmpErrors) {
			const mapped = out.map(e => ({
				instancePath: e.path.length === 0 ? "root" : e.path.join("."),
				message: e.problem,
			}));
			const [entry] = out;
			expect(out.length).toBe(1);
			expect(entry).toBe(out[0]);
			expect(out[0]).toBe(out[0]);
			expect(out.filter(() => true)).toEqual([out[0]]);
			expect(mapped).toEqual([
				{ instancePath: "server.port", message: expect.stringContaining("must be an integer") },
			]);
		}
	});

	it("summary is line-per-error human text", () => {
		const s = type({ a: "string" });
		const out = s({});
		if (out instanceof OmpErrors) {
			expect(out.summary).toContain("a ");
			expect(out.summary).toContain("missing");
		}
	});
});

describe("advanced ArkType compatibility", () => {
	it("re-exports recursive scopes through the Ark compatibility facade", () => {
		const schemas = arkScope({ Node: { value: "number", "next?": "Node" } }, { jitless: true }).export();
		expect(schemas.Node({ value: 1, next: { value: 2 } })).toEqual({
			value: 1,
			next: { value: 2 },
		});
		const invalid = schemas.Node({ value: 1, next: { value: "two" } });
		expect(invalid).toBeInstanceOf(OmpErrors);
		if (invalid instanceof OmpErrors) expect(invalid[0].path).toEqual(["next", "value"]);
	});

	it("resolves recursive scopes, modules, utility generics, and runtime generics", () => {
		const schemas = type
			.scope({
				User: { name: "string", "manager?": "User" },
				Users: "User[]",
				Directory: "Record<string, User>",
				Public: "Pick<User, 'name'>",
				Maybe: "Partial<User>",
			})
			.export();
		expect(schemas.User({ name: "Ada", manager: { name: "Grace" } })).toEqual({
			name: "Ada",
			manager: { name: "Grace" },
		});
		expect(schemas.Users([{ name: "Ada" }])).toEqual([{ name: "Ada" }]);
		expect(schemas.Directory({ lead: { name: "Ada" } })).toEqual({ lead: { name: "Ada" } });
		expect(schemas.Public({ name: "Ada" })).toEqual({ name: "Ada" });
		expect(schemas.Maybe({})).toEqual({});
		const bad = schemas.User({ name: "Ada", manager: { name: 1 } });
		expect(bad).toBeInstanceOf(OmpErrors);
		if (bad instanceof OmpErrors) expect(bad[0].path).toEqual(["manager", "name"]);

		const module = type.module({ Name: "string", User: { name: "Name" } });
		expect(module.User({ name: "Ada" })).toEqual({ name: "Ada" });
		const box = type.generic("<value>", { value: "value" });
		expect(box("number")({ value: 2 })).toEqual({ value: 2 });
		expect(box("number")({ value: "2" })).toBeInstanceOf(OmpErrors);
	});

	it("supports fixed, optional, defaulted, and variadic tuple elements", () => {
		const fixed = type(["string", "number"]);
		expect(fixed(["x", 1])).toEqual(["x", 1]);
		expect(fixed(["x"])).toBeInstanceOf(OmpErrors);

		const optional = type(["string", ["number", "?"]]);
		expect(optional(["x"])).toEqual(["x"]);
		expect(optional(["x", 1])).toEqual(["x", 1]);
		expect(optional(["x", 1, 2])).toBeInstanceOf(OmpErrors);

		const variadic = type(["string", "...", ["boolean", "[]"], "number"]);
		expect(variadic(["x", 1])).toEqual(["x", 1]);
		expect(variadic(["x", true, false, 1])).toEqual(["x", true, false, 1]);
		expect(variadic(["x", true])).toBeInstanceOf(OmpErrors);

		const defaulted = type([
			["string", "=", "x"],
			["number", "=", 1],
		]);
		expect(defaulted([])).toEqual(["x", 1]);
		expect(defaulted(["y"])).toEqual(["y", 1]);
	});

	it("validates Date literals and bounds before and after JIT compilation", () => {
		const exact = type("d'2024-01-02T00:00:00.000Z'");
		const bounded = type("Date >= d'2024-01-01T00:00:00.000Z'");
		for (let index = 0; index < JIT; index++) {
			expect(exact(new Date("2024-01-02T00:00:00.000Z"))).toEqual(new Date("2024-01-02T00:00:00.000Z"));
			expect(exact(new Date("2024-01-03T00:00:00.000Z"))).toBeInstanceOf(OmpErrors);
			expect(bounded(new Date("2024-01-01T00:00:00.000Z"))).toEqual(new Date("2024-01-01T00:00:00.000Z"));
			expect(bounded(new Date("2023-12-31T23:59:59.999Z"))).toBeInstanceOf(OmpErrors);
		}
	});

	it("supports disjointness-aware intersections and semantic comparison", () => {
		const bounded = type("number > 0").and("number < 3");
		expect(bounded(2)).toBe(2);
		expect(bounded(0)).toBeInstanceOf(OmpErrors);
		expect(type("'a' | 'b'").and("'b' | 'c'")("b")).toBe("b");
		const stringSchema = type.raw("string");
		const and = Reflect.get(stringSchema, "and");
		if (typeof and !== "function") throw new Error("schema is missing and()");
		expect(() => Reflect.apply(and, stringSchema, ["number"])).toThrow("unsatisfiable");
		expect(type("0 < number <= 3600").equals(type("number > 0").and("number <= 3600"))).toBe(true);
		expect(type("number.integer > 0").extends("number")).toBe(true);
		expect(type("'a' | 'b'").overlaps("'b' | 'c'")).toBe(true);
		expect(type("string").overlaps("number")).toBe(false);
	});

	it("maps and selects structural nodes and distributes unions", () => {
		const object = type({ name: "string", "age?": "number" });
		expect(object.props.map(prop => [prop.kind, prop.key])).toEqual([
			["required", "name"],
			["optional", "age"],
		]);
		const renamed = object.map(prop => (prop.key === "name" ? { ...prop, key: "label" } : []));
		expect(renamed({ label: "Ada" })).toEqual({ label: "Ada" });
		expect(
			type("'red' | 'blue'")
				.select("unit")
				.map(node => node.unit),
		).toEqual(["red", "blue"]);
		const distributed = type("'a' | 'b'").distribute(branch => branch.array());
		expect(distributed(["a"])).toEqual(["a"]);
		expect(distributed(["c"])).toBeInstanceOf(OmpErrors);
	});

	it("exposes nested keyword modules and configurable error codes", () => {
		expect(type.string.ip.v4("127.0.0.1")).toBe("127.0.0.1");
		expect(type.string.uuid.v4("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
		expect(type.string.trim.preformatted("trimmed")).toBe("trimmed");
		expect(type.string.date.iso.parse("2024-01-02")).toBeInstanceOf(Date);
		expect(type.parse.url("https://omp.sh")).toBeInstanceOf(URL);

		// ArkType applies `.configure()` to the node it is called on (and its shallow
		// descendants), so the constraint that should carry the config owns it here.
		const configured = type({
			user: {
				age: type("number >= 18").configure({
					expected: context => `expected:${context.code}`,
					message: context => `${context.path.join("/")}: ${context.problem}`,
				}),
			},
		});
		for (let index = 0; index < JIT; index++) {
			const out = configured({ user: { age: 10 } });
			expect(out).toBeInstanceOf(OmpErrors);
			if (out instanceof OmpErrors) {
				expect(out[0].code).toBe("min");
				expect(out.summary).toContain("user/age: must be expected:min");
				expect(Object.keys(out.byPath)).toEqual(["user.age"]);
			}
		}
	});
});

describe("Standard Schema V1", () => {
	it("validates synchronously with morphs and path-aware issues", () => {
		const s = type({ port: "string.integer.parse", name: "string" });
		const std = s["~standard"];
		expect(std.version).toBe(1);
		expect(std.vendor).toBe("omptype");
		expect(std.validate({ port: "8080", name: "api" })).toEqual({ value: { port: 8080, name: "api" } });
		const failed = std.validate({ port: "8080", name: 42 });
		if (failed instanceof Promise || failed.issues === undefined) throw new Error("expected sync failure");
		expect(failed.issues[0].path).toEqual(["name"]);
		expect(failed.issues[0].message).toContain("a string");
	});

	it("materializes root defaults for undefined input at the standard boundary", () => {
		const staticDefault = type.string.default("dev");
		expect(staticDefault["~standard"].validate(undefined)).toEqual({ value: "dev" });
		expect(staticDefault(undefined)).toBe("dev");
		expect(staticDefault("prod")).toBe("prod");
		expect(staticDefault(5)).toBeInstanceOf(OmpErrors);

		// Factory defaults run per call — distinct instances each time.
		const factoryDefault = type("string[]").default(() => []);
		const first = factoryDefault(undefined);
		const second = factoryDefault(undefined);
		expect(first).toEqual([]);
		expect(first).not.toBe(second);
	});
});

describe("type.withJsonSchema", () => {
	it("emits the override verbatim even when embedded, and still validates", () => {
		const raw = { type: "string", enum: ["a", "b"], "x-vendor": true };
		const inner = type.withJsonSchema(
			type.unknown.narrow(v => v === "a" || v === "b"),
			raw,
		);

		// Top-level emission is the override.
		expect(inner.toJsonSchema()).toEqual(raw);
		// Nested inside an object, the override survives (a `.toJsonSchema`
		// method override would be dropped by the parent emitter here).
		const object = type({ mode: inner });
		expect((object.toJsonSchema().properties as Record<string, unknown>).mode).toEqual(raw);

		// Runtime validation is delegated to the wrapped schema.
		expect(inner("a")).toBe("a");
		expect(inner("c")).toBeInstanceOf(OmpErrors);
		expect(object({ mode: "b" })).toEqual({ mode: "b" });
		expect(object({ mode: "c" })).toBeInstanceOf(OmpErrors);
	});

	it("rejects defaults and output-changing morphs", () => {
		expect(() => type.withJsonSchema(type.string.default("fallback"), { type: "string" })).toThrow(
			"cannot wrap schemas with defaults or output-changing morphs",
		);
		expect(() =>
			type.withJsonSchema(type("string.integer.parse"), {
				type: "string",
				pattern: "^[0-9]+$",
			}),
		).toThrow("cannot wrap schemas with defaults or output-changing morphs");
	});
});

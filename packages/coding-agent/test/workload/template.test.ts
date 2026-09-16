import { describe, expect, it } from "bun:test";
import { interpolate, resolveReference, type TemplateScope, WorkloadTemplateError } from "../../src/workload/template";

const files = [
	{ path: "a.ts", size: 10 },
	{ path: "b.ts", size: 20 },
];

const scope: TemplateScope = {
	args: { target: "src/api", depth: "2" },
	steps: {
		discover: {
			output: {
				files,
				count: 2,
				ok: true,
				note: null,
			},
		},
		build: {
			stdout: "compiled ok",
			exitCode: 0,
		},
	},
};

describe("interpolate", () => {
	it("expands nested paths with both array-index syntaxes", () => {
		expect(interpolate("${steps.discover.output.files.0.path}", scope)).toBe("a.ts");
		expect(interpolate("${steps.discover.output.files[1].path}", scope)).toBe("b.ts");
		expect(interpolate("${steps.discover.output.files[0].size}", scope)).toBe("10");
	});

	it("renders strings verbatim and numbers, booleans, and null via String", () => {
		expect(interpolate("scan ${args.target} depth=${args.depth}", scope)).toBe("scan src/api depth=2");
		expect(interpolate("count=${steps.discover.output.count} ok=${steps.discover.output.ok}", scope)).toBe(
			"count=2 ok=true",
		);
		expect(interpolate("note=${steps.discover.output.note}", scope)).toBe("note=null");
		expect(interpolate("code=${steps.build.exit_code} ${steps.build.stdout}", scope)).toBe("code=0 compiled ok");
	});

	it("renders objects and arrays as compact JSON", () => {
		expect(interpolate("${steps.discover.output.files}", scope)).toBe(
			'[{"path":"a.ts","size":10},{"path":"b.ts","size":20}]',
		);
		expect(interpolate("${steps.discover.output}", scope)).toBe(
			JSON.stringify({ files, count: 2, ok: true, note: null }),
		);
	});

	it("treats $${ as a literal ${ and does not start a reference", () => {
		expect(interpolate("cost is $${steps.discover.output.count}", scope)).toBe(
			"cost is ${steps.discover.output.count}",
		);
		expect(interpolate("mix $${args.target} and ${args.target}", scope)).toBe("mix ${args.target} and src/api");
	});

	it("throws on an unterminated ${", () => {
		expect(() => interpolate("hello ${args.target", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("hello ${args.target", scope)).toThrow(/Unterminated template reference/);
	});

	it("tolerates whitespace inside a reference", () => {
		expect(interpolate("${ args.target }", scope)).toBe("src/api");
		expect(interpolate("${steps.discover.output.files[ 0 ].path}", scope)).toBe("a.ts");
	});

	it("throws on an unknown root and names the valid roots", () => {
		expect(() => interpolate("${env.HOME}", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("${env.HOME}", scope)).toThrow(
			/Unknown template root "env".*Valid roots: args, steps, item, item_index/,
		);
	});

	it("throws on an unknown or unfinished step id", () => {
		expect(() => interpolate("${steps.missing.output}", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("${steps.missing.output}", scope)).toThrow(
			/Unknown or unfinished step "missing".*\$\{steps\.missing\.output\}/,
		);
		expect(() => interpolate("${steps.discover.output}", { args: {}, steps: {} })).toThrow(
			/Unknown or unfinished step "discover"/,
		);
	});

	it("throws on a missing deep path", () => {
		expect(() => interpolate("${steps.discover.output.files.9.path}", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("${steps.discover.output.nope}", scope)).toThrow(
			/Missing path "nope".*\$\{steps\.discover\.output\.nope\}/,
		);
	});

	it("treats null as a resolved value and absent keys as missing", () => {
		expect(interpolate("${steps.discover.output.note}", scope)).toBe("null");
		expect(resolveReference("steps.discover.output.note", scope)).toBeNull();
		expect(() => interpolate("${steps.discover.output.absent}", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("${steps.build.output}", scope)).toThrow(/Missing path "output"/);
	});

	it("expands item and item_index only inside a for_each scope", () => {
		expect(() => interpolate("${item}", scope)).toThrow(WorkloadTemplateError);
		expect(() => interpolate("${item}", scope)).toThrow(/only valid inside a for_each step/);
		expect(() => interpolate("${item_index}", scope)).toThrow(/only valid inside a for_each step/);

		const each: TemplateScope = { ...scope, item: files[0], itemIndex: 0 };
		expect(interpolate("file ${item.path} #${item_index}", each)).toBe("file a.ts #0");
		expect(resolveReference("${item}", each)).toEqual({ path: "a.ts", size: 10 });
		expect(resolveReference("item_index", each)).toBe(0);
	});
});

describe("resolveReference", () => {
	it("returns a raw array rather than a stringified value", () => {
		const dotted = resolveReference("steps.discover.output.files", scope);
		const wrapped = resolveReference("  ${steps.discover.output.files}  ", scope);
		const bracket = resolveReference("${steps.discover.output.files[0]}", scope);
		expect(dotted).toBe(files);
		expect(wrapped).toBe(files);
		expect(bracket).toEqual({ path: "a.ts", size: 10 });
		expect(resolveReference("steps.build.exit_code", scope)).toBe(0);
	});
});

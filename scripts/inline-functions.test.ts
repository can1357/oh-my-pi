import { describe, expect, test } from "bun:test";
import { IndentationText, Project } from "ts-morph";
import { inlineFile, type Options } from "./inline-functions";

function opts(overrides: Partial<Options> = {}): Options {
	return {
		maxStatements: overrides.maxStatements ?? 3,
		nameFilter: overrides.nameFilter,
		verbose: false,
		strictEffects: overrides.strictEffects ?? false,
	};
}

/** Run the inliner on an in-memory source and return { text, inlined names }. */
function run(src: string, overrides: Partial<Options> = {}): { text: string; inlined: string[] } {
	const project = new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: { indentationText: IndentationText.Tab },
	});
	const sf = project.createSourceFile("input.ts", src);
	const inlined = inlineFile(sf, opts(overrides));
	return { text: sf.getFullText(), inlined };
}

/** Collapse whitespace so assertions ignore the inliner's pre-format indentation. */
function norm(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

describe("inline-functions: guard inversion", () => {
	test("single `!==` guard becomes a positive `===` wrapper with params substituted", () => {
		const { text, inlined } = run(`
			function handlePart(currentItem: Item | null, rawEvent: Record<string, unknown>): void {
				if (currentItem?.type !== "reasoning") return;
				appendPart(currentItem, (rawEvent as { part: P }).part);
			}
			function dispatch(runtime: Runtime, rawEvent: Record<string, unknown>): void {
				handlePart(runtime.currentItem, rawEvent);
			}
		`);
		expect(inlined).toEqual(["handlePart"]);
		expect(text).not.toContain("function handlePart");
		const n = norm(text);
		expect(n).toContain('if (runtime.currentItem?.type === "reasoning") {');
		expect(n).toContain("appendPart(runtime.currentItem, (rawEvent as { part: P }).part);");
	});

	test("`||` guard with two comparisons becomes `&&` via De Morgan", () => {
		const { text } = run(`
			function handleDelta(currentItem: Item | null, currentBlock: Block | null, rawEvent: Record<string, unknown>): void {
				if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
				const delta = (rawEvent as { delta?: string }).delta || "";
				appendDelta(currentItem, currentBlock, delta);
			}
			function dispatch(runtime: Runtime, rawEvent: Record<string, unknown>): void {
				handleDelta(runtime.currentItem, runtime.currentBlock, rawEvent);
			}
		`);
		const n = norm(text);
		expect(n).toContain(
			'if (runtime.currentItem?.type === "reasoning" && runtime.currentBlock?.type === "thinking") {',
		);
		expect(n).toContain('const delta = (rawEvent as { delta?: string }).delta || "";');
		expect(n).toContain("appendDelta(runtime.currentItem, runtime.currentBlock, delta);");
	});

	test("comparator flips: `=== null` guard becomes `!== null`", () => {
		const { text } = run(`
			function h(x: string | null): void {
				if (x === null) return;
				use(x);
			}
			function call(value: string | null): void {
				h(value);
			}
		`);
		expect(norm(text)).toContain("if (value !== null) {");
	});

	test("multiple guards combine with `&&`, wrapping disjunctions", () => {
		const { text } = run(`
			function h(a: A, b: B): void {
				if (a.x !== 1) return;
				if (b.y === 2 || b.z === 3) return;
				done(a, b);
			}
			function call(p: A, q: B): void {
				h(p, q);
			}
		`);
		// !(a.x !== 1) -> p.x === 1 ; !(b.y === 2 || b.z === 3) -> q.y !== 2 && q.z !== 3.
		// The disjunction-negation is an && itself, so it nests flat with no parens.
		expect(norm(text)).toContain("if (p.x === 1 && q.y !== 2 && q.z !== 3) {");
	});

	test("non-comparison guard uses a `!(...)` fallback", () => {
		const { text } = run(`
			function h(x: string): void {
				if (isBad(x)) return;
				use(x);
			}
			function call(v: string): void {
				h(v);
			}
		`);
		expect(norm(text)).toContain("if (!(isBad(v))) {");
	});
});

describe("inline-functions: argument handling", () => {
	test("guardless helper splices its statements straight into the caller", () => {
		const { text, inlined } = run(`
			function h(a: number, b: string): void {
				first(a);
				second(b);
			}
			function call(x: string): void {
				h(1, x);
			}
		`);
		expect(inlined).toEqual(["h"]);
		const n = norm(text);
		expect(n).not.toContain("function h");
		expect(n).toContain("function call(x: string): void { first(1); second(x); }");
	});

	test("impure argument is hoisted to a const evaluated unconditionally before the guard", () => {
		const { text } = run(`
			function h(x: number): void {
				if (bad(x)) return;
				use(x);
			}
			function call(): void {
				h(make());
			}
		`);
		const n = norm(text);
		// make() has a side effect and is used twice (guard + tail) -> hoist once, unconditionally.
		expect(n).toContain("const __inl_x = make();");
		expect(n.indexOf("const __inl_x = make();")).toBeLessThan(n.indexOf("if (!(bad(__inl_x)))"));
		expect(n).toContain("use(__inl_x);");
		// the call expression must appear exactly once (single evaluation)
		expect(n.match(/make\(\)/g)?.length).toBe(1);
	});

	test("pure but non-trivial argument used twice is hoisted, not duplicated", () => {
		const { text } = run(`
			function h(x: number): void {
				if (x > 0) return;
				use(x);
			}
			function call(a: number, b: number): void {
				h(a + b);
			}
		`);
		const n = norm(text);
		expect(n).toContain("const __inl_x = a + b;");
		expect(n.match(/a \+ b/g)?.length).toBe(1);
	});

	test("default mode treats a member chain as pure and inlines it (the pretty result)", () => {
		const { text } = run(`
			function h(x: number): void {
				if (x > 0) return;
				use(x);
			}
			function call(runtime: Runtime): void {
				h(runtime.count);
			}
		`);
		const n = norm(text);
		expect(n).not.toContain("const __inl_x");
		expect(n).toContain("if (runtime.count <= 0) {");
		expect(n).toContain("use(runtime.count);");
	});

	test("low-precedence inline argument gets wrapped in parens at member-access use sites", () => {
		const { text } = run(`
			function h(x: number): void {
				take(x.toFixed());
			}
			function call(a: number, b: number): void {
				h(a ? b : a);
			}
		`);
		// conditional arg used once -> inlined, parenthesized because it feeds `.toFixed()`
		expect(norm(text)).toContain("take((a ? b : a).toFixed());");
	});

	test("unused impure argument is still evaluated for its side effects", () => {
		const { text } = run(`
			function h(unusedArg: number): void {
				sideEffectFree();
			}
			function call(): void {
				h(makeNoise());
			}
		`);
		const n = norm(text);
		expect(n).toContain("makeNoise();");
		expect(n).toContain("sideEffectFree();");
	});
});

describe("inline-functions: --strict-effects", () => {
	test("hoists a member-chain argument so it evaluates eagerly, exactly once", () => {
		const { text } = run(
			`
			function h(x: number): void {
				if (x > 0) return;
				use(x);
			}
			function call(runtime: Runtime): void {
				h(runtime.count);
			}
		`,
			{ strictEffects: true },
		);
		const n = norm(text);
		expect(n).toContain("const __inl_x = runtime.count;");
		expect(n).toContain("if (__inl_x <= 0) {");
		expect(n).toContain("use(__inl_x);");
		expect(n.match(/runtime\.count/g)?.length).toBe(1);
	});

	test("snapshots every used argument left-to-right before the body", () => {
		const { text } = run(
			`
			function h(a: number, b: number): void {
				use(a);
				use2(b);
			}
			function call(x: number): void {
				h(x, (x = 2));
			}
		`,
			{ strictEffects: true },
		);
		const n = norm(text);
		// param a is read BEFORE the second argument mutates x.
		expect(n).toContain("const __inl_a = x;");
		expect(n).toContain("const __inl_b = (x = 2);");
		expect(n.indexOf("const __inl_a = x;")).toBeLessThan(n.indexOf("const __inl_b = (x = 2);"));
		expect(n).toContain("use(__inl_a);");
		expect(n).toContain("use2(__inl_b);");
	});
});

describe("inline-functions: multiple call sites", () => {
	test("every call site is inlined and the declaration removed", () => {
		const { text, inlined } = run(`
			function h(item: Item | null): void {
				if (item?.type !== "x") return;
				touch(item);
			}
			function a(r: Runtime): void { h(r.currentItem); }
			function b(r: Runtime): void { h(r.other); }
		`);
		expect(inlined).toEqual(["h"]);
		const n = norm(text);
		expect(n).not.toContain("function h(");
		expect(n).toContain('if (r.currentItem?.type === "x") {');
		expect(n).toContain('if (r.other?.type === "x") {');
	});
});

describe("inline-functions: safety skips", () => {
	const cases: Array<{ name: string; src: string }> = [
		{
			name: "exported helper",
			src: `export function h(x: number): void { if (x > 0) return; use(x); }
			      function call(): void { h(1); }`,
		},
		{
			name: "recursive helper",
			src: `function h(x: number): void { if (x > 0) return; h(x - 1); }
			      function call(): void { h(3); }`,
		},
		{
			name: "call result is used",
			src: `function h(x: number): boolean { if (x > 0) return false; return true; }
			      function call(): void { const r = h(1); use(r); }`,
		},
		{
			name: "parameter is written",
			src: `function h(x: number): void { x = x + 1; use(x); }
			      function call(): void { h(1); }`,
		},
		{
			name: "tail contains a return",
			src: `function h(x: number): void { use(x); if (x > 0) return; use2(x); }
			      function call(): void { h(1); }`,
		},
		{
			name: "async helper",
			src: `async function h(x: number): Promise<void> { use(x); }
			      function call(): void { void h(1); }`,
		},
		{
			name: "default parameter value",
			src: `function h(x: number = 5): void { use(x); }
			      function call(): void { h(); }`,
		},
		{
			name: "tail too large for --max-statements",
			src: `function h(x: number): void { if (x > 0) return; one(x); two(x); three(x); four(x); }
			      function call(): void { h(1); }`,
		},
		{
			name: "function-scoped var in tail",
			src: `function h(x: number): void { if (x > 0) return; var y = x; use(y); }
			      function call(): void { h(1); }`,
		},
		{
			name: "for (var ...) in tail",
			src: `function h(x: number): void { for (var i = 0; i < x; i++) use(i); }
			      function call(): void { h(2); }`,
		},
		{
			name: "tail declares a local function",
			src: `function h(x: number): void { if (x > 0) return; function inner() { return x; } use(inner()); }
			      function call(): void { h(1); }`,
		},
	];

	for (const c of cases) {
		test(`skips: ${c.name}`, () => {
			const { inlined } = run(c.src);
			expect(inlined).toEqual([]);
		});
	}

	test("skips when a free body identifier is shadowed at a call site", () => {
		const { inlined, text } = run(`
			function h(x: number): void { if (x > 0) return; helper(x); }
			function call(): void {
				const helper = (n: number) => n;
				h(1);
			}
		`);
		expect(inlined).toEqual([]);
		expect(text).toContain("function h(");
	});

	test("inlines when the same name lives only at module scope (no shadow)", () => {
		const { inlined } = run(`
			function helper(n: number): number { return n; }
			function h(x: number): void { if (x > 0) return; helper(x); }
			function call(): void { h(1); }
		`);
		expect(inlined).toEqual(["h"]);
	});
});

describe("inline-functions: guardless local-name collision", () => {
	test("renames a tail local that would redeclare a name already live in the target block", () => {
		const { text } = run(`
			function h(x: number): void {
				const delta = x + 1;
				use(delta);
			}
			function call(value: number): void {
				const delta = compute();
				h(value);
				log(delta);
			}
		`);
		const n = norm(text);
		// caller's `delta` is untouched; the inlined local is renamed.
		expect(n).toContain("const delta = compute();");
		expect(n).toContain("const delta_2 = value + 1;");
		expect(n).toContain("use(delta_2);");
		expect(n).toContain("log(delta);");
	});
});

describe("inline-functions: type soundness", () => {
	test("a fully-typed inline introduces no new diagnostics", () => {
		const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
		const sf = project.createSourceFile(
			"typed.ts",
			`
			interface Block { type: "thinking" | "text"; }
			interface Item { type: "reasoning" | "message"; }
			interface Runtime { currentItem: Item | null; currentBlock: Block | null; }
			declare function appendDelta(item: Item, block: Block, delta: string, n: number): void;

			function handleDelta(
				currentItem: Item | null,
				currentBlock: Block | null,
				rawEvent: Record<string, unknown>,
				n: number,
			): void {
				if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
				const delta = (rawEvent as { delta?: string }).delta || "";
				appendDelta(currentItem, currentBlock, delta, n);
			}

			export function dispatch(runtime: Runtime, rawEvent: Record<string, unknown>): void {
				handleDelta(runtime.currentItem, runtime.currentBlock, rawEvent, 0);
			}
		`,
		);
		expect(sf.getPreEmitDiagnostics()).toHaveLength(0);
		const inlined = inlineFile(sf, opts());
		expect(inlined).toEqual(["handleDelta"]);
		expect(sf.getPreEmitDiagnostics()).toHaveLength(0);
		expect(norm(sf.getFullText())).toContain(
			'if (runtime.currentItem?.type === "reasoning" && runtime.currentBlock?.type === "thinking") {',
		);
	});
});

describe("inline-functions: formatting safety", () => {
	test("wraps the tail exactly one indent level deeper than the inverted guard", () => {
		const { text } = run(
			"function dispatch(r: Runtime): void {\n\thandle(r.item);\n}\n" +
				'function handle(item: Item | null): void {\n\tif (item?.type !== "x") return;\n\ttouch(item);\n}\n',
		);
		// `if` sits at the function-body indent (one tab); its body is one deeper.
		expect(text).toContain('\tif (r.item?.type === "x") {\n\t\ttouch(r.item);\n\t}');
	});

	test("never indents the interior of a multi-line template literal in the tail", () => {
		const { text } = run(
			"function h(x: number): void {\n\tif (x > 0) return;\n\tconst s = `line1\nline2`;\n\tuse(s);\n}\n" +
				"function call(v: number): void {\n\th(v);\n}\n",
		);
		// `line2` must stay at column 0 — no tab injected into the string contents.
		expect(text).toContain("`line1\nline2`");
	});
});

describe("inline-functions: hoisted temp names", () => {
	test("distinct temp names for multiple impure calls in the same block", () => {
		const { text } = run(`
			function h(x: number): void { if (bad(x)) return; use(x); }
			function call(): void {
				h(make1());
				h(make2());
			}
		`);
		const n = norm(text);
		expect(n).toContain("const __inl_x = make1();");
		expect(n).toContain("const __inl_x_2 = make2();");
	});

	test("temp names may be reused across separate, non-overlapping blocks", () => {
		const { text } = run(`
			function h(x: number): void { if (bad(x)) return; use(x); }
			function call(flag: boolean): void {
				if (flag) {
					h(make1());
				} else {
					h(make2());
				}
			}
		`);
		const n = norm(text);
		expect((n.match(/const __inl_x =/g) ?? []).length).toBe(2);
		expect(n).not.toContain("__inl_x_2");
	});

	test("switch cases share one scope, so temp names stay distinct across cases", () => {
		const { text } = run(`
			function h(x: number): void { if (bad(x)) return; use(x); }
			function call(k: number): void {
				switch (k) {
					case 1:
						h(make1());
						break;
					case 2:
						h(make2());
						break;
				}
			}
		`);
		const n = norm(text);
		expect(n).toContain("const __inl_x = make1();");
		expect(n).toContain("const __inl_x_2 = make2();");
	});
});

describe("inline-functions: object shorthand safety", () => {
	test("expands shorthand when a substituted parameter is not a bare identifier", () => {
		const { text } = run(`
			function warn(sourceType: string): void {
				logger.warn("msg", { sourceType });
			}
			function call(source: { type: string }): void {
				warn(source.type);
			}
		`);
		expect(norm(text)).toContain('logger.warn("msg", { sourceType: source.type });');
	});

	test("expands shorthand when a colliding tail local is renamed", () => {
		const { text } = run(`
			function h(): void {
				const id = compute();
				use({ id });
			}
			function call(): void {
				const id = 1;
				h();
				log(id);
			}
		`);
		const n = norm(text);
		expect(n).toContain("const id_2 = compute();");
		expect(n).toContain("use({ id: id_2 });");
	});

	test("does not rename a tail local that only matches a property name in the block", () => {
		const { text } = run(`
			function h(): void {
				const index = compute();
				use(index);
			}
			function call(obj: { index: number }): void {
				read(obj.index);
				h();
			}
		`);
		const n = norm(text);
		expect(n).toContain("const index = compute();");
		expect(n).not.toContain("index_2");
	});

	test("does not rename a tail local that only matches a type name in the block", () => {
		const { text } = run(`
			interface Thing { id: number }
			function h(): void {
				const Thing = makeThing();
				use(Thing);
			}
			function call(): void {
				const x: Thing = { id: 1 };
				h();
			}
		`);
		const n = norm(text);
		expect(n).toContain("const Thing = makeThing();");
		expect(n).not.toContain("Thing_2");
	});
});

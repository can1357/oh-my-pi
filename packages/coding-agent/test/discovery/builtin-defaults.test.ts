/**
 * The bundled `builtin-defaults` rule provider ships a curated default rule set
 * embedded into the binary. These tests defend that the whole set loads and
 * parses, and that the provider sits at the lowest priority so any user/project
 * rule of the same name overrides a bundled default (first-wins dedup).
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import {
	BUILTIN_DEFAULTS_PROVIDER_ID,
	compileRuleCondition,
	type Rule,
	ruleCapability,
} from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function ruleProvider() {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	return { cap, provider };
}

async function loadBuiltinRules(): Promise<Rule[]> {
	const { provider } = ruleProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

describe("builtin-defaults rule provider", () => {
	it("loads the bundled default rule set, all attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		const names = rules.map(r => r.name);
		// Name-based dedup is first-wins, so a duplicate would be silently shadowed.
		expect(new Set(names).size).toBe(names.length);
	});

	it("parses every bundled rule as a TTSR rule (non-empty condition/astCondition and scope)", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			const conditionCount = (rule.condition?.length ?? 0) + (rule.astCondition?.length ?? 0);
			expect(conditionCount, `${rule.name} condition/astCondition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
		}
	});

	it("forces every bundled rule to warn without interrupting", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			expect(rule.interruptMode, rule.name).toBe("never");
		}
	});

	it("fires the no-test-timers rule on real timers in *.test.ts but not plain *.ts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-test-timers");
		if (!rule) throw new Error("ts-no-test-timers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["await Bun.sleep(10)", "setTimeout(fn, 0)", "setInterval(fn, 5)"]) {
			manager.resetBuffer();
			const matches = manager.checkDelta(snippet, {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/test/foo.test.ts"],
			});
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-test-timers"]);
		}

		// Same content in a non-test file is out of scope.
		manager.resetBuffer();
		expect(
			manager.checkDelta("await Bun.sleep(10)", {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-local-is-record on local function and lambda definitions", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-local-is-record");
		if (!rule) throw new Error("ts-no-local-is-record rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of [
			'function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object"; }',
			'const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object";',
			'const isRecord = function (value: unknown): value is Record<string, unknown> { return typeof value === "object"; };',
		]) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, {
					source: "tool",
					toolName: "write",
					filePaths: ["packages/x/src/foo.ts"],
				}),
			).toHaveLength(1);
		}

		manager.resetBuffer();
		expect(
			manager.checkDelta('import { isRecord } from "@oh-my-pi/pi-utils";', {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-inline-cast-access on inline cast-and-access but not named-type casts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-inline-cast-access");
		if (!rule) throw new Error("ts-no-inline-cast-access rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// AST conditions only run on edit/write streams, with the language inferred from the path.
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		// Inline object-type assertion immediately read — every access form is flagged.
		const violations = [
			"const a = (value as { content: unknown }).content;",
			"const b = (value as { content: unknown })?.content;",
			'const c = (opts as { enabled: boolean })["enabled"];',
			"const d = (value as unknown as { content: unknown }).content;",
		];
		for (const snippet of violations) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-inline-cast-access"]);
		}

		// A cast to a named type, plain member access, and a bare cast (no read) are all left alone.
		const allowed = [
			"const e = (value as Foo).bar;",
			"const f = obj.content;",
			"const g = value as { content: unknown };",
		];
		for (const snippet of allowed) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(matches, snippet).toEqual([]);
		}

		// Out of scope: the same violation in a non-TS file never reaches the matcher.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot("const h = (value as { content: unknown }).content;", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/foo.js"],
			}),
		).toEqual([]);
	});
	it("opens every bundled regex condition that uses a bare line anchor with the multiline inline flag", async () => {
		// Without the (?m) inline flag a bare ^ or $ anchors to the absolute
		// start/end of input, so a rule whose condition is anchored to a line
		// silently stops matching in real files (see #6890). Enforce the pairing
		// at load time so the failure class stays closed.
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			for (const condition of rule.condition ?? []) {
				const outsideCharClasses = condition.replace(/\[[^\]]*\]/g, "");
				const hasBareAnchor = /(^|[^\\])[\^$]/.test(outsideCharClasses);
				const hasMultilineSemantics = compileRuleCondition(condition).multiline;
				expect(
					hasBareAnchor ? hasMultilineSemantics : true,
					`${rule.name}: a condition with a bare ^ or $ anchor must open with the multiline inline flag`,
				).toBe(true);
			}
		}
	});

	it("fires ts-no-tiny-functions on local one-expression functions, not on exported names, public members, type guards or blocks", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-tiny-functions");
		if (!rule) throw new Error("ts-no-tiny-functions rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		const hits = [
			// Real files end with a newline, so the arrow alternative must match
			// before the line terminator, not only at the absolute end of input.
			"const getName = (u) => u.profile.name;\n",
			"const getName = (u) => u.profile.name;",
			"const a = 1;\nconst getName = (u) => u.profile.name;\nconst b = 2;",
			"const original = globalThis.Worker; const out = x => write(x);",
			"function isEmpty(value: string): boolean {\n\treturn value.length === 0;\n}",
			"\tfunction double(value: number) { return value * 2; }",
			"function sizeOf(data: string): { width: number; height: number } | null {\n\treturn imageSize(data);\n}",
			"function draw<T>(pool: readonly T[], key: (item: T) => string): T[] {\n\treturn [...pool].sort(by(key));\n}",
			"const getDisplayName = (user: User): string => {\n\treturn user.profile.displayName;\n};",
			"const pick = function (row: Row) { return row.id; };",
			"\t#remaining(): number {\n\t\treturn this.#until - Date.now();\n\t}",
			"\tprivate get label(): string { return this.name; }",
			"\tget #label(): string { return this.name; }",
			"class C {\n\tprivate readonly f = () => { return value; };\n}",
			"const f = <T>(x: T) => { return x; };",
			"function f(x = make(inside())) { return x; }",
			"function f()\n{ return value; }",
			"function f()\r\n{ return value; }\r\n",
			"function f():\nnumber { return value; }",
			"function f<T extends Record<string, Array<number>>>(x: T) {\n\treturn x;\n}",
			"async function load(id: string): Promise<Row> {\n\treturn db.get(id);\n}",
			"class C {\n\tprivate f = (x) => x * 2;\n\t#g = (x) => x + 1;\n}",
			"const f = async (x) => x * 2;",
			"const f = (x: number): number => x * 2;",
		];
		for (const snippet of hits) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, ctx, { final: true }).map(m => m.name),
				snippet,
			).toEqual(["ts-no-tiny-functions"]);
		}

		// The rule's own exemptions (exported names, type guards, public API and test seams),
		// callbacks, and if/try/catch blocks, which are not functions at all.
		const misses = [
			"function f(v) { const x = v.a; return x; }",
			"const f = (v) => { const x = v.a; return x; };",
			"export function isEmpty(value: string): boolean {\n\treturn value.length === 0;\n}",
			"export const getName = (u: User) => u.profile.name;",
			"export default function f() { return 1; }",
			'const isText = (v: unknown): v is string => typeof v === "string";',
			"class C {\n\tf = (x) => x * 2;\n}",
			'function isAssistant(entry: Entry): entry is AssistantEntry {\n\treturn entry.role === "assistant";\n}',
			"if (!response.ok) {\n\treturn null;\n}",
			"try {\n\treturn JSON.parse(text);\n} catch {\n\treturn undefined;\n}",
			"class Clock {\n\tnow(): number { return this.time; }\n\tget size(): number {\n\t\treturn this.#items.size;\n\t}\n}",
			"class C {\n\tf = () => { return value; };\n\tprotected g(): number { return 1; }\n}",
			"const fake = { async capabilities() { return undefined; }, get ready() { return true; } };",
			"const ids = items.map(item => { return item.id; });",
			"promise.then(function (value) { return value.id; });",
			"\tasync #node(): Promise<AxNode> {\n\t\tconst node = await read(this.ref);\n\t\treturn node;\n\t}\n\tget ref() { return this.id; }",
		];
		for (const snippet of misses) {
			manager.resetBuffer();
			expect(manager.checkDelta(snippet, ctx, { final: true }), snippet).toEqual([]);
		}
	});

	it("checks ts-no-tiny-functions and ts-promise-with-resolvers in linear time on long whitespace runs", async () => {
		const rules = (await loadBuiltinRules()).filter(
			r => r.name === "ts-no-tiny-functions" || r.name === "ts-promise-with-resolvers",
		);
		const manager = new TtsrManager();
		for (const rule of rules) expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };
		const spaces = " ".repeat(32_000);
		// Each of these is a quadratic backtrack (seconds) for a pattern with two adjacent
		// whitespace runs; a stalled check blocks the stream that is being matched.
		for (const snippet of [
			`function ${spaces}!`,
			`function f${spaces}<T>${spaces}(x) ${spaces}: T ${spaces}!`,
			`function f(): ${spaces}`,
			`const f = (x) =>${spaces}{`,
			`\tprivate${spaces}f${spaces}=${spaces}(x)${spaces}:${spaces}!`,
			`new Promise(${spaces}function${spaces}(${spaces}`,
		]) {
			manager.resetBuffer();
			const start = performance.now();
			expect(manager.checkDelta(snippet, ctx, { final: true })).toEqual([]);
			expect(performance.now() - start, snippet.trim().slice(0, 20)).toBeLessThan(500);
		}
	});

	it("fires ts-promise-with-resolvers on executors that take a resolver, not on never-settling promises", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-promise-with-resolvers");
		if (!rule) throw new Error("ts-promise-with-resolvers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "write", filePaths: ["src/foo.ts"] };
		const fires = (deltas: string[]) => {
			manager.resetBuffer();
			return deltas.flatMap(delta => manager.checkDelta(delta, ctx).map(m => m.name));
		};

		for (const deltas of [
			["return new Promise(resolve => {\n\tsetTimeout(resolve, ms);\n});"],
			["await new Promise(r => setImmediate(r));"],
			["new Promise((resolve, reject) => {"],
			["new Promise(function (resolve) {"],
			["new Promise(async (resolve) => {"],
			["new Promise((...args) => args[0]());"],
			["new Promise(/* resolver */ resolve => resolve());"],
			["new Promise((/* resolver */ ", "resolve) => resolve());"],
			["await new Promise(requestAnimationFrame);"],
			["new Promise(executors[0]);"],
			["new Promise(makeExecutor());"],
			["new Promise<void>(resolve => setTimeout(resolve, 1));"],
			["new Promise<() => void>(resolve => resolve(() => {}));"],
			["await new Promise(", "r => setImmediate(r));"],
		]) {
			expect(fires(deltas), deltas.join("")).toEqual(["ts-promise-with-resolvers"]);
		}
		// No resolver for Promise.withResolvers() to replace; a stream paused right after
		// `new Promise(` must not fire before the executor arrives.
		for (const deltas of [
			["await new Promise(() => {});"],
			["new Promise(function hang() {});"],
			["new Promise(async () => {});"],
			["new Promise<string>(() => {});"],
			["new Promise(/* never */ () => {});"],
			["await new Promise(", "() => {});"],
			["await new Promise(func", "tion () {});"],
		]) {
			expect(fires(deltas), deltas.join("")).toEqual([]);
		}
	});

	it("go-new-expr matches value→pointer helpers (named + generic) but not real functions, only on *.go", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-new-expr");
		if (!rule) throw new Error("go-new-expr rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] };

		const hits = [
			"package p\nfunc boolPtr(v bool) *bool { return &v }",
			"package p\nfunc Ptr[T any](v T) *T { return &v }",
		];
		for (const snippet of hits) {
			manager.resetBuffer();
			expect(
				(await manager.checkAstSnapshot(snippet, ctx)).map(m => m.name),
				snippet,
			).toEqual(["go-new-expr"]);
		}

		const misses = [
			"package p\nfunc add(a int, b int) *int { return &a }",
			"package p\nfunc (s *S) Get() *int { return &s.x }",
		];
		for (const snippet of misses) {
			manager.resetBuffer();
			expect(await manager.checkAstSnapshot(snippet, ctx), snippet).toEqual([]);
		}

		// AST conditions never reach a non-go path.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(hits[0], { source: "tool", toolName: "edit", filePaths: ["pkg/foo.ts"] }),
		).toEqual([]);
	});

	it("go-bench-loop fires on a *testing.B b.N loop but not an ordinary .N counter", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-bench-loop");
		if (!rule) throw new Error("go-bench-loop rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo_test.go"] };

		const bench =
			"package p\nfunc BenchmarkX(b *testing.B) {\n\tsetup()\n\tfor i := 0; i < b.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect((await manager.checkAstSnapshot(bench, ctx)).map(m => m.name)).toEqual(["go-bench-loop"]);

		// A `.N` selector on something that is not the benchmark receiver must not fire.
		const helper =
			"package p\nfunc TestThing(t *testing.T) {\n\treq := build()\n\tfor i := 0; i < req.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect(await manager.checkAstSnapshot(helper, ctx)).toEqual([]);
	});

	it("go-range-int fires only on *.go, never on a same-named non-go path", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-range-int");
		if (!rule) throw new Error("go-range-int rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		const loop = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i++ {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			(await manager.checkAstSnapshot(loop, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] })).map(
				m => m.name,
			),
		).toEqual(["go-range-int"]);
		// A step-2 loop is not equivalent to range-over-int and must not fire.
		const step2 = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i += 2 {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(step2, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] }),
		).toEqual([]);
	});

	async function streamRule(name: string): Promise<(...deltas: string[]) => string[]> {
		const rule = (await loadBuiltinRules()).find(r => r.name === name);
		if (!rule) throw new Error(`${name} rule missing`);
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };
		return (...deltas) => {
			manager.resetBuffer();
			const names = deltas.flatMap(delta => manager.checkDelta(delta, ctx).map(r => r.name));
			// The stream ends with a final check, as the TTSR coordinator sends: matches on a long
			// unterminated line may be deferred until then.
			names.push(...manager.checkDelta("", ctx, { final: true }).map(r => r.name));
			return [...new Set(names)];
		};
	}

	it("fires ts-set-map on string-literal initializers but not on empty or computed sets and maps", async () => {
		const fired = await streamRule("ts-set-map");
		const hits = [
			'const KINDS = new Set(["text", "json"]);',
			"const LABELS = new Map<string, string>([['text', 'Text']]);",
			'const ROLES = new Set<PropertyKey>([\n\t"select",\n\t"confirm",\n]);',
			'const LABELS = new Map<\n\tstring,\n\tstring\n>([["text", "Text"]]);',
			'const TRANSFORMS = new Map<string, (value: string) => string>([["trim", value => value.trim()]]);',
			'const KINDS = new Set<string>([ /* categories */ "a", "b" ]);',
			'const KINDS = new Set([\n\t// text kinds\n\t"text",\n\t"json", // structured\n]);',
			'const LABELS = new Map([\n\t["text", "Text"],\n\t["json", "JSON"],\n]);',
			'const ALIASES = new Map<string, string[]>([["ts", ["typescript", "tsx"]]]);',
			'const COLUMNS = new Map([["first", ROW[0]], ["second", ROW[1]]]);',
			"const KINDS = new Set([`text`, `json`]);",
			'const GREETINGS = new Set(["say \\"hi\\"", "bye"]);',
			'const KINDS = new Set([/* categories * kept together */ "a", "b"]);',
			'const CLOSERS = new Map([["close", "]"]]);',
			'const SIZES = new Map([["small", 1] as const, ["large", 2] as const]);',
			'const KINDS = new Set(["text", "json"] as const);',
			'const KEYS = new Set(["topP", "topK"] as const satisfies readonly (keyof StreamOptions)[]);',
			'const KINDS = new Set([\n\t"text",\n\t"json",\n],\n);',
			// Any type clause after the array: only the token right after `]` is read.
			'const KINDS = new Set(["a"] as const satisfies\n\treadonly string[]);',
			'const SIZES = new Map([["a", 1]] as const satisfies\n\tReadonlyArray<readonly [string, number]>);',
			'const KINDS = new Set(["a", "b"] as const satisfies readonly ((typeof KIND)[number])[]);',
			'const KINDS = new Set(["a"] as ReadonlyArray<\n\tstring\n>);',
			'const SIZES = new Map([["a", { x: 1 }]] as [string, { x: number; y?: number }][]);',
			'const KINDS = new Set(["a"] /* static */ as const);',
		];
		for (const snippet of hits) {
			expect(fired(snippet), snippet).toEqual(["ts-set-map"]);
			// Streamed a character at a time it fires too, once the token after `]` arrives.
			expect(new Set(fired(...snippet)), snippet).toEqual(new Set(["ts-set-map"]));
		}

		// Shapes the rule body keeps as Set/Map: runtime-built membership and lookups.
		const misses = [
			"const seen = new Set<string>();",
			"#pending = new Map<number, (m: { result?: unknown }) => void>();",
			"const byId = new Map(items.map(item => [item.id, item]));",
			"const keys = new Set([...Object.keys(a), ...Object.keys(b)]);",
			// oxlint-disable-next-line no-template-curly-in-string -- literal TypeScript source fed to the rule
			"const prefixed = new Set([`${prefix}-a`]);",
			"for (const id of new Set(ids)) {}",
			'const labels = new Map<string, string>().set("key", choose<string>(["a", "b"]));',
			'const keep = new Set(["vendor", ...legs.map(leg => leg.id)]);',
			'const counts = new Map([["known", 1], ...runtimeEntries]);',
			// A table filling a 1000-character line is not small; bailing there keeps streaming one cheap.
			`const SCHEMAS = new Map([["schema", "${"x".repeat(1000)}"]]);`,
			// A literal array that is only the input to a computed argument.
			'const known = new Map([["known", 1] as const].filter(predicate));',
			'const known = new Map([["known", 1]].filter(predicate));',
			'const kinds = new Set(["a", "b"].map(normalize));',
			'const kinds = new Set(["a", "b"]\n\t.map(normalize));',
			'const kinds = new Set(["a"] /* raw */ .map(normalize));',
			'const kinds = new Set(["a", "b"].concat(extra));',
			'const kinds = new Set(["a", "b"]?.map(normalize));',
		];
		for (const snippet of misses) {
			expect(fired(snippet), snippet).toEqual([]);
			// Streamed, it waits for the token after `]` instead of firing at the bracket.
			expect(fired(...snippet), snippet).toEqual([]);
		}
	});

	it("checks ts-set-map in linear time while a long single-line table streams in", async () => {
		// A backtracking `Set` condition streams 10,000 characters fast but takes 5 s at 20,000.
		const value = "x".repeat(20_000);
		const fired = await streamRule("ts-set-map");
		const cases: [source: string, names: string[]][] = [
			// The Map condition gives up on a `new Map` line past 1000 characters: no table that long is small.
			[`const SCHEMAS = new Map([["schema", "${value}"]]);`, []],
			[`const SCHEMAS = new Map([["schema", ${"x+".repeat(10_000)}x]]);`, []],
			[`const SCHEMAS = new Set(["${value}"]);`, ["ts-set-map"]],
			[`const SCHEMAS = new Set([/* ${value} */ "a"]);`, ["ts-set-map"]],
		];
		for (const [source, expected] of cases) {
			const deltas = source.match(/[\s\S]{1,20}/g) ?? [];
			// Each delta rescans the whole unfinished line; a per-character backtrack there made this take seconds.
			const start = performance.now();
			const names = fired(...deltas);
			const elapsed = performance.now() - start;
			expect(new Set(names), source.slice(0, 40)).toEqual(new Set(expected));
			expect(elapsed, source.slice(0, 40)).toBeLessThan(500);
		}
	});

	it("fires ts-import-type on inline type imports but not on runtime import() calls", async () => {
		const fired = await streamRule("ts-import-type");
		const hits = [
			'function run(client: import("some-sdk").Client): void {}',
			'type Condense = import("./designs.js").Condense;',
			'const options: import("arktype").infer<Schema> = value;',
			'const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");',
			'type Mod = typeof import("./mod");',
			'let call: Parameters<typeof import("./declared-arguments").check>[0];',
			'type Page = import("puppeteer-core")["Page"];',
			'type Client = import(/* sdk */ "some-sdk").Client;',
			'type Load = () => typeof import("./mod");',
			'type Pair = [typeof import("./a"), string];',
			'type Both = Base & typeof import("./mod");',
			'type Thing = import("pkg", { with: { "resolution-mode": "import" } }).Thing;',
			'type Mod = (typeof import("./mod"));',
			'type Keys = keyof typeof import("./mod");',
			'type Client = import(/* SDK * pinned */ "sdk").Client;',
			'type Temperature = import("./units").温度;',
			'type Kelvin = import("./units").𐐀;',
		];
		for (const snippet of hits) expect(fired(snippet), snippet).toEqual(["ts-import-type"]);

		// Runtime loads belong to ts-no-dynamic-import, or to no rule at all.
		const misses = [
			'const { carryFindings } = await import("./designs.js");',
			'const mod = (await import("./known-module")).default;',
			// oxlint-disable-next-line no-template-curly-in-string -- literal TypeScript source fed to the rule
			"const { completeText } = await import(`${cwd}/src/client.ts`);",
			'const [manifest] = await Promise.all([import("../readers/manifest.js")]);',
			'const impit = import("impit").then(({ Impit }) => new Impit());',
			// Non-ASCII whitespace around a Promise method is not part of a member name.
			'const impit = import("impit").then\u00a0(({ Impit }) => new Impit());',
			'const impit = import("impit").\u2028catch(error => error);',
		];
		for (const snippet of misses) expect(fired(snippet), snippet).toEqual([]);

		// The stream pauses mid-call: the rule waits for the member name before deciding.
		expect(fired('const impit = import("impit").', "then(({ Impit }) => new Impit());")).toEqual([]);
	});

	it("fires ts-no-any on any annotations and casts but not on the English word in comments", async () => {
		const fired = await streamRule("ts-no-any");
		const hits = [
			"function readId(value: any): string {}",
			"const root = el as any;",
			"const config = { port: 3000 } as any as ServerConfig;",
			"const config = value as any satisfies Config;",
			"const rows: any[] = [];",
			"let entry: any;",
			"items.map((item: any) => item.id);",
			"function readId(value: unknown): any {",
			"const id = (value as any) ?? fallback;",
			"const id = value as any ?? fallback;",
			"const id = value as any!;",
			"let entry: any /* TODO */;",
			"let entry: any // TODO: type this\n",
			"\t*next(value: any) {}",
			"const n = value as any + 1;",
			"const n = value as any instanceof Foo;",
			"const n = (value as any) in obj;",
			"let entry: any",
			"type Box = { value: any extends string ? 1 : 0 };",
		];
		for (const snippet of hits) expect(fired(snippet), snippet).toEqual(["ts-no-any"]);

		const misses = [
			"// Native terminal mapping: any tool call wins over every finish",
			" * intact: anything that cited the preview's lines can still resolve.",
			" * (`tallyStep`'s `items`): any of them fails the phase.",
			"/** `posts.raw_json`, as far as anything reads it back. */",
			"// The debugging bar shows while omp has any one attached.",
			"return any?.newest ? { date: any.newest } : {};",
			"// mapping: any\nconst flag = true;",
			"const flag = true; // as far as any\nreturn flag;",
		];
		for (const snippet of misses) expect(fired(snippet), snippet).toEqual([]);

		// A stream paused right after the word must not fire before the rest of it arrives.
		expect(fired(" * intact: any", "thing that cited the preview's lines.\n")).toEqual([]);
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});

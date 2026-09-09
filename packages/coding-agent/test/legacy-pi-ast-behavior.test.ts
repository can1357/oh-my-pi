import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	__rewriteLegacyExtensionSourceForTests,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface RewriteCase {
	name: string;
	source: string;
	expected(importTarget: string, requireTarget: string): string;
}

interface CommonJsCase {
	name: string;
	source: string;
	files?: Record<string, string>;
	expected: Record<string, unknown>;
}

let rewriteRoot: string;
let rewriteImporter: string;
let importTarget: string;
let requireTarget: string;
const tempRoots: string[] = [];

beforeAll(async () => {
	// realpath: rewritten specifiers are canonical (macOS /var ↔ /private/var).
	rewriteRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-ast-rewrite-")));
	tempRoots.push(rewriteRoot);
	const dependencyPath = path.join(rewriteRoot, "node_modules", "tracked-dep", "index.js");
	await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
	await fs.writeFile(
		path.join(rewriteRoot, "node_modules", "tracked-dep", "package.json"),
		JSON.stringify({ name: "tracked-dep", version: "1.0.0", main: "index.js" }),
		"utf8",
	);
	await fs.writeFile(dependencyPath, 'module.exports = { marker: "tracked" };\n', "utf8");
	rewriteImporter = path.join(rewriteRoot, "extension.ts");
	importTarget = url.pathToFileURL(dependencyPath).href;
	requireTarget = dependencyPath.replaceAll("\\", "/");
});

afterAll(async () => {
	for (const dir of tempRoots) await removeWithRetries(dir);
});

const rewriteCases: RewriteCase[] = [
	{
		name: "import, re-export, dynamic import, and TS import-equals sources",
		source: [
			'import value from "tracked-dep";',
			'export { default as named } from "tracked-dep";',
			'export * from "tracked-dep";',
			'const lazy = import("tracked-dep");',
			'import tracked = require("tracked-dep");',
		].join("\n"),
		expected: (importPath, requirePath) =>
			[
				`import value from ${JSON.stringify(importPath)};`,
				`export { default as named } from ${JSON.stringify(importPath)};`,
				`export * from ${JSON.stringify(importPath)};`,
				`const lazy = import(${JSON.stringify(importPath)});`,
				`import tracked = require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "comments, strings, templates, regexes, and member calls are excluded",
		source: [
			"const text = 'require(\"tracked-dep\")';",
			'const template = `import("tracked-dep")`;',
			'const pattern = /require\\("tracked-dep"\\)/;',
			'// require("tracked-dep");',
			'/* import("tracked-dep"); */',
			'loader.require("tracked-dep");',
			'require.resolve("tracked-dep");',
			'(0, require)("tracked-dep");',
		].join("\n"),
		expected: () =>
			[
				"const text = 'require(\"tracked-dep\")';",
				'const template = `import("tracked-dep")`;',
				'const pattern = /require\\("tracked-dep"\\)/;',
				'// require("tracked-dep");',
				'/* import("tracked-dep"); */',
				'loader.require("tracked-dep");',
				'require.resolve("tracked-dep");',
				'(0, require)("tracked-dep");',
			].join("\n"),
	},
	{
		name: "global require is rewritten without disturbing adjacent excluded calls",
		source: ['const loaded = require("tracked-dep");', 'loader.require("tracked-dep");'].join("\n"),
		expected: (_importPath, requirePath) =>
			[`const loaded = require(${JSON.stringify(requirePath)});`, 'loader.require("tracked-dep");'].join("\n"),
	},
	{
		name: "import declarations shadow require across the program",
		source: ['import require from "node:module";', 'require("tracked-dep");'].join("\n"),
		expected: () => ['import require from "node:module";', 'require("tracked-dep");'].join("\n"),
	},
	{
		name: "TS import-equals declarations shadow require only in their namespace",
		source: [
			'namespace Nested { import require = require("node:module"); require("tracked-dep"); }',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'namespace Nested { import require = require("node:module"); require("tracked-dep"); }',
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "erased ambient TS function, class, and namespace declarations do not shadow require",
		source: [
			'declare function require(id: string): unknown; require("tracked-dep");',
			'declare class require {} require("tracked-dep");',
			'declare namespace require {} require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				`declare function require(id: string): unknown; require(${JSON.stringify(requirePath)});`,
				`declare class require {} require(${JSON.stringify(requirePath)});`,
				`declare namespace require {} require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "ambient TS var declarations retain Babel value bindings",
		source: 'declare var require: unknown; require("tracked-dep");',
		expected: () => 'declare var require: unknown; require("tracked-dep");',
	},
	{
		name: "ambient TS const declarations retain Babel value bindings",
		source: 'declare const require: unknown; require("tracked-dep");',
		expected: () => 'declare const require: unknown; require("tracked-dep");',
	},
	{
		name: "non-ambient TS enum and namespace names do not create Babel value bindings",
		source: [
			'function enumOuter() { { enum require { A } require("tracked-dep"); } require("tracked-dep"); }',
			'function namespaceOuter() { namespace require {} require("tracked-dep"); }',
			'namespace Outer { namespace require {} require("tracked-dep"); }',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				`function enumOuter() { { enum require { A } require(${JSON.stringify(requirePath)}); } require(${JSON.stringify(requirePath)}); }`,
				`function namespaceOuter() { namespace require {} require(${JSON.stringify(requirePath)}); }`,
				`namespace Outer { namespace require {} require(${JSON.stringify(requirePath)}); }`,
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "function declaration and expression names shadow require before textual declaration",
		source: [
			'function declarationScope() { require("tracked-dep"); function require() {} }',
			'const named = function require() { require("tracked-dep"); };',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'function declarationScope() { require("tracked-dep"); function require() {} }',
				'const named = function require() { require("tracked-dep"); };',
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "default, rest, and destructured parameters shadow require",
		source: [
			'function defaulted(require = () => {}) { require("tracked-dep"); }',
			'function rested(...require) { require("tracked-dep"); }',
			'function destructured({ loader: require = () => {} }, [other, ...tail]) { require("tracked-dep"); }',
		].join("\n"),
		expected: () =>
			[
				'function defaulted(require = () => {}) { require("tracked-dep"); }',
				'function rested(...require) { require("tracked-dep"); }',
				'function destructured({ loader: require = () => {} }, [other, ...tail]) { require("tracked-dep"); }',
			].join("\n"),
	},
	{
		name: "var, let, const, class, and block function declarations shadow irrespective of order",
		source: [
			'function varScope() { require("tracked-dep"); var require; }',
			'function letScope() { { require("tracked-dep"); let require; } }',
			'function constScope() { { require("tracked-dep"); const require = () => {}; } }',
			'function classScope() { { require("tracked-dep"); class require {} } }',
			'function declarationScope() { { require("tracked-dep"); function require() {} } }',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'function varScope() { require("tracked-dep"); var require; }',
				'function letScope() { { require("tracked-dep"); let require; } }',
				'function constScope() { { require("tracked-dep"); const require = () => {}; } }',
				'function classScope() { { require("tracked-dep"); class require {} } }',
				'function declarationScope() { { require("tracked-dep"); function require() {} } }',
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "for, switch, class, and static-block scopes do not leak",
		source: [
			'for (let require = () => false; false; ) { require("tracked-dep"); }',
			'switch (0) { case 0: require("tracked-dep"); break; case 1: const require = () => {}; }',
			'switch (require("tracked-dep")) { case 0: let require; require("tracked-dep"); }',
			'const Holder = class require { method() { require("tracked-dep"); } };',
			'const Heritage = class require extends require("tracked-dep") {};',
			'class StaticHolder { static { require("tracked-dep"); let require; } }',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'for (let require = () => false; false; ) { require("tracked-dep"); }',
				'switch (0) { case 0: require("tracked-dep"); break; case 1: const require = () => {}; }',
				`switch (require(${JSON.stringify(requirePath)})) { case 0: let require; require("tracked-dep"); }`,
				'const Holder = class require { method() { require("tracked-dep"); } };',
				'const Heritage = class require extends require("tracked-dep") {};',
				'class StaticHolder { static { require("tracked-dep"); let require; } }',
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "catch, nested function, and nested block bindings stay lexical",
		source: [
			'try {} catch (require) { require("tracked-dep"); }',
			'function outer(require) { function inner() { require("tracked-dep"); } }',
			'{ const require = () => {}; { require("tracked-dep"); } }',
			'require("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'try {} catch (require) { require("tracked-dep"); }',
				'function outer(require) { function inner() { require("tracked-dep"); } }',
				'{ const require = () => {}; { require("tracked-dep"); } }',
				`require(${JSON.stringify(requirePath)});`,
			].join("\n"),
	},
	{
		name: "createRequire factory invocation pins its bare dependency, leaving relative and non-createRequire calls alone",
		source: [
			'import { createRequire as makeNodeRequire } from "node:module";',
			'import * as nodeModule from "node:module";',
			'const direct = makeNodeRequire(import.meta.url)("tracked-dep");',
			'const viaModule = nodeModule.createRequire("./anchor")("tracked-dep");',
			'const relative = makeNodeRequire(import.meta.url)("./sibling");',
			"const createRequire = () => makeRequire;",
			'const shadowed = createRequire(import.meta.url)("tracked-dep");',
			'const unrelated = other.createRequire(import.meta.url)("tracked-dep");',
			'const otherFactory = makeRequire(import.meta.url)("tracked-dep");',
		].join("\n"),
		expected: (_importPath, requirePath) =>
			[
				'import { createRequire as makeNodeRequire } from "node:module";',
				'import * as nodeModule from "node:module";',
				`const direct = makeNodeRequire(import.meta.url)(${JSON.stringify(requirePath)});`,
				`const viaModule = nodeModule.createRequire("./anchor")(${JSON.stringify(requirePath)});`,
				'const relative = makeNodeRequire(import.meta.url)("./sibling");',
				"const createRequire = () => makeRequire;",
				'const shadowed = createRequire(import.meta.url)("tracked-dep");',
				'const unrelated = other.createRequire(import.meta.url)("tracked-dep");',
				'const otherFactory = makeRequire(import.meta.url)("tracked-dep");',
			].join("\n"),
	},
];

async function loadCommonJsCase(testCase: CommonJsCase): Promise<{ keys: string[]; named: Record<string, unknown> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-ast-exports-"));
	tempRoots.push(dir);
	const files: Record<string, string> = {
		"package.json": JSON.stringify({ name: `cjs-${testCase.name}`, version: "1.0.0", type: "module" }),
		"subject.cjs": testCase.source,
		"index.ts": [
			'import * as subject from "./subject.cjs";',
			"export const keys = Object.keys(subject).sort();",
			'export const named = Object.fromEntries(keys.filter(key => key !== "default").map(key => {',
			"  const value = subject[key];",
			'  return [key, typeof value === "function" ? value() : value];',
			"}));",
		].join("\n"),
		...testCase.files,
	};
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(dir, relativePath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.writeFile(absolutePath, contents, "utf8");
	}
	return (await loadLegacyPiModule(path.join(dir, "index.ts"))) as {
		keys: string[];
		named: Record<string, unknown>;
	};
}

const commonJsCases: CommonJsCase[] = [
	{
		name: "direct-assignments",
		source: [
			'exports.alpha = "alpha";',
			'module.exports.bravo = "bravo";',
			'module.exports["charlie"] = "charlie";',
			'exports["invalid-name"] = "excluded";',
		].join("\n"),
		expected: { alpha: "alpha", bravo: "bravo", charlie: "charlie" },
	},
	{
		name: "define-property",
		source: [
			'Object.defineProperty(exports, "delta", { enumerable: true, value: "delta" });',
			'Object.defineProperty(module.exports, "echo", { enumerable: true, value: "echo" });',
			'Object.defineProperty(exports, "default", { enumerable: true, value: "excluded" });',
		].join("\n"),
		expected: { delta: "delta", echo: "echo" },
	},
	{
		name: "module-exports-object",
		source:
			'module.exports = { foxtrot: "foxtrot", golf() { return "golf"; }, "hotel": "hotel", ["computed"]: "excluded", default: "excluded", "invalid-name": "excluded" };',
		expected: { foxtrot: "foxtrot", golf: "golf", hotel: "hotel" },
	},
	{
		name: "module-exports-require",
		source: 'module.exports = require("./leaf.cjs");',
		files: { "leaf.cjs": 'exports.india = "india";\nmodule.exports.juliet = "juliet";\n' },
		expected: { india: "india", juliet: "juliet" },
	},
	{
		name: "export-star",
		source: [
			"const __exportStar = (source, target) => {",
			'  for (const key of Object.keys(source)) if (key !== "default") target[key] = source[key];',
			"};",
			'__exportStar(require("./leaf.cjs"), exports);',
		].join("\n"),
		files: { "leaf.cjs": 'exports.kilo = "kilo";\n' },
		expected: { kilo: "kilo" },
	},
	{
		name: "parameter-shadows",
		source: [
			'exports.good = "good";',
			'function objectShadow(Object) { Object.defineProperty(exports, "badObject", {}); }',
			'function exportsShadow(exports) { exports.badExports = true; Object.defineProperty(exports, "badDefined", {}); }',
			"function moduleShadow(module) { module.exports.badModule = true; module.exports = { badObject: true }; }",
			'function requireShadow(require) { module.exports = require("./leaf.cjs"); __exportStar(require("./leaf.cjs"), exports); }',
		].join("\n"),
		files: { "leaf.cjs": 'exports.badLeaf = "excluded";\n' },
		expected: { good: "good" },
	},
	{
		name: "hoisted-program-exports-shadow",
		source: ['exports.badExports = "excluded";', "var exports;"].join("\n"),
		expected: {},
	},
	{
		name: "hoisted-program-module-shadow",
		source: ['module.exports.badModule = "excluded";', "var module;", 'exports.good = "good";'].join("\n"),
		expected: { good: "good" },
	},
	{
		name: "hoisted-program-require-shadow",
		source: ['module.exports = require("./leaf.cjs");', "var require;"].join("\n"),
		files: { "leaf.cjs": 'exports.badLeaf = "excluded";\n' },
		expected: {},
	},
	{
		name: "program-Object-shadow",
		source: [
			"const Object = globalThis.Object;",
			'Object.defineProperty(exports, "badObject", { enumerable: true, value: "excluded" });',
			'exports.good = "good";',
		].join("\n"),
		expected: { good: "good" },
	},
	{
		name: "block-catch-for-switch-class-static-shadows",
		source: [
			'exports.good = "good";',
			"function decoys() {",
			"  { const exports = {}; exports.badBlock = true; }",
			"  try {} catch (module) { module.exports.badCatch = true; }",
			"  for (const module of []) { module.exports.badFor = true; }",
			'  switch (0) { case 0: { const Object = globalThis.Object; Object.defineProperty(exports, "badSwitch", {}); } }',
			'  const Named = class Object { method() { Object.defineProperty(exports, "badClass", {}); } };',
			'  class Static { static { const Object = globalThis.Object; Object.defineProperty(exports, "badStatic", {}); } }',
			"}",
		].join("\n"),
		expected: { good: "good" },
	},
];

describe("legacy Pi Babel AST behavior baseline", () => {
	test("rewrites exact source bytes with Babel binding semantics", async () => {
		for (const testCase of rewriteCases) {
			const actual = await __rewriteLegacyExtensionSourceForTests(testCase.source, rewriteImporter);
			expect(actual, testCase.name).toBe(testCase.expected(importTarget, requireTarget));
		}
	});

	test("keeps mixed import and require rewrites byte-identical after a cached analysis", async () => {
		const source = [
			'import value from "tracked-dep";',
			'export { value as named } from "tracked-dep";',
			'const required = require("tracked-dep");',
		].join("\n");
		const expected = [
			`import value from ${JSON.stringify(importTarget)};`,
			`export { value as named } from ${JSON.stringify(importTarget)};`,
			`const required = require(${JSON.stringify(requireTarget)});`,
		].join("\n");
		expect(await __rewriteLegacyExtensionSourceForTests(source, rewriteImporter)).toBe(expected);
		expect(await __rewriteLegacyExtensionSourceForTests(source, rewriteImporter)).toBe(expected);
	});

	test("uses a fresh analysis when extension source content changes", async () => {
		const original = 'import value from "tracked-dep";';
		const changed = 'const value = require("tracked-dep");';
		expect(await __rewriteLegacyExtensionSourceForTests(original, rewriteImporter)).toBe(
			`import value from ${JSON.stringify(importTarget)};`,
		);
		expect(await __rewriteLegacyExtensionSourceForTests(changed, rewriteImporter)).toBe(
			`const value = require(${JSON.stringify(requireTarget)});`,
		);
	});

	test("discovers exact CommonJS named exports with Babel binding semantics", async () => {
		for (const testCase of commonJsCases) {
			const actual = await loadCommonJsCase(testCase);
			expect(actual.keys, testCase.name).toEqual(["default", ...Object.keys(testCase.expected)].sort());
			expect(actual.named, testCase.name).toEqual(testCase.expected);
		}
	}, 30_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IMPORT_CONDITIONS, REQUIRE_CONDITIONS, resolveBareSpecifier } from "./node-modules-resolver";

/**
 * Fixture layout (a project `node_modules` tree, one nested scope) exercising the
 * resolver branches that the compiled-binary fallback depends on. See issue #10496.
 */
let root: string;
let projectDir: string;
let nestedDir: string;

function writePackage(nmDir: string, name: string, pkg: Record<string, unknown>, files: Record<string, string>): void {
	const pkgDir = path.join(nmDir, ...name.split("/"));
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg }));
	for (const rel in files) {
		const filePath = path.join(pkgDir, rel);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, files[rel]);
	}
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resolver-"));
	projectDir = path.join(root, "project");
	const projNm = path.join(projectDir, "node_modules");
	nestedDir = path.join(projNm, "outer");
	fs.mkdirSync(projNm, { recursive: true });

	// Dual condition + legacy fields: import/require must select different files.
	writePackage(
		projNm,
		"dual",
		{ main: "cjs.js", module: "esm.mjs", exports: { ".": { import: "./esm.mjs", require: "./cjs.js" } } },
		{
			"esm.mjs": "export default 'esm';",
			"cjs.js": "module.exports = 'cjs';",
		},
	);
	// Legacy fields only, no exports.
	writePackage(projNm, "legacy", { main: "lib/entry.js" }, { "lib/entry.js": "module.exports = 'legacy';" });
	// No entry fields at all: index.js fallback.
	writePackage(projNm, "indexonly", {}, { "index.js": "module.exports = 'index';" });
	// Extensionless legacy main backed by a TypeScript file (Bun resolves/loads it natively).
	writePackage(projNm, "tsentry", { main: "entry" }, { "entry.ts": "export default 42;" });
	// `bun` condition listed ahead of `node`: must win under both import and require, matching native Bun.
	writePackage(
		projNm,
		"runtimecond",
		{ exports: { ".": { bun: "./bun.js", node: "./node.js", default: "./default.js" } } },
		{
			"bun.js": "module.exports = 'bun';",
			"node.js": "module.exports = 'node';",
			"default.js": "module.exports = 'default';",
		},
	);
	// `bun` condition mapped to null: an explicit block. Must not fall through to default.
	writePackage(
		projNm,
		"excluded",
		{ exports: { ".": { bun: null, default: "./fallback.js" } } },
		{ "fallback.js": "module.exports = 'fallback';" },
	);
	// A non-null exports field encapsulates the package root, even when legacy main exists.
	writePackage(
		projNm,
		"subpathonly",
		{ main: "./main.js", exports: { "./feature": "./feature.js" } },
		{
			"main.js": "module.exports = 'legacy-main';",
			"feature.js": "module.exports = 'feature';",
		},
	);
	writePackage(
		projNm,
		"inactivecond",
		{ main: "./main.js", exports: { ".": { deno: "./deno.js" } } },
		{
			"main.js": "module.exports = 'legacy-main';",
			"deno.js": "module.exports = 'deno';",
		},
	);
	writePackage(
		projNm,
		"missingtarget",
		{ main: "./main.js", exports: { ".": "./missing.js" } },
		{ "main.js": "module.exports = 'legacy-main';" },
	);
	// Scoped package with subpath pattern exports.
	writePackage(
		projNm,
		"@scope/pkg",
		{ exports: { ".": "./main.js", "./feature/*": "./src/*.js" } },
		{
			"main.js": "module.exports = 'scoped-main';",
			"src/thing.js": "module.exports = 'scoped-feature';",
		},
	);
	// Overlapping wildcard patterns: the most-specific (longest-prefix) key must win.
	writePackage(
		projNm,
		"overlap",
		{ exports: { "./*": "./general/*.js", "./feature/*": "./specific/*.js" } },
		{
			"general/other.js": "module.exports = 'general';",
			"specific/x.js": "module.exports = 'specific';",
		},
	);
	// Package resolvable only by walking up: installed in a nested dependency's node_modules.
	writePackage(
		path.join(nestedDir, "node_modules"),
		"shared",
		{ main: "index.js" },
		{ "index.js": "module.exports = 'shared';" },
	);
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveBareSpecifier", () => {
	test("selects the export target matching the active condition", () => {
		expect(resolveBareSpecifier("dual", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "dual", "esm.mjs"),
		);
		expect(resolveBareSpecifier("dual", projectDir, REQUIRE_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "dual", "cjs.js"),
		);
	});

	test("falls back to legacy main and index when exports is absent", () => {
		expect(resolveBareSpecifier("legacy", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "legacy", "lib", "entry.js"),
		);
		expect(resolveBareSpecifier("indexonly", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "indexonly", "index.js"),
		);
	});

	test("probes TypeScript extensions for an extensionless main", () => {
		expect(resolveBareSpecifier("tsentry", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "tsentry", "entry.ts"),
		);
	});

	test("activates the bun export condition over node", () => {
		const bunTarget = path.join(projectDir, "node_modules", "runtimecond", "bun.js");
		expect(resolveBareSpecifier("runtimecond", projectDir, IMPORT_CONDITIONS)).toBe(bunTarget);
		expect(resolveBareSpecifier("runtimecond", projectDir, REQUIRE_CONDITIONS)).toBe(bunTarget);
	});

	test("treats an explicit null export condition as excluded", () => {
		// `bun` is active and maps to null -> hard block; must NOT fall through to default.
		expect(resolveBareSpecifier("excluded", projectDir, IMPORT_CONDITIONS)).toBeNull();
		// When `bun` is not an active condition, the null key is skipped and default wins.
		expect(resolveBareSpecifier("excluded", projectDir, ["node", "import", "default"])).toBe(
			path.join(projectDir, "node_modules", "excluded", "fallback.js"),
		);
	});

	test("does not bypass a non-null exports boundary with legacy root fallbacks", () => {
		expect(resolveBareSpecifier("subpathonly", projectDir, IMPORT_CONDITIONS)).toBeNull();
		expect(resolveBareSpecifier("inactivecond", projectDir, IMPORT_CONDITIONS)).toBeNull();
		expect(resolveBareSpecifier("missingtarget", projectDir, IMPORT_CONDITIONS)).toBeNull();
	});

	test("resolves scoped root and subpath-pattern exports", () => {
		expect(resolveBareSpecifier("@scope/pkg", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "@scope", "pkg", "main.js"),
		);
		expect(resolveBareSpecifier("@scope/pkg/feature/thing", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "@scope", "pkg", "src", "thing.js"),
		);
	});

	test("selects the most-specific overlapping wildcard pattern", () => {
		// `./feature/*` (longer prefix) must beat `./*` for `overlap/feature/x`.
		expect(resolveBareSpecifier("overlap/feature/x", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "overlap", "specific", "x.js"),
		);
		// A subpath only the broad `./*` matches still resolves through it.
		expect(resolveBareSpecifier("overlap/other", projectDir, IMPORT_CONDITIONS)).toBe(
			path.join(projectDir, "node_modules", "overlap", "general", "other.js"),
		);
	});

	test("preserves a query/fragment suffix on the resolved path", () => {
		// `?raw` is stripped for subpath matching, then re-appended to the resolved file.
		expect(resolveBareSpecifier("@scope/pkg/feature/thing?raw", projectDir, IMPORT_CONDITIONS)).toBe(
			`${path.join(projectDir, "node_modules", "@scope", "pkg", "src", "thing.js")}?raw`,
		);
		expect(resolveBareSpecifier("dual?v=1", projectDir, IMPORT_CONDITIONS)).toBe(
			`${path.join(projectDir, "node_modules", "dual", "esm.mjs")}?v=1`,
		);
	});

	test("walks the node_modules chain upward from the base directory", () => {
		// `shared` lives only in outer/node_modules; resolving from outer's own dir finds it.
		expect(resolveBareSpecifier("shared", nestedDir, IMPORT_CONDITIONS)).toBe(
			path.join(nestedDir, "node_modules", "shared", "index.js"),
		);
	});

	test("returns null for unresolvable specifiers", () => {
		expect(resolveBareSpecifier("does-not-exist", projectDir, IMPORT_CONDITIONS)).toBeNull();
		// exports omits this subpath -> no resolution, no legacy leak for non-root subpaths.
		expect(resolveBareSpecifier("@scope/pkg/nope", projectDir, IMPORT_CONDITIONS)).toBeNull();
	});
});

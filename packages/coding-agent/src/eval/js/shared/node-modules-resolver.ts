import * as fs from "node:fs";
import * as path from "node:path";

/**
 * On-disk `node_modules` resolver for eval JS bare specifiers.
 *
 * `bun build --compile` roots module resolution at the embedded `$bunfs`, so
 * `Bun.resolveSync`, `createRequire`, and bare `import()` never consult the real
 * project `node_modules` even when the kernel cwd is correct (issue #10496). This
 * walks the on-disk `node_modules` chain from a base directory and resolves a bare
 * specifier to an absolute file path, which the compiled runtime *can* load. It is
 * only used as a fallback when Bun's own resolver fails.
 */

// Bun resolves and loads TypeScript/JSX entries at runtime (even in a compiled
// binary), so the fallback must probe them too — e.g. a dep with `"main": "entry"`
// backed by `entry.ts`. Ordered JS-family first, then TS/JSX, then data/native.

/** File extensions probed when a specifier or exports target has none. */
const FILE_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".json", ".node"];

/** Directory index filenames probed when a target resolves to a directory. */
const INDEX_FILES = [
	"index.js",
	"index.mjs",
	"index.cjs",
	"index.jsx",
	"index.ts",
	"index.tsx",
	"index.mts",
	"index.cts",
	"index.json",
];

// Condition sets mirror `extensibility/plugins/legacy-pi-compat.ts`
// (`SUPPORTED_PACKAGE_{IMPORT,REQUIRE}_CONDITIONS`): Bun activates the `bun`
// condition ahead of `node`, and the non-standard `module` condition is not a
// runtime condition (declaration order in `exports` still decides ties).

/** Condition preference for `import()`-shaped resolution. */
export const IMPORT_CONDITIONS = ["bun", "node", "import", "default"];

/** Condition preference for `require()`-shaped resolution. */
export const REQUIRE_CONDITIONS = ["bun", "node", "require", "default"];

interface PackageJson {
	main?: unknown;
	module?: unknown;
	exports?: unknown;
}

/**
 * Resolve a bare specifier against on-disk `node_modules` starting from `baseDir`,
 * honoring `exports` (conditions + subpath patterns) and `main`/`module`/index
 * fallbacks. Returns an absolute file path, or `null` when nothing resolves.
 *
 * @param specifier bare package specifier, e.g. `xlsx`, `@scope/pkg`, `pkg/sub`.
 * @param baseDir directory the resolution walks up from.
 * @param conditions ordered export-condition preference (see {@link IMPORT_CONDITIONS}).
 */
export function resolveBareSpecifier(specifier: string, baseDir: string, conditions: string[]): string | null {
	// A trailing `?query`/`#fragment` (e.g. `pkg/feature?raw`) is not part of the
	// package subpath: strip it for resolution and re-append it to the resolved path,
	// matching how `Bun.resolveSync` retains the suffix on the resolved module URL.
	const cut = specifier.search(/[?#]/);
	const bare = cut === -1 ? specifier : specifier.slice(0, cut);
	const suffix = cut === -1 ? "" : specifier.slice(cut);
	const resolved = resolveBarePath(bare, baseDir, conditions);
	return resolved === null ? null : resolved + suffix;
}

/** Resolve the query-free bare specifier to an absolute file path (see {@link resolveBareSpecifier}). */
function resolveBarePath(specifier: string, baseDir: string, conditions: string[]): string | null {
	const { name, subpath } = splitSpecifier(specifier);
	if (!name) return null;
	const pkgDir = findPackageDir(name, baseDir);
	if (!pkgDir) return null;
	const pkg = readJson(path.join(pkgDir, "package.json"));

	if (pkg && pkg.exports != null) {
		const target = resolveExports(pkg.exports, subpath, conditions);
		if (typeof target !== "string" || (!target.startsWith("./") && !target.startsWith("../"))) return null;
		// A non-null `exports` field encapsulates the package. An unmatched target
		// or a target whose file is missing must not fall through to `main`/index.
		return finalizeFile(path.resolve(pkgDir, target));
	}

	if (subpath === ".") {
		for (const field of mainFields(pkg, conditions)) {
			const resolved = finalizeFile(path.resolve(pkgDir, field));
			if (resolved) return resolved;
		}
		return finalizeDir(pkgDir);
	}

	const abs = path.resolve(pkgDir, subpath);
	return finalizeFile(abs) ?? finalizeDir(abs);
}

/** Split `@scope/pkg/sub` or `pkg/sub` into package name and `.`-rooted subpath. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
	const parts = specifier.split("/");
	let name: string;
	let rest: string[];
	if (specifier.startsWith("@")) {
		name = parts.slice(0, 2).join("/");
		rest = parts.slice(2);
	} else {
		name = parts[0] ?? "";
		rest = parts.slice(1);
	}
	return { name, subpath: rest.length > 0 ? `./${rest.join("/")}` : "." };
}

/** Walk up from `baseDir` looking for `<dir>/node_modules/<name>`. */
function findPackageDir(name: string, baseDir: string): string | null {
	let dir = path.resolve(baseDir);
	for (;;) {
		if (path.basename(dir) !== "node_modules") {
			const candidate = path.join(dir, "node_modules", name);
			if (isDir(candidate)) return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Ordered legacy entry candidates for the package root. */
function mainFields(pkg: PackageJson | null, conditions: string[]): string[] {
	if (!pkg) return [];
	const main = typeof pkg.main === "string" ? pkg.main : null;
	const module = typeof pkg.module === "string" ? pkg.module : null;
	const preferModule = conditions.includes("import");
	const ordered = preferModule ? [module, main] : [main, module];
	return ordered.filter((value): value is string => value !== null);
}

/**
 * A resolved `exports` target: a relative target string, the {@link EXCLUDED}
 * sentinel when an active condition maps to `null`, or `null` when nothing matched.
 */
type ExportTarget = string | typeof EXCLUDED | null;

/**
 * Sentinel for an explicitly excluded export (`"exports": { "bun": null }`). Node/Bun
 * treat a `null` target as a hard block: resolution stops and does NOT fall through to
 * `default`, a sibling condition, or the legacy `main`/index fields.
 */
const EXCLUDED: unique symbol = Symbol("excluded-export");

/**
 * Resolve an `exports` value for `subpath` under `conditions`. Handles string
 * targets, condition maps, subpath maps, and `*` patterns per the Node exports spec.
 */
function resolveExports(exports: unknown, subpath: string, conditions: string[]): ExportTarget {
	if (typeof exports === "string") return subpath === "." ? exports : null;
	if (exports === null) return subpath === "." ? EXCLUDED : null;
	if (Array.isArray(exports)) {
		for (const entry of exports) {
			const resolved = resolveExports(entry, subpath, conditions);
			if (resolved !== null) return resolved;
		}
		return null;
	}
	if (typeof exports !== "object") return null;

	const record = exports as Record<string, unknown>;
	let isSubpathMap = false;
	for (const key in record) {
		if (key === "." || key.startsWith("./")) {
			isSubpathMap = true;
			break;
		}
	}
	if (!isSubpathMap) {
		// Bare condition map applies only to the package root.
		return subpath === "." ? resolveConditional(record, conditions) : null;
	}

	if (subpath in record) return resolveConditional(record[subpath], conditions);
	// Node/Bun select the most-specific `*` pattern: longest literal prefix, then
	// longest key — not the first declared. Rank all matches before resolving.
	let best: { prefixLength: number; keyLength: number; captured: string; value: unknown } | null = null;
	for (const key in record) {
		const star = key.indexOf("*");
		if (star === -1) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		if (subpath.length < prefix.length + suffix.length) continue;
		const better =
			!best ||
			prefix.length > best.prefixLength ||
			(prefix.length === best.prefixLength && key.length > best.keyLength);
		if (!better) continue;
		best = {
			prefixLength: prefix.length,
			keyLength: key.length,
			captured: subpath.slice(prefix.length, subpath.length - suffix.length),
			value: record[key],
		};
	}
	if (best) {
		const target = resolveConditional(best.value, conditions);
		return typeof target === "string" ? target.replace(/\*/g, best.captured) : target;
	}
	return null;
}

/**
 * Collapse a conditional export value to a target. Object keys are evaluated in
 * declaration order — the first key active in `conditions` (or `default`) wins,
 * matching Node's condition-resolution semantics. A matched condition whose target is
 * `null` yields {@link EXCLUDED} and stops the search.
 */
function resolveConditional(value: unknown, conditions: string[]): ExportTarget {
	if (value === null) return EXCLUDED;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const entry of value) {
			const resolved = resolveConditional(entry, conditions);
			if (resolved !== null) return resolved;
		}
		return null;
	}
	if (typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key in record) {
		if (key !== "default" && !conditions.includes(key)) continue;
		const resolved = resolveConditional(record[key], conditions);
		if (resolved !== null) return resolved;
	}
	return null;
}

/** Resolve `candidate` to an existing file, probing extensions when it has none. */
function finalizeFile(candidate: string): string | null {
	if (isFile(candidate)) return candidate;
	if (path.extname(candidate) === "") {
		for (const ext of FILE_EXTENSIONS) {
			if (isFile(candidate + ext)) return candidate + ext;
		}
	}
	return null;
}

/** Resolve a directory to its package `main` or an index file. */
function finalizeDir(dir: string): string | null {
	if (!isDir(dir)) return null;
	const pkg = readJson(path.join(dir, "package.json"));
	if (pkg && typeof pkg.main === "string") {
		const resolved = finalizeFile(path.resolve(dir, pkg.main));
		if (resolved) return resolved;
	}
	for (const index of INDEX_FILES) {
		const candidate = path.join(dir, index);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

function readJson(file: string): PackageJson | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
	} catch {
		return null;
	}
}

function isDir(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isFile(target: string): boolean {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

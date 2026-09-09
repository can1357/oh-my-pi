#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
/**
 * Codemod: rewrite relative test imports that reach into a package's `src/`
 * into the package's public subpath import.
 *
 *   ../src/format                  ->  @oh-my-pi/pi-utils/format
 *   ../../src/task/repair-args     ->  @oh-my-pi/pi-coding-agent/task/repair-args
 *   ../src/index                   ->  @oh-my-pi/pi-utils
 *
 * Only specifiers that resolve onto a file under `<pkg>/src/` are touched, and
 * only when they have no extension or a `.ts`/`.js` extension (the package
 * `exports` map `./*` -> `./src/*.ts`, so asset imports like `.json`/`.md`
 * have no public subpath and are left alone).
 *
 * Usage:
 *   bun scripts/fix-test-imports.ts          # dry run, prints a diff summary
 *   bun scripts/fix-test-imports.ts --write  # apply the changes
 */
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const WRITE = process.argv.includes("--write");

// Matches the module specifier of `from "x"`, `import "x"`, `import("x")`,
// `require("x")` / `export ... from "x"` — but only when it starts with `./`/`../`.
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])((?:\.\.?\/)[^"']*)\2/g;

// Source-module extensions. A specifier resolving to one of these has a public
// `./*` -> `./src/*.ts` subpath; anything else (.json/.md/...) is an asset.
const MODULE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Walk up from `dir` to the nearest package.json; return its dir + name. */
const pkgCache = new Map<string, { root: string; name: string } | null>();
function findPackage(startDir: string): { root: string; name: string } | null {
	let dir = startDir;
	const visited: string[] = [];
	while (dir.startsWith(ROOT) && dir.length >= ROOT.length) {
		if (pkgCache.has(dir)) {
			const cached = pkgCache.get(dir)!;
			for (const v of visited) pkgCache.set(v, cached);
			return cached;
		}
		visited.push(dir);
		const pj = join(dir, "package.json");
		if (existsSync(pj)) {
			let result: { root: string; name: string } | null = null;
			try {
				const name = JSON.parse(readFileSync(pj, "utf8")).name;
				if (typeof name === "string" && name) result = { root: dir, name };
			} catch {
				/* ignore unparseable package.json */
			}
			if (result) {
				for (const v of visited) pkgCache.set(v, result);
				return result;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const v of visited) pkgCache.set(v, null);
	return null;
}

const isFile = (p: string): boolean => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/**
 * Resolve a relative specifier to the actual file on disk it loads, mirroring
 * bundler resolution: try the literal path, the TS-extensions a `.js`-style
 * specifier really points at, appended source extensions, then a directory
 * `index`. Returns the resolved file path (whose real extension drives the
 * asset-vs-module decision) or null if nothing matches.
 */
function resolveTarget(fromFile: string, spec: string): string | null {
	const abs = resolve(dirname(fromFile), spec);
	const candidates: string[] = [abs];
	const jsExt = abs.match(/\.(js|jsx|mjs|cjs)$/i);
	if (jsExt) {
		const stem = abs.slice(0, -jsExt[0].length);
		candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
	}
	for (const e of MODULE_EXTS) candidates.push(`${abs}${e}`);
	for (const e of MODULE_EXTS) candidates.push(join(abs, `index${e}`));
	for (const c of candidates) if (isFile(c)) return c;
	return null;
}

interface Change {
	from: string;
	to: string;
}

function rewriteFile(file: string): { content: string; changes: Change[]; skipped: string[] } {
	const src = readFileSync(file, "utf8");
	const changes: Change[] = [];
	const skipped: string[] = [];

	const content = src.replace(SPEC_RE, (full, lead, quote, spec) => {
		// Only relative specifiers reach here; figure out the real file they load.
		const target = resolveTarget(file, spec);
		if (!target) return full; // unresolved (or a directory without index) — leave it
		const pkg = findPackage(target);
		if (!pkg) return full;

		const srcDir = join(pkg.root, "src");
		if (!target.startsWith(srcDir + sep)) return full; // not under this package's src/

		// Asset import (.json/.md/...) into src — no public subpath, leave & report.
		const realExt = extname(target).toLowerCase();
		if (!MODULE_EXTS.includes(realExt)) {
			skipped.push(spec);
			return full;
		}

		// Subpath relative to src, sans the real module extension, POSIX slashes.
		let sub = relative(srcDir, target).split(sep).join("/").slice(0, -realExt.length);
		sub = sub.replace(/\/index$/i, ""); // foo/index.ts -> foo
		if (sub === "index") sub = ""; // src/index.ts -> bare package name

		const newSpec = sub ? `${pkg.name}/${sub}` : pkg.name;
		if (newSpec === spec) return full;
		changes.push({ from: spec, to: newSpec });
		return `${lead}${quote}${newSpec}${quote}`;
	});

	return { content, changes, skipped };
}

// Collect every .ts/.tsx file living under a package `test/` or `tests/` dir.
const files = new Set<string>();
for (const pattern of ["packages/*/test/**/*.{ts,tsx}", "packages/*/tests/**/*.{ts,tsx}"]) {
	for (const f of new Glob(pattern).scanSync({ cwd: ROOT, absolute: true })) files.add(f);
}

let totalChanges = 0;
let changedFiles = 0;
const skippedAssets: string[] = [];

for (const file of [...files].sort()) {
	const { content, changes, skipped } = rewriteFile(file);
	if (skipped.length) skippedAssets.push(...skipped.map(s => `${relative(ROOT, file)}: ${s}`));
	if (!changes.length) continue;
	changedFiles++;
	totalChanges += changes.length;
	const rel = relative(ROOT, file);
	console.log(`\n${rel}`);
	for (const c of changes) console.log(`  ${c.from}  ->  ${c.to}`);
	if (WRITE) writeFileSync(file, content);
}

console.log(`\n${WRITE ? "Applied" : "Would apply"} ${totalChanges} rewrite(s) across ${changedFiles} file(s).`);
if (skippedAssets.length) {
	console.log(`\nSkipped ${skippedAssets.length} asset import(s) into src (no public subpath):`);
	for (const s of skippedAssets) console.log(`  ${s}`);
}
if (!WRITE && totalChanges) console.log(`\nRe-run with --write to apply.`);

#!/usr/bin/env bun
/**
 * Rewrite extensionless relative specifiers in emitted `.d.ts`/`.js` files to
 * explicit `.js` extensions so published output resolves under Node ESM and
 * `moduleResolution: "node16" | "nodenext"`.
 *
 * The workspace type-checks under `moduleResolution: "Bundler"`
 * (`tsconfig.base.json`), which permits extensionless relative imports. `tsgo`
 * therefore emits `export * from "./sdk"` / `import … from "./modes/components"`
 * into `dist/types` (declarations) and `dist/js` (transpiled runtime). A
 * downstream consumer on `nodenext` then can't resolve the barrel — every
 * relative re-export is a `TS2834`, which cascades into `TS2305` "no exported
 * member" on the whole package root — and Node refuses the extensionless
 * import outright at runtime.
 *
 * This post-emit pass appends the correct extension to each **relative**
 * specifier, resolving it against the emitted tree:
 *   `./sdk`              → `./sdk.js`               (sibling `sdk.d.ts` / `sdk.js`)
 *   `./modes/components` → `./modes/components/index.js`  (directory barrel)
 * Bare (`@scope/pkg`, `zod/v4`) and already-suffixed (`.js`, `.json`)
 * specifiers are left untouched.
 *
 * Applied by `ci-release-publish.ts` after each `tsgo -p tsconfig.publish*.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Matches relative module specifiers in generated declaration import/export forms:
//   from "…", import "…", import("…"), and declare module "…".
// Captures the quote-enclosed module string; we filter to relative ones below.
const SPECIFIER_RE = /(\b(?:from|import|module)\b\s*(?:\(\s*)?)("|')(\.[^"']*)(\2)/g;

/** Emitted-file kind: declaration or transpiled-runtime output. */
export type EmitExt = ".d.ts" | ".js";

/** Resolve an extensionless relative specifier to its `.js` runtime form,
 *  given the directory of the importing emitted file and the extension the
 *  emitted tree uses (`.d.ts` for declarations, `.js` for runtime output).
 *  Returns null to leave as-is. */
export async function resolveEmitSpecifier(fromDir: string, spec: string, ext: EmitExt): Promise<string | null> {
	// Already has a JS/JSON extension, or a declaration extension we map to .js.
	if (/\.(js|json|mjs|cjs)$/.test(spec)) return null;
	if (spec.endsWith(".d.ts")) return `${spec.slice(0, -".d.ts".length)}.js`;

	const abs = path.join(fromDir, spec);
	// Sibling emitted file: `./sdk` → `./sdk.js`.
	if (await exists(`${abs}${ext}`)) return `${spec}.js`;
	// Directory barrel: `./modes/components` → `./modes/components/index.js`.
	if (await exists(path.join(abs, `index${ext}`))) return `${spec.replace(/\/$/, "")}/index.js`;
	// Unresolved (e.g. an asset or a specifier with no emitted file): leave it.
	return null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Rewrite one emitted file in place. Returns the number of specifiers changed. */
export async function fixEmitFile(filePath: string, ext: EmitExt): Promise<number> {
	const source = await Bun.file(filePath).text();
	const fromDir = path.dirname(filePath);
	let changed = 0;

	// Collect async resolutions first (regex replace can't await), then apply.
	const edits: Array<{ match: string; replacement: string }> = [];
	for (const m of source.matchAll(SPECIFIER_RE)) {
		const [full, prefix, quote, spec] = m;
		const resolved = await resolveEmitSpecifier(fromDir, spec, ext);
		if (resolved && resolved !== spec) {
			edits.push({ match: full, replacement: `${prefix}${quote}${resolved}${quote}` });
		}
	}
	if (edits.length === 0) return 0;

	let out = source;
	for (const { match, replacement } of edits) {
		out = out.replace(match, replacement);
		changed++;
	}
	await Bun.write(filePath, out);
	return changed;
}

/** Walk `dir` recursively and fix every emitted file with extension `ext`. Returns totals. */
export async function fixEmitExtensions(dir: string, ext: EmitExt): Promise<{ files: number; specifiers: number }> {
	let files = 0;
	let specifiers = 0;
	const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const n = await fixEmitFile(filePath, ext);
		if (n > 0) {
			files++;
			specifiers += n;
		}
	}
	return { files, specifiers };
}

if (import.meta.main) {
	const target = process.argv[2];
	const ext = (process.argv[3] ?? ".d.ts") as EmitExt;
	if (!target || (ext !== ".d.ts" && ext !== ".js")) {
		console.error("usage: fix-emit-extensions.ts <emitted dir> [.d.ts|.js]");
		process.exit(1);
	}
	const { files, specifiers } = await fixEmitExtensions(target, ext);
	console.log(`fix-emit-extensions: rewrote ${specifiers} specifiers across ${files} files in ${target}`);
}

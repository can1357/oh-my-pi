#!/usr/bin/env bun

/**
 * Generate the bundled-pi registry + key set served by the compiled binary's
 * `omp-legacy-pi-bundled:` virtual namespace.
 *
 * Compiled-mode extension validation routes every `@(scope)/pi-*` import
 * through this registry — bunfs filesystem APIs are unreachable on Bun 1.3.14+
 * (issue #3423), so the binary serves bundled module surfaces from JS-heap
 * references captured at build time. Bare package roots and every
 * `non-wildcard` subpath export declared in each bundled pi-* package.json
 * become a registry entry; wildcard subpath patterns are intentionally
 * unbundled — those resolve from the extension's own peer deps as before.
 *
 * The generator emits two files:
 *   - `legacy-pi-bundled-registry.ts` (heavy): static imports of every
 *     subpath module + the `BUNDLED_PI_REGISTRY` map. Dynamically loaded by
 *     `legacy-pi-compat.ts` so dev/test runs never pay the cascade.
 *   - `legacy-pi-bundled-keys.ts` (light): just the canonical-key set.
 *     Statically imported by `legacy-pi-compat.ts` to seed
 *     `LEGACY_PI_PACKAGE_ROOT_OVERRIDES` without touching the heavy graph.
 *
 * Run via `bun scripts/generate-legacy-pi-bundled-registry.ts --generate`
 * (also invoked from `scripts/build-binary.ts` before `bun build --compile`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const registryOutPath = path.join(packageDir, "src/extensibility/plugins/legacy-pi-bundled-registry.ts");
const keysOutPath = path.join(packageDir, "src/extensibility/plugins/legacy-pi-bundled-keys.ts");

const GENERATE_FLAG = "--generate";
const CHECK_FLAG = "--check";

interface BundledPackage {
	readonly dir: string;
	readonly name: string;
	/** Identifier prefix for generated namespace imports (`PiAi`, `PiCodingAgent`, …). */
	readonly identifier: string;
	/** Root import — the shim path for surfaces that wrap the bundled namespace, `null` otherwise. */
	readonly rootShim: string | null;
}

const PACKAGES: readonly BundledPackage[] = [
	{ dir: "packages/agent", name: "@pk-nerdsaver-ai/pi-agent-core", identifier: "PiAgentCore", rootShim: null },
	{
		dir: "packages/ai",
		name: "@pk-nerdsaver-ai/pi-ai",
		identifier: "PiAi",
		// pi-ai 15.1.0 dropped the runtime `Type` builder from the package root;
		// the shim re-attaches it for extensions that still import `Type` from
		// `@(scope)/pi-ai`. Subpaths bypass the shim — they're untouched by the
		// schema-runtime split.
		rootShim: "../legacy-pi-ai-shim",
	},
	{
		dir: "packages/coding-agent",
		name: "@pk-nerdsaver-ai/pi-coding-agent",
		identifier: "PiCodingAgent",
		// pi-coding-agent root carries legacy helpers (`defineTool`,
		// `createCodingTools`, …) the canonical entry never exposed; the shim
		// re-exports the canonical surface plus those helpers.
		rootShim: "../legacy-pi-coding-agent-shim",
	},
	{ dir: "packages/natives", name: "@pk-nerdsaver-ai/pi-natives", identifier: "PiNatives", rootShim: null },
	{ dir: "packages/tui", name: "@pk-nerdsaver-ai/pi-tui", identifier: "PiTui", rootShim: null },
	{ dir: "packages/utils", name: "@pk-nerdsaver-ai/pi-utils", identifier: "PiUtils", rootShim: null },
];

// `typebox` is published under an upstream alias; legacy extensions import the
// bare name expecting the host-provided Zod-backed shim. Tracked alongside the
// pi-* surfaces so the override map and synthesizer cover it uniformly.
const TYPEBOX_REGISTRY_KEY = "typebox";
const TYPEBOX_SHIM_IMPORT = "../typebox";

interface RegistryEntry {
	/** Canonical registry key, e.g. `@pk-nerdsaver-ai/pi-ai/oauth`. */
	readonly key: string;
	/** Identifier bound in the generated module's static import. */
	readonly binding: string;
	/**
	 * ES module specifier the generated file imports. For bundled subpaths this
	 * is the canonical `@pk-nerdsaver-ai/<pkg>/<subpath>` string Bun resolves via the
	 * package's exports field; for shimmed surfaces (root of pi-ai / pi-coding-agent
	 * / typebox) it's the relative path to the in-tree shim.
	 */
	readonly importSpecifier: string;
}

function bindingForSubpath(identifier: string, subpath: string): string {
	const segments = subpath
		.split("/")
		.filter(Boolean)
		.map(segment =>
			segment
				.split(/[-_]/)
				.filter(Boolean)
				.map(part => part.charAt(0).toUpperCase() + part.slice(1))
				.join(""),
		);
	return `bundled${identifier}${segments.join("")}`;
}

// Skip files whose presence on disk is meaningful to the build pipeline rather
// than something a plugin would import: editor backups (`_*`, `.*`), tests,
// declaration files, and conventional `index` files (already covered by the
// non-wildcard root of the same directory when one is declared).
const SKIPPED_WILDCARD_BASENAMES = new Set(["index"]);

function isSafeWildcardBasename(basename: string): boolean {
	if (!basename || basename.startsWith(".") || basename.startsWith("_")) return false;
	if (SKIPPED_WILDCARD_BASENAMES.has(basename)) return false;
	if (/\.(test|spec|d|generated|bench)$/.test(basename)) return false;
	return true;
}

// Worker entry modules intentionally throw when imported outside a Worker. The
// bundled registry loads on the main thread during legacy extension validation,
// so these exported subpaths must stay out of the static registry.
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES = new Set(["worker-entry"]);

function isMainThreadSafeWildcardBasename(basename: string): boolean {
	return !MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES.has(basename);
}

interface WildcardPattern {
	readonly exportPrefix: string;
	readonly exportSuffix: string;
	readonly sourcePrefix: string;
	readonly sourceSuffix: string;
}

/**
 * Parse a single-asterisk Node exports wildcard into its prefix/suffix halves.
 * Returns `null` for patterns with more than one asterisk or non-relative
 * sources — neither shows up in our packages today and the generator stays
 * conservative rather than guessing.
 */
function parseWildcardPattern(exportKey: string, sourcePattern: string): WildcardPattern | null {
	const exportStar = exportKey.indexOf("*");
	const sourceStar = sourcePattern.indexOf("*");
	if (exportStar === -1 || sourceStar === -1) return null;
	if (exportKey.indexOf("*", exportStar + 1) !== -1) return null;
	if (sourcePattern.indexOf("*", sourceStar + 1) !== -1) return null;
	if (!sourcePattern.startsWith("./")) return null;
	return {
		exportPrefix: exportKey.slice(2, exportStar),
		exportSuffix: exportKey.slice(exportStar + 1),
		sourcePrefix: sourcePattern.slice(2, sourceStar),
		sourceSuffix: sourcePattern.slice(sourceStar + 1),
	};
}

function exportImportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "import" in value) {
		const target = (value as { import?: unknown }).import;
		return typeof target === "string" ? target : null;
	}
	return null;
}

async function collectEntries(): Promise<RegistryEntry[]> {
	const entries: RegistryEntry[] = [];
	const seenKeys = new Set<string>();
	function pushEntry(key: string, binding: string, importSpecifier: string): void {
		if (seenKeys.has(key)) return;
		seenKeys.add(key);
		entries.push({ key, binding, importSpecifier });
	}

	for (const pkg of PACKAGES) {
		const manifestPath = path.join(repoRoot, pkg.dir, "package.json");
		const manifest = (await Bun.file(manifestPath).json()) as { name?: string; exports?: Record<string, unknown> };
		if (manifest.name !== pkg.name) {
			throw new Error(
				`generate-legacy-pi-bundled-registry: package.json at ${manifestPath} declares "${manifest.name}", expected "${pkg.name}"`,
			);
		}
		const exportsField = manifest.exports ?? {};
		// Root: shim if one is declared, otherwise the canonical package.
		pushEntry(pkg.name, `bundled${pkg.identifier}`, pkg.rootShim ?? pkg.name);
		// Pass 1: every non-wildcard subpath export becomes its own registry key.
		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
			const subpath = exportKey.slice(2);
			pushEntry(`${pkg.name}/${subpath}`, bindingForSubpath(pkg.identifier, subpath), `${pkg.name}/${subpath}`);
		}
		// Pass 2: expand wildcard exports against the source tree so plugins can
		// import concrete subpath targets — e.g. `@(scope)/pi-ai/oauth/anthropic`
		// remaps to `@pk-nerdsaver-ai/pi-ai/oauth/anthropic`, covered by pi-ai's
		// `./oauth/*` export pattern, which Node only resolves at runtime against
		// a real `node_modules`. Compiled bunfs can't resolve at runtime, so we
		// statically enumerate the concrete files now (issue #3442 follow-up).
		// Root catch-all patterns (`./*`, `./*.js`) are skipped intentionally:
		// the pi-coding-agent root is the binary entry's source tree, so static-
		// importing every top-level file would drag `cli.ts`/`main.ts` through a
		// second graph and explode the bundle for no plugin-facing benefit.
		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || !exportKey.includes("*")) continue;
			const sourcePattern = exportImportTarget(exportsField[exportKey]);
			if (!sourcePattern) continue;
			const pattern = parseWildcardPattern(exportKey, sourcePattern);
			if (!pattern) continue;
			// Limit to JS-loadable source modules. `./prompts/*` mapping to
			// `*.md` would emit a `import * as foo from "@(pkg)/prompts/<name>"`
			// that Bun can't load as a JS module.
			if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(pattern.sourceSuffix)) continue;
			// Skip root catch-alls (prefix is empty before the wildcard). See
			// the explanatory block comment above for the bundle-explosion
			// reasoning. Named wildcards like `./oauth/*` keep `oauth/` here.
			if (pattern.exportPrefix === "" || pattern.exportPrefix === "/") continue;

			const sourceDir = path.join(repoRoot, pkg.dir, pattern.sourcePrefix);
			try {
				const glob = new Bun.Glob(`*${pattern.sourceSuffix}`);
				const matches: string[] = [];
				for await (const match of glob.scan({ cwd: sourceDir, onlyFiles: true })) {
					matches.push(match);
				}
				matches.sort();
				for (const match of matches) {
					if (!match.endsWith(pattern.sourceSuffix)) continue;
					const basename = match.slice(0, match.length - pattern.sourceSuffix.length);
					if (!isSafeWildcardBasename(basename)) continue;
					if (!isMainThreadSafeWildcardBasename(basename)) continue;
					if (basename.includes("/")) continue;
					const subpath = `${pattern.exportPrefix}${basename}${pattern.exportSuffix}`;
					const key = `${pkg.name}/${subpath}`;
					pushEntry(key, bindingForSubpath(pkg.identifier, subpath), key);
				}
			} catch (err) {
				// Missing source dir means the wildcard is declared in
				// package.json but the implementation tree hasn't shipped that
				// folder yet. Leave it to runtime resolution.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
	}
	entries.push({
		key: TYPEBOX_REGISTRY_KEY,
		binding: "bundledTypeBoxShim",
		importSpecifier: TYPEBOX_SHIM_IMPORT,
	});
	const seenBindings = new Set<string>();
	for (const entry of entries) {
		if (seenBindings.has(entry.binding)) {
			throw new Error(
				`generate-legacy-pi-bundled-registry: duplicate binding ${entry.binding} for key ${entry.key}`,
			);
		}
		seenBindings.add(entry.binding);
	}
	return entries;
}

function renderRegistry(entries: readonly RegistryEntry[]): string {
	const importLines = entries.map(
		entry => `import * as ${entry.binding} from ${JSON.stringify(entry.importSpecifier)};`,
	);
	const registryLines = entries.map(
		entry => `\t${JSON.stringify(entry.key)}: ${entry.binding} as unknown as Readonly<Record<string, unknown>>,`,
	);
	return [
		"// AUTO-GENERATED by scripts/generate-legacy-pi-bundled-registry.ts.",
		"// Do not edit by hand — run `bun scripts/generate-legacy-pi-bundled-registry.ts --generate`.",
		"/**",
		" * Static handles on every bundled `@pk-nerdsaver-ai/pi-*` surface — package",
		" * roots plus every non-wildcard subpath export declared in each package's",
		" * `exports` field. Loaded lazily by `legacy-pi-compat.ts` in compiled-binary",
		" * mode (issue #3423) and re-exported through the `omp-legacy-pi-bundled:`",
		" * virtual namespace — bunfs paths cannot be resolved at runtime on Bun",
		" * 1.3.14+, so the only way to re-route extension imports onto the host's",
		" * in-process copy is via live module references captured at compile time.",
		" *",
		" * This module is split out from `legacy-pi-compat.ts` so dev/test runs that",
		" * touch the compat layer never trigger the cascade through",
		" * `legacy-pi-coding-agent-shim.ts → ../index → export/html/...` (which",
		" * requires generated artifacts that only exist after a `bun run build`).",
		" *",
		" * The bundler reaches every entry below via standard static-import analysis,",
		" * so no `--compile` extras are required in `scripts/build-binary.ts`.",
		" */",
		...importLines,
		"",
		"/**",
		" * Canonical specifier → live module namespace. Keys MUST match the right-hand",
		" * side of `bundledRegistryVirtualSpecifier(...)` calls in",
		" * `legacy-pi-compat.ts`; the synthesizer enumerates each namespace's own",
		" * enumerable exports at extension load time. The companion",
		" * `legacy-pi-bundled-keys.ts` mirrors `Object.keys(BUNDLED_PI_REGISTRY)` and",
		" * is statically imported by `legacy-pi-compat.ts` to seed the override map",
		" * without paying the cascade above.",
		" */",
		"export const BUNDLED_PI_REGISTRY: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {",
		...registryLines,
		"};",
		"",
	].join("\n");
}

function renderKeys(entries: readonly RegistryEntry[]): string {
	const keyLines = entries.map(entry => `\t${JSON.stringify(entry.key)},`);
	return [
		"// AUTO-GENERATED by scripts/generate-legacy-pi-bundled-registry.ts.",
		"// Do not edit by hand — run `bun scripts/generate-legacy-pi-bundled-registry.ts --generate`.",
		"/**",
		" * Canonical keys served by the `omp-legacy-pi-bundled:` virtual namespace.",
		" * Mirrors `Object.keys(BUNDLED_PI_REGISTRY)` from",
		" * `legacy-pi-bundled-keys.ts`'s sibling registry file. `legacy-pi-compat.ts`",
		" * statically imports this set to seed `LEGACY_PI_PACKAGE_ROOT_OVERRIDES` in",
		" * compiled-binary mode without dragging the heavy registry's transitive",
		" * graph into dev/test runs (the registry itself stays behind a dynamic",
		" * import — see `ensureBundledRegistryLoaded` in `legacy-pi-compat.ts`).",
		" */",
		"export const BUNDLED_PI_REGISTRY_KEYS: ReadonlySet<string> = new Set([",
		...keyLines,
		"]);",
		"",
	].join("\n");
}

async function formatInPlace(targets: readonly string[]): Promise<void> {
	// `biome check --write` runs the formatter AND the assist's organizeImports
	// pass; `biome format --write` alone leaves the import order untouched.
	const proc = Bun.spawn(["bunx", "biome", "check", "--write", ...targets], {
		cwd: packageDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const exit = await proc.exited;
	if (exit !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`biome check --write failed (exit ${exit}): ${stderr}`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const check = args.includes(CHECK_FLAG);
	if (!check && !args.includes(GENERATE_FLAG)) {
		console.log(
			`Skipping bundled-pi registry generation; pass ${GENERATE_FLAG} to write the output files (or ${CHECK_FLAG} to verify the committed copy).`,
		);
		return;
	}

	const entries = await collectEntries();
	const registrySource = renderRegistry(entries);
	const keysSource = renderKeys(entries);

	if (check) {
		// biome ignores paths outside its `includes` glob (the `*.ts.candidate`
		// suffix above would be rejected with "No files were processed"), so
		// write the candidates into a sibling `.<name>.tmp/` directory whose
		// basenames match the committed copies. The directory lives under the
		// same package so biome's repo-relative `includes` still cover it.
		const tmpDir = path.join(packageDir, "src/extensibility/plugins/.legacy-pi-bundled-candidates");
		const tmpRegistry = path.join(tmpDir, path.basename(registryOutPath));
		const tmpKeys = path.join(tmpDir, path.basename(keysOutPath));
		try {
			await Bun.write(tmpRegistry, registrySource);
			await Bun.write(tmpKeys, keysSource);
			await formatInPlace([tmpRegistry, tmpKeys]);
			const drift: string[] = [];
			const pairs: readonly (readonly [string, string])[] = [
				[registryOutPath, tmpRegistry],
				[keysOutPath, tmpKeys],
			];
			for (const [committedPath, candidatePath] of pairs) {
				let committed: string;
				try {
					committed = await Bun.file(committedPath).text();
				} catch {
					committed = "";
				}
				const candidate = await Bun.file(candidatePath).text();
				if (committed !== candidate) {
					drift.push(path.relative(repoRoot, committedPath));
				}
			}
			if (drift.length > 0) {
				console.error(
					`generate-legacy-pi-bundled-registry: stale output — rerun with ${GENERATE_FLAG}. Files out of sync:\n  ${drift.join("\n  ")}`,
				);
				process.exit(1);
			}
			console.log("generate-legacy-pi-bundled-registry: OK");
		} finally {
			// `fs.rm` recursively handles both files and the parent tmp dir; the
			// individual file deletes the previous draft used `Bun.file().delete()`
			// for would leave the empty directory behind.
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		}
		return;
	}

	await Bun.write(registryOutPath, registrySource);
	await Bun.write(keysOutPath, keysSource);
	// Hand-emitted formatting can't perfectly match biome's organizeImports +
	// long-line wrapping (lineWidth 120 + 60+ entries with long keys/bindings),
	// so let biome rewrite the files in place. The committed output then matches
	// what `bun check` enforces, and `--check` confirms zero drift on CI.
	await formatInPlace([registryOutPath, keysOutPath]);
	console.log(
		`Generated ${path.relative(repoRoot, registryOutPath)} and ${path.relative(repoRoot, keysOutPath)} (${entries.length} entries)`,
	);
}

await main();

import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import { isCompiledBinary } from "@pk-nerdsaver-ai/pi-utils";
import { BUNDLED_PI_REGISTRY_KEYS } from "./legacy-pi-bundled-keys";

const IS_COMPILED_BINARY = isCompiledBinary();

// === Bundled host-package registry (issue #3423) ===
//
// Bun 1.3.14 stopped exposing `--compile` extras through any filesystem-style
// API: `fs.existsSync`, `Bun.file().exists()`, `Bun.resolveSync`, and even
// `import("/$bunfs/...")` / `import("file:///$bunfs/...")` all fail for the
// embedded entries — only the main binary itself answers from
// `/$bunfs/root/<binary-name>`. The previous strategy of rewriting
// `@(scope)/pi-*` imports to a `file:///$bunfs/...` URL therefore breaks
// every legacy extension in compiled mode (issue #3423; see also issues
// #3329, #2168). Bun.plugin `onResolve` for bare specifiers also no longer
// fires for transitive imports inside runtime-loaded extensions, so the
// fallback hook in `installLegacyPiSpecifierShim()` cannot rescue them.
//
// Instead we keep a JS-heap reference to every bundled pi-* surface (the
// canonical host packages and the legacy shims) and re-export them through a
// Bun.plugin `onLoad` against a custom namespace. Extension source rewrites
// emit `omp-legacy-pi-bundled:<key>` specifiers that the synthetic loader
// resolves against the registry — no bunfs path ever leaves this module in
// compiled mode. Dev / source-link / installed-package modes keep the
// historical `file://` rewrite (the source files exist on disk and load fine
// through Bun's standard URL loader).
//
// The registry lives in a sibling file (`legacy-pi-bundled-registry.ts`)
// loaded via a conditional dynamic import: its transitive deps include the
// coding-agent root which pulls in generated artifacts (e.g.
// `export/html/tool-views.generated.js`) that only exist after a build, so a
// static import would crash every dev/test run that touches
// `legacy-pi-compat.ts`. This is the documented "conditional platform code"
// exception to the static-import rule.
const BUNDLED_VIRTUAL_SCHEME = "omp-legacy-pi-bundled:";
const BUNDLED_VIRTUAL_NAMESPACE = "omp-legacy-pi-bundled";
const BUNDLED_REGISTRY_GLOBAL = "__ompLegacyPiBundledRegistry";
const TYPEBOX_BUNDLED_REGISTRY_KEY = "typebox";

type BundledRegistry = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

let bundledRegistryPromise: Promise<BundledRegistry> | null = null;

/**
 * Lazy-load the bundled host-package registry and stash it on `globalThis`
 * for the synthetic loader emitted by `synthesizeBundledModuleSource`.
 *
 * `globalThis` is the bridge, not laziness: each synthesized
 * `omp-legacy-pi-bundled:<key>` module is a *separate* ES module Bun compiles
 * from a source string, so it cannot close over the registry in this file's
 * lexical scope and the live (non-serializable) function/object exports cannot
 * be inlined — the only runtime channel back to the host objects is a global.
 *
 * The dynamic import is gated by `IS_COMPILED_BINARY` so dev/test runs (where
 * the registry's transitive deps include build-time-generated artifacts)
 * never trigger the cascade.
 */
function ensureBundledRegistryLoaded(): Promise<BundledRegistry> {
	if (!IS_COMPILED_BINARY) {
		return Promise.reject(
			new Error("omp:legacy-pi-shim: bundled registry is only available in compiled-binary mode"),
		);
	}
	if (!bundledRegistryPromise) {
		bundledRegistryPromise = import("./legacy-pi-bundled-registry").then(m => {
			(globalThis as Record<string, unknown>)[BUNDLED_REGISTRY_GLOBAL] = m.BUNDLED_PI_REGISTRY;
			return m.BUNDLED_PI_REGISTRY;
		});
	}
	return bundledRegistryPromise;
}

function bundledRegistryVirtualSpecifier(registryKey: string): string {
	return `${BUNDLED_VIRTUAL_SCHEME}${registryKey}`;
}

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(BUNDLED_VIRTUAL_SCHEME);
}

/**
 * Build the synthetic ES module source for a `omp-legacy-pi-bundled:<key>`
 * import against an explicit registry. Pure: takes the live module namespace
 * and emits a string of ES exports rooted in `globalThis[BUNDLED_REGISTRY_GLOBAL]`.
 * `synthesizeBundledModuleSource` wraps this with the lazy registry load —
 * tests use this sync helper directly to assert export-shape preservation.
 */
function synthesizeBundledModuleSourceFromRegistry(registryKey: string, registry: BundledRegistry): string {
	const mod = registry[registryKey];
	if (!mod) {
		throw new Error(`omp:legacy-pi-shim: no bundled module registered for ${registryKey}`);
	}
	const lines: string[] = [
		`const __omp_bundled = globalThis[${JSON.stringify(BUNDLED_REGISTRY_GLOBAL)}][${JSON.stringify(registryKey)}];`,
	];
	let hasDefault = false;
	for (const exportName in mod) {
		if (exportName === "default") {
			hasDefault = true;
			continue;
		}
		lines.push(`export const ${exportName} = __omp_bundled[${JSON.stringify(exportName)}];`);
	}
	if (hasDefault) {
		lines.push("export default __omp_bundled.default;");
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Build the synthetic ES module source served for an
 * `omp-legacy-pi-bundled:<key>` import. Enumerates the live module namespace
 * so legacy extensions see the same named/default exports they would have
 * gotten from a real `file://` load — without touching the inaccessible bunfs
 * filesystem.
 */
async function synthesizeBundledModuleSource(registryKey: string): Promise<string> {
	const registry = await ensureBundledRegistryLoaded();
	return synthesizeBundledModuleSourceFromRegistry(registryKey, registry);
}

/**
 * Test seam: builds the synthetic ES module source for a virtual specifier
 * against an explicit registry. Pure (no globalThis read); the emitted source
 * still routes runtime lookups through `globalThis[BUNDLED_REGISTRY_GLOBAL]`.
 */
export function __synthesizeLegacyPiBundledSourceWithRegistry(
	registryKey: string,
	registry: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromRegistry(registryKey, registry);
}

/**
 * Test seam: returns the globalThis key the synthetic loader reads from. Tests
 * assert that the emitted source addresses the exact stash key the install
 * function writes to, so a rename can't break extension loads silently.
 */
export function __getLegacyPiBundledRegistryGlobal(): string {
	return BUNDLED_REGISTRY_GLOBAL;
}

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @pk-nerdsaver-ai scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@pk-nerdsaver-ai";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@pk-nerdsaver-ai` is intentionally included so direct
// canonical imports still pass through the same host-bundled package resolution
// path instead of pulling a duplicate copy from plugin node_modules.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Entries ending in `/` rewrite the whole subtree; add new
// `pkg/from -> pkg/to` pairs whenever an upstream-only subpath breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	["pi-ai/utils/oauth", "pi-ai/oauth"],
	["pi-ai/utils/oauth/", "pi-ai/oauth/"],
]);

function remapLegacyPiSubpath(rest: string): string {
	const exact = PI_SUBPATH_REMAPS.get(rest);
	if (exact) {
		return exact;
	}

	for (const [from, to] of PI_SUBPATH_REMAPS) {
		if (from.endsWith("/") && rest.startsWith(from)) {
			return `${to}${rest.slice(from.length)}`;
		}
	}

	return rest;
}

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s+|import\\s*\\(\\s*)["'])(@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const resolvedSpecifierFallbacks = new Map<string, string>();
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SUPPORTED_PACKAGE_IMPORT_CONDITIONS = new Set(["bun", "node", "import", "default"]);
const packageRootCache = new Map<string, string | null>();
const packageImportsCache = new Map<string, Record<string, unknown> | null>();
const PACKAGE_IMPORT_EXCLUDED = Symbol("packageImportExcluded");

// Extensions that imported TypeBox directly used to resolve against a real
// `@sinclair/typebox` or `typebox` install. The runtime dep was replaced with
// the Zod-backed shim under `extensibility/typebox.ts`; plugins still importing
// either public name are redirected to that shim so existing extensions keep
// working without code changes. Submodules like `@sinclair/typebox/compiler`
// are intentionally not remapped — those expose TypeBox-only APIs the shim does
// not provide and plugins relying on them must vendor TypeBox directly.
const TYPEBOX_SPECIFIER_FILTER = /^(?:@sinclair\/typebox|typebox)$/;

// Compat-shim path resolution. In compiled-binary mode every bundled surface
// is served through the `omp-legacy-pi-bundled:` virtual namespace (see the
// registry block above) — bunfs paths are unreachable on Bun 1.3.14+, so the
// pre-#3423 helpers that derived `/$bunfs/root/...` paths from
// `import.meta.dir` are gone. Dev / source-link / installed-package modes
// still need a real filesystem path for the source shims, which
// `sourceShimPath` computes either from the npm prebuilt `dist/cli.js`
// bundle (`PI_BUNDLED=true`) or directly from the monorepo source tree.

/**
 * Compute the package root for the npm prebuilt `dist/cli.js` bundle.
 *
 * `bundle-dist.ts` defines `process.env.PI_BUNDLED="true"`; after bundling,
 * `import.meta.dir` points at `<package>/dist`. Do not resolve the package via
 * bare `@pk-nerdsaver-ai/pi-coding-agent` here: from a global install Bun can pick an
 * older cache entry, recreating mixed-runtime plugin loading.
 */
export function __computeBundledSelfPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (pathImpl.basename(normalizedMetaDir) === "dist") {
		return pathImpl.resolve(metaDir, "..");
	}

	const pluginsDirSuffix = pathImpl.join("src", "extensibility", "plugins");
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..");
	}

	return pathImpl.resolve(metaDir);
}

function resolveBundledSelfPackageRoot(): string | undefined {
	if (!process.env.PI_BUNDLED) return undefined;
	return __computeBundledSelfPackageRoot(import.meta.dir);
}

const BUNDLED_SELF_PACKAGE_ROOT = resolveBundledSelfPackageRoot();

function sourceShimPath(file: string): string {
	return BUNDLED_SELF_PACKAGE_ROOT
		? path.join(BUNDLED_SELF_PACKAGE_ROOT, "src", "extensibility", file)
		: path.resolve(import.meta.dir, "..", file);
}

/**
 * Resolve the path the TypeBox compatibility shim ships at, then drop it when
 * the source file is missing.
 *
 * In compiled-binary mode the shim is served through the
 * `omp-legacy-pi-bundled:` virtual namespace (issue #3423) — bunfs paths are
 * unreachable on Bun 1.3.14+, so the virtual specifier is always available and
 * needs no filesystem probe. In dev / source-link / installed-package mode the
 * shim is an on-disk source file; validation mirrors
 * `__validateLegacyPiPackageRootOverrides` (#2168): if the computed candidate
 * doesn't exist (e.g. an install that dropped the source — issue #3414),
 * `resolveTypeBoxSpecifier` returns `undefined` and
 * `rewriteLegacyExtensionSource` leaves bare `typebox` / `@sinclair/typebox`
 * specifiers alone, so Bun falls through to native resolution against the
 * extension's own `node_modules`.
 *
 * Exported for tests; production callers use `TYPEBOX_SHIM_PATH`.
 */
export function __resolveTypeBoxShimPath(
	isCompiled: boolean,
	sourcePath: string,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): string | null {
	if (isCompiled) {
		return bundledRegistryVirtualSpecifier(TYPEBOX_BUNDLED_REGISTRY_KEY);
	}
	return pathExistsSync(sourcePath) ? sourcePath : null;
}

const TYPEBOX_SHIM_PATH = __resolveTypeBoxShimPath(IS_COMPILED_BINARY, sourceShimPath("typebox.ts"));

// Legacy extensions historically imported `Type` (and `Static`/`TSchema`) from
// the package root of `@(scope)/pi-ai`. pi-ai 15.1.0 removed the runtime `Type`
// export (see `packages/ai/CHANGELOG.md`), so the bare canonical specifier no
// longer satisfies those imports. The override below redirects only the bare
// pi-ai package root onto a sibling shim that re-exports the canonical surface
// plus the borrowed `Type` runtime from the Zod-backed TypeBox shim. Subpath
// imports such as `@pk-nerdsaver-ai/pi-ai/oauth` continue to resolve directly
// against the bundled pi-ai package.
const LEGACY_PI_AI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledRegistryVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-ai`)
	: sourceShimPath("legacy-pi-ai-shim.ts");

// The coding-agent's own `./src/index.ts` cannot be listed as an extra
// `bun --compile` entrypoint alongside the CLI entry without breaking binary
// startup (issue #1474 follow-up). In compiled-binary mode the legacy
// `@(scope)/pi-coding-agent` root therefore resolves through the bundled
// registry shim; in dev / source-link / installed-package mode it points at
// the sibling source shim whose distinct file path avoids the #1474 collision
// while still re-exporting the canonical package surface.
const LEGACY_PI_CODING_AGENT_SHIM_PATH = IS_COMPILED_BINARY
	? bundledRegistryVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-coding-agent`)
	: sourceShimPath("legacy-pi-coding-agent-shim.ts");

// Package-root overrides. Shim entries (`pi-ai`, `pi-coding-agent`) always
// replace the canonical surface so the legacy `Type` runtime and the legacy
// helpers stay reachable. The bundled host packages (`pi-agent-core`,
// `pi-natives`, `pi-tui`, `pi-utils`) are added only in compiled-binary mode
// to route extensions onto the in-process module instance — in dev /
// source-link / installed-package mode the canonical specifier resolves
// cleanly through `Bun.resolveSync` and hardcoding a source-tree path would
// miss installs where the bundled packages live at `node_modules/@pk-nerdsaver-ai/pi-*`.
//
// Compiled-binary entries are `omp-legacy-pi-bundled:<key>` specifiers handed
// to the synthetic onLoad in `installLegacyPiSpecifierShim()` — bunfs paths
// are unusable on Bun 1.3.14+ (issue #3423). Filesystem-shaped overrides are
// still validated against on-disk presence so a missing dev-mode shim falls
// through to `getResolvedSpecifier`.

/**
 * Drop overrides whose filesystem targets are missing so they can fall
 * through to the canonical-resolution path. Virtual `omp-legacy-pi-bundled:`
 * entries always pass — the bundled registry is the source of truth in
 * compiled-binary mode where bunfs paths are unreachable (issue #3423).
 *
 * `pathExistsSync` defaults to `fs.existsSync`; tests inject a stub to
 * simulate the missing-entrypoint failure mode without touching the real FS.
 */
export function __validateLegacyPiPackageRootOverrides(
	candidates: Record<string, string>,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(candidates).filter(
			([, candidate]) => isBundledVirtualSpecifier(candidate) || pathExistsSync(candidate),
		),
	);
}

/**
 * Compute the override map keyed by every canonical specifier the host serves
 * directly: the pi-ai / pi-coding-agent roots (compat shims that re-attach
 * legacy helpers) plus, in compiled-binary mode, every other canonical pi-*
 * package root AND every non-wildcard subpath registered in the bundled
 * registry (see `legacy-pi-bundled-keys.ts`). Subpath coverage is what stops
 * `@(scope)/pi-ai/oauth` and friends from falling through to the extension's
 * own — possibly absent — peer install when bunfs filesystem walks fail
 * (issue #3442 follow-up to #3423). Exported as a test seam so the
 * compiled-binary branch is verifiable from dev tests.
 */
export function __buildLegacyPiPackageRootOverrides(isCompiled: boolean): Record<string, string> {
	const candidates: Record<string, string> = {
		[`${CANONICAL_PI_SCOPE}/pi-ai`]: LEGACY_PI_AI_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
	};
	if (isCompiled) {
		for (const key of BUNDLED_PI_REGISTRY_KEYS) {
			// Shim-bearing roots above already mapped to their compat surface;
			// the bundled typebox shim has a dedicated TYPEBOX_SHIM_PATH route.
			if (key in candidates || key === TYPEBOX_BUNDLED_REGISTRY_KEY) continue;
			candidates[key] = bundledRegistryVirtualSpecifier(key);
		}
	}
	return __validateLegacyPiPackageRootOverrides(candidates);
}

const LEGACY_PI_PACKAGE_ROOT_OVERRIDES = __buildLegacyPiPackageRootOverrides(IS_COMPILED_BINARY);

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = remapLegacyPiSubpath(rest);
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a canonical `@pk-nerdsaver-ai/*` specifier to a filesystem path, preferring
 * a bundled compat shim when one is registered for the package root.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for non-overridden
 * specifiers.
 */
function resolveCanonicalPiSpecifier(remappedSpecifier: string): string {
	const override = LEGACY_PI_PACKAGE_ROOT_OVERRIDES[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(remappedSpecifier);
}

function toImportSpecifier(resolvedPath: string): string {
	// Virtual `omp-legacy-pi-bundled:` specifiers are served by the synthetic
	// onLoad in `installLegacyPiSpecifierShim()`; wrapping them as `file://`
	// would corrupt the scheme and bypass the bundled registry.
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(resolvedPath).href;
}

function rewriteLegacyPiImports(source: string): string {
	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const remappedSpecifier = remapLegacyPiSpecifier(specifier);
			if (!remappedSpecifier) {
				return match;
			}

			try {
				return `${prefix}${toImportSpecifier(resolveCanonicalPiSpecifier(remappedSpecifier))}${suffix}`;
			} catch {
				// Resolution failed — typically in compiled binary mode where
				// Bun.resolveSync cannot walk up from /$bunfs/root to find the
				// bundled node_modules. Leave the specifier unchanged so Bun
				// resolves it natively against the extension's own peer deps.
				return match;
			}
		},
	);
}

// Match the bare TypeBox import specifiers (static + dynamic). Subpath imports
// like `@sinclair/typebox/compiler` are intentionally excluded — they expose
// TypeBox-only APIs the Zod-backed shim does not provide.
const TYPEBOX_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])(@sinclair\/typebox|typebox)(["'])/g;

/**
 * Rewrite the extension-owned specifiers OMP must host-resolve — legacy
 * `@(scope)/pi-*`, bare TypeBox packages, package `imports` aliases like
 * `#src/*`, and extension-local bare dependencies — to absolute `file://` URLs
 * or compiled-mode virtual specifiers. Relative siblings and built-in modules
 * are left untouched so Bun resolves them from the extension's real on-disk
 * location.
 */
async function rewriteLegacyExtensionSource(source: string, importerPath: string): Promise<string> {
	const withPi = rewriteLegacyPiImports(source);
	// When the TypeBox shim is missing (release build dropped the entrypoint —
	// issue #3414), leave bare specifiers untouched so Bun resolves a real
	// `typebox` / `@sinclair/typebox` install from the extension's own
	// `node_modules`. `resolveTypeBoxSpecifier` mirrors the fall-through.
	const withTypeBox = TYPEBOX_SHIM_PATH
		? withPi.replace(
				TYPEBOX_IMPORT_SPECIFIER_REGEX,
				(_match, prefix: string, _specifier: string, suffix: string) =>
					`${prefix}${toImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`,
			)
		: withPi;
	return rewriteExtensionBareImports(await rewriteExtensionPackageImports(withTypeBox, importerPath), importerPath);
}

/** Test seam for compiled-binary legacy extension source rewriting. */
export async function __rewriteLegacyExtensionSourceForTests(source: string, importerPath: string): Promise<string> {
	return rewriteLegacyExtensionSource(source, importerPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.stat(p);
		return true;
	} catch {
		return false;
	}
}

function hasSourceModuleExtension(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return (SOURCE_MODULE_EXTENSIONS as readonly string[]).includes(ext);
}

async function resolveSourceModuleFile(basePath: string): Promise<string | null> {
	try {
		const stats = await fs.promises.stat(basePath);
		if (stats.isFile()) {
			// Non-source files (JSON, WASM, text assets, etc.) bypass the on-load
			// rewrite hook so Bun's native loaders handle them; our hook would
			// otherwise pass them through `getLoader()` which falls back to `js`.
			return hasSourceModuleExtension(basePath) ? realpathOrSelf(basePath) : null;
		}
		if (stats.isDirectory()) {
			for (const extension of SOURCE_MODULE_EXTENSIONS) {
				const resolved = await resolveSourceModuleFile(path.join(basePath, `index${extension}`));
				if (resolved) return resolved;
			}
		}
	} catch {
		// Fall through to extension candidates below.
	}

	if (path.extname(basePath)) {
		return null;
	}

	for (const extension of SOURCE_MODULE_EXTENSIONS) {
		const resolved = await resolveSourceModuleFile(`${basePath}${extension}`);
		if (resolved) return resolved;
	}
	return null;
}

async function findPackageRoot(importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const cached = packageRootCache.get(dir);
		if (cached !== undefined) {
			return cached;
		}

		if (await pathExists(path.join(dir, "package.json"))) {
			packageRootCache.set(path.dirname(importerPath), dir);
			return dir;
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			packageRootCache.set(path.dirname(importerPath), null);
			return null;
		}
		dir = parent;
	}
}

async function readPackageImports(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageImportsCache.get(packageRoot);
	if (cached !== undefined) {
		return cached;
	}

	let imports: Record<string, unknown> | null = null;
	try {
		const pkg = await Bun.file(path.join(packageRoot, "package.json")).json();
		if (isRecord(pkg) && isRecord(pkg.imports)) {
			imports = pkg.imports;
		}
	} catch {
		imports = null;
	}
	packageImportsCache.set(packageRoot, imports);
	return imports;
}

type PackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED | null;
type ResolvedPackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED;

function selectPackageImportTarget(entry: unknown): PackageImportTargetSelection {
	if (entry === null) {
		return PACKAGE_IMPORT_EXCLUDED;
	}
	if (typeof entry === "string") {
		return entry;
	}
	if (Array.isArray(entry)) {
		for (const item of entry) {
			const target = selectPackageImportTarget(item);
			if (target !== null) return target;
		}
		return null;
	}
	if (!isRecord(entry)) {
		return null;
	}
	for (const [condition, value] of Object.entries(entry)) {
		if (!SUPPORTED_PACKAGE_IMPORT_CONDITIONS.has(condition)) {
			continue;
		}
		const target = selectPackageImportTarget(value);
		if (target !== null) return target;
	}
	return null;
}

async function resolvePackageImportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolveSourceModuleFile(path.resolve(packageRoot, substituted));
}

async function resolvePackageImportSpecifier(specifier: string, importerPath: string): Promise<string | null> {
	if (!specifier.startsWith("#")) {
		return null;
	}

	const packageRoot = await findPackageRoot(importerPath);
	if (!packageRoot) {
		return null;
	}

	const imports = await readPackageImports(packageRoot);
	if (!imports) {
		return null;
	}

	const exactTarget = selectPackageImportTarget(imports[specifier]);
	if (exactTarget === PACKAGE_IMPORT_EXCLUDED) {
		return null;
	}
	if (exactTarget !== null) {
		return resolvePackageImportTarget(packageRoot, exactTarget, null);
	}

	let bestMatch: { keyLength: number; target: ResolvedPackageImportTargetSelection; wildcard: string } | null = null;
	for (const [key, entry] of Object.entries(imports)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1) continue;

		const prefix = key.slice(0, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
			continue;
		}

		const target = selectPackageImportTarget(entry);
		if (target === null) {
			continue;
		}

		if (!bestMatch || key.length > bestMatch.keyLength) {
			bestMatch = {
				keyLength: key.length,
				target,
				wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
			};
		}
	}

	if (!bestMatch || bestMatch.target === PACKAGE_IMPORT_EXCLUDED) {
		return null;
	}
	return resolvePackageImportTarget(packageRoot, bestMatch.target, bestMatch.wildcard);
}

const PACKAGE_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])(#[^"'()\s]+)(["'])/g;

async function rewriteExtensionPackageImports(source: string, importerPath: string): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(PACKAGE_IMPORT_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolvePackageImportSpecifier(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${toImportSpecifier(resolved)}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

const BARE_EXTENSION_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])([^"'()\s]+)(["'])/g;

function isBareExtensionDependencySpecifier(specifier: string): boolean {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.startsWith("node:") ||
		specifier.startsWith("bun:") ||
		/^[a-z][a-z0-9+.-]*:/i.test(specifier)
	) {
		return false;
	}
	const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return Boolean(packageName && !isBuiltin(packageName));
}

interface BarePackageSpecifier {
	readonly name: string;
	readonly subpath: string | null;
}

function splitBarePackageSpecifier(specifier: string): BarePackageSpecifier | null {
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		const [scope, name, ...rest] = parts;
		if (!scope || !name) return null;
		return { name: `${scope}/${name}`, subpath: rest.length > 0 ? rest.join("/") : null };
	}
	const [name, ...rest] = parts;
	if (!name) return null;
	return { name, subpath: rest.length > 0 ? rest.join("/") : null };
}

async function findNodePackageRoot(packageName: string, importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const candidate = path.join(dir, "node_modules", packageName);
		if (await pathExists(path.join(candidate, "package.json"))) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

async function readPackageManifest(packageRoot: string): Promise<Record<string, unknown> | null> {
	try {
		const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();
		return isRecord(manifest) ? manifest : null;
	} catch {
		return null;
	}
}

async function resolvePackageExportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolveSourceModuleFile(path.resolve(packageRoot, substituted));
}

async function resolveNodePackageExport(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
): Promise<string | null> {
	const exportsField = manifest.exports;
	const rootTarget = subpath === null ? selectPackageImportTarget(exportsField) : null;
	if (rootTarget !== null && rootTarget !== PACKAGE_IMPORT_EXCLUDED) {
		return resolvePackageExportTarget(packageRoot, rootTarget, null);
	}
	if (!isRecord(exportsField)) {
		return null;
	}

	const exactKey = subpath === null ? "." : `./${subpath}`;
	const exactTarget = selectPackageImportTarget(exportsField[exactKey]);
	if (exactTarget !== null && exactTarget !== PACKAGE_IMPORT_EXCLUDED) {
		return resolvePackageExportTarget(packageRoot, exactTarget, null);
	}

	for (const [key, entry] of Object.entries(exportsField)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1 || subpath === null) continue;
		const prefix = key.slice(2, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
			continue;
		}
		const target = selectPackageImportTarget(entry);
		if (target === null || target === PACKAGE_IMPORT_EXCLUDED) {
			continue;
		}
		return resolvePackageExportTarget(
			packageRoot,
			target,
			subpath.slice(prefix.length, subpath.length - suffix.length),
		);
	}
	return null;
}

async function resolveNodePackageFallback(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
): Promise<string | null> {
	if (subpath !== null) {
		return resolveSourceModuleFile(path.join(packageRoot, subpath));
	}
	for (const field of ["module", "main"]) {
		const target = manifest[field];
		if (typeof target === "string") {
			const resolved = await resolveSourceModuleFile(path.resolve(packageRoot, target));
			if (resolved) return resolved;
		}
	}
	return resolveSourceModuleFile(path.join(packageRoot, "index"));
}

async function resolveNodePackageDependency(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;
	const manifest = await readPackageManifest(packageRoot);
	if (!manifest) return null;
	return (
		(await resolveNodePackageExport(packageRoot, parsed.subpath, manifest)) ??
		(await resolveNodePackageFallback(packageRoot, parsed.subpath, manifest))
	);
}

async function resolveExtensionBareDependency(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}
	try {
		const resolved = Bun.resolveSync(specifier, path.dirname(importerPath));
		if (resolved && resolved !== specifier && !resolved.startsWith("node:") && !resolved.startsWith("bun:")) {
			return resolved;
		}
	} catch {
		// Compiled binaries do not reliably resolve runtime extension node_modules.
	}
	return resolveNodePackageDependency(specifier, importerPath);
}

async function rewriteExtensionBareImports(source: string, importerPath: string): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(BARE_EXTENSION_IMPORT_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolveExtensionBareDependency(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${toImportSpecifier(resolved)}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match source modules in an extension graph (relative imports and package
// `imports` aliases such as `#src/*`). Bare third-party dependencies remain
// native Bun resolutions.
const EXTENSION_GRAPH_SPECIFIER_REGEX = /(?:from\s+|import\s+|import\s*\(\s*)["']((?:\.\.?\/|#)[^"']+)["']/g;

// Extension entry realpaths that already have a load-time rewrite hook
// installed. Each `Bun.plugin()` registration is process-global and permanent,
// so we register at most one hook per entry.
const hookedExtensionEntries = new Set<string>();

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return p;
	}
}

/**
 * Walk the extension's relative-import graph starting at `entryRealPath`,
 * returning the realpath of every reachable source module. Only relative
 * specifiers (`./`, `../`) are followed — bare and absolute imports are left to
 * Bun's native resolver — so the set is exactly the extension's own source,
 * wherever it physically lives (a `../src` sibling, a symlinked sub-tree, …).
 * This mirrors the module set the old temp-dir mirror tracked, minus the copy.
 */
async function collectExtensionModules(entryRealPath: string): Promise<Set<string>> {
	const modules = new Set<string>();
	const queue = [entryRealPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.add(file);
		const dir = path.dirname(file);
		for (const match of source.matchAll(EXTENSION_GRAPH_SPECIFIER_REGEX)) {
			const specifier = match[1];
			if (!specifier) continue;
			try {
				const resolved = specifier.startsWith("#")
					? await resolvePackageImportSpecifier(specifier, file)
					: await realpathOrSelf(Bun.resolveSync(specifier, dir));
				if (resolved && !modules.has(resolved)) {
					queue.push(resolved);
				}
			} catch {
				// Unresolvable relative import (e.g. a type-only path); skip it.
			}
		}
	}
	return modules;
}

/**
 * Install a `Bun.plugin()` `onLoad` hook scoped to exactly the modules in an
 * extension's source graph, so their legacy `@(scope)/pi-*`, bare
 * `@sinclair/typebox`, and local package-import aliases are rewritten at load
 * time. A runtime `onLoad` cannot fall through (Bun requires a result object),
 * so the filter is an exact-path alternation of the graph's realpaths — it
 * never matches the host, other extensions, `node_modules` deps, or unrelated
 * project source.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<void> {
	if (hookedExtensionEntries.has(entryRealPath)) {
		return;
	}
	hookedExtensionEntries.add(entryRealPath);

	const modules = await collectExtensionModules(entryRealPath);
	const alternation = [...modules].map(escapeRegExp).join("|");
	const filter = new RegExp(`^(?:${alternation})$`);
	Bun.plugin({
		name: `omp:legacy-pi-ext:${Bun.hash(entryRealPath).toString(36)}`,
		setup(build) {
			build.onLoad({ filter, namespace: "file" }, async args => {
				const raw = await Bun.file(args.path).text();
				return { contents: await rewriteLegacyExtensionSource(raw, args.path), loader: getLoader(args.path) };
			});
		},
	});
}

/**
 * Load a legacy Pi extension module from its real on-disk location.
 *
 * The extension runs in place, so its `import.meta.url` is the real source file
 * and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled next to
 * the entry) resolve exactly as they do under the original Pi runtime — no
 * temp-directory mirroring and no asset copying. An `onLoad` hook scoped to the
 * entry's source graph rewrites only host-resolved compatibility imports in the
 * extension's own source; everything else resolves natively.
 */
export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureExtensionGraphHook(entryRealPath);
	// `?mtime` busts Bun's module cache so repeat loads pick up edited source.
	return import(`${toImportSpecifier(entryRealPath)}?mtime=${Date.now()}`);
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): { path: string } | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	// Primary: resolve the canonical @pk-nerdsaver-ai/* specifier from the host binary
	// location. Works in dev mode and in source-link installs.
	try {
		return { path: resolveCanonicalPiSpecifier(remappedSpecifier) };
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @pk-nerdsaver-ai peer deps, then try the original legacy
		// specifier for plugins that still vendor only @mariozechner or
		// @earendil-works peer deps.
		const importerDir = path.dirname(args.importer);
		try {
			return { path: Bun.resolveSync(remappedSpecifier, importerDir) };
		} catch {
			try {
				return { path: Bun.resolveSync(args.path, importerDir) };
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): { path: string } | undefined {
	return TYPEBOX_SHIM_PATH ? { path: TYPEBOX_SHIM_PATH } : undefined;
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
			// Compiled-binary mode: serve `omp-legacy-pi-bundled:<key>` imports
			// from the JS-heap registry. The rewrite path emits these specifiers
			// in place of unreachable `file:///$bunfs/...` URLs (issue #3423).
			build.onLoad({ filter: /.*/, namespace: BUNDLED_VIRTUAL_NAMESPACE }, async args => {
				return { contents: await synthesizeBundledModuleSource(args.path), loader: "js" };
			});
		},
	});
}

/** Test seam: clears the memoized canonical specifier resolutions. */
export function __resetLegacyPiResolutionCache(): void {
	resolvedSpecifierFallbacks.clear();
}

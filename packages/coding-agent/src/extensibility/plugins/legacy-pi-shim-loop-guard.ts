/**
 * Shim resolution self-loop guard (issue #8900).
 *
 * The compat shims value-import their own canonical package root by bare
 * specifier: `legacy-pi-tui-shim.ts` does `export * from "@oh-my-pi/pi-tui"`,
 * the pi-ai shim re-exports `@oh-my-pi/pi-ai`, and the coding-agent shim
 * imports `@oh-my-pi/pi-tui` / `@oh-my-pi/pi-ai`. The process-global
 * `onResolve` installed by `installLegacyPiSpecifierShim()` also fires for
 * imports originating *from* those shim files, and its package-root override
 * map sends the bare specifier straight back onto the shim. ESM tolerates a
 * true self-cycle, but when consecutive hops disagree on module identity —
 * macOS symlink realpath divergence (`/var` → `/private/var`), bun
 * global-cache install paths, `?mtime=` cache-bust suffixes — Bun keys every
 * hop as a brand-new module and resolution recurses without bound: an opaque
 * `RangeError: Maximum call stack size exceeded` before the TUI exists,
 * triggered by a single custom tool that value-imports
 * `@oh-my-pi/pi-coding-agent`.
 *
 * The guard is a separate `Bun.plugin` registered *before*
 * `installLegacyPiSpecifierShim()` — Bun runs `onResolve` hooks in
 * registration order and the first non-undefined result wins. Imports issued
 * by an on-disk compat shim resolve the real canonical package here and never
 * reach the override map; every other resolution falls through untouched.
 * Shim → canonical always terminates; extension → shim behavior is unchanged.
 *
 * Compiled-binary mode serves the shims as virtual modules in the
 * `omp-legacy-pi-bundled` namespace, so the guard is inert there by
 * construction and skips installation entirely.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";
import { __computeBundledSelfPackageRoot } from "./legacy-pi-compat";

// Mirrors the scope/package alternation of `LEGACY_PI_SPECIFIER_FILTER` in
// legacy-pi-compat.ts. The two filters must stay in sync: the guard only needs
// to fire for specifiers the compat resolver would also claim.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;
const LEGACY_PI_SPECIFIER_FILTER = new RegExp(
	`^@(?:${PI_SCOPE_ALIASES.join("|")})/(?:${PI_PACKAGE_NAMES.join("|")})(?:/.*)?$`,
);
const LEGACY_PI_SCOPE_PREFIX = new RegExp(`^@(?:${PI_SCOPE_ALIASES.join("|")})/`);

// Compiled-mode virtual specifiers (`omp-legacy-pi-bundled:<key>`) are served
// by dedicated handlers in legacy-pi-compat.ts and must never be treated as
// filesystem paths here.
const BUNDLED_VIRTUAL_SCHEME = "omp-legacy-pi-bundled:";

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(BUNDLED_VIRTUAL_SCHEME);
}

/** Canonicalize a legacy `@(scope)/pi-*` specifier onto `@oh-my-pi/`. */
export function __canonicalizeLegacyPiSpecifier(specifier: string): string {
	return specifier.replace(LEGACY_PI_SCOPE_PREFIX, "@oh-my-pi/");
}

const syncRealpathCache = new Map<string, string>();

function clearShimLoopGuardCaches(): void {
	syncRealpathCache.clear();
}

registerPluginCacheInvalidator(clearShimLoopGuardCaches);

function realpathSyncOrSelf(candidatePath: string, realpathSyncImpl?: (p: string) => string): string {
	if (realpathSyncImpl) {
		// Injected impls (tests) skip the module-level cache so stubs cannot
		// poison production resolutions.
		try {
			return realpathSyncImpl(candidatePath);
		} catch {
			return candidatePath;
		}
	}
	const cached = syncRealpathCache.get(candidatePath);
	if (cached !== undefined) {
		return cached;
	}
	let real = candidatePath;
	try {
		real = fs.realpathSync(candidatePath);
	} catch {
		// Missing path: fall back to identity so comparison still uses the
		// raw normalized path.
	}
	syncRealpathCache.set(candidatePath, real);
	return real;
}

/**
 * Normalize a resolver path for identity comparison: drop `?mtime=` style
 * cache-bust suffixes, `path.normalize`, then resolve symlinks.
 */
function comparableResolverPath(candidatePath: string, realpathSyncImpl?: (p: string) => string): string {
	const queryIdx = candidatePath.indexOf("?");
	const withoutQuery = queryIdx === -1 ? candidatePath : candidatePath.slice(0, queryIdx);
	return realpathSyncOrSelf(path.normalize(withoutQuery), realpathSyncImpl);
}

/**
 * True when handing `resolved` to `importer` would give a module its own file
 * back under a (possibly different) path — the direct self-edge of the issue
 * #8900 recursion. Comparison is `path.normalize` + realpath insensitive and
 * ignores query-string cache-bust suffixes.
 *
 * Exported for tests; production callers go through the installed guard.
 */
export function __isLegacyPiSelfLoopResolution(
	resolved: string,
	importer: string | undefined,
	realpathSyncImpl?: (p: string) => string,
): boolean {
	if (!importer || isBundledVirtualSpecifier(resolved) || isBundledVirtualSpecifier(importer)) {
		return false;
	}
	return comparableResolverPath(resolved, realpathSyncImpl) === comparableResolverPath(importer, realpathSyncImpl);
}

const SHIM_FILE_NAMES = ["legacy-pi-ai-shim.ts", "legacy-pi-coding-agent-shim.ts", "legacy-pi-tui-shim.ts"] as const;

/**
 * The on-disk compat shim paths, computed the same way legacy-pi-compat.ts
 * computes them: from the npm prebuilt package root when `PI_BUNDLED` is set
 * (`bundle-dist.ts` defines it; `import.meta.dir` then points at
 * `<package>/dist`), otherwise from the monorepo source tree relative to this
 * file.
 */
function defaultShimPaths(): string[] {
	const bundledRoot = process.env.PI_BUNDLED ? __computeBundledSelfPackageRoot(import.meta.dir) : undefined;
	const shimDir = bundledRoot ? path.join(bundledRoot, "src", "extensibility") : path.resolve(import.meta.dir, "..");
	return SHIM_FILE_NAMES.map(file => path.join(shimDir, file));
}

/**
 * True when `importer` is one of the on-disk compat shim modules. Imports
 * issued by the shims themselves must resolve the real canonical packages —
 * mapping them back onto a shim is either an immediate self-cycle (the
 * pi-tui / pi-ai shims re-export their own package root) or one resolution
 * hop away from one.
 *
 * Exported for tests; production callers go through the installed guard.
 */
export function __isLegacyPiShimImporter(
	importer: string | undefined,
	shimPaths: readonly string[] = defaultShimPaths(),
	realpathSyncImpl?: (p: string) => string,
): boolean {
	if (!importer || isBundledVirtualSpecifier(importer)) {
		return false;
	}
	const comparableImporter = comparableResolverPath(importer, realpathSyncImpl);
	return shimPaths.some(shimPath => comparableResolverPath(shimPath, realpathSyncImpl) === comparableImporter);
}

let isLegacyPiShimLoopGuardInstalled = false;

/**
 * Install the guard plugin. Must be called before
 * `installLegacyPiSpecifierShim()` so this `onResolve` runs first. Idempotent.
 */
export function installLegacyPiShimLoopGuard(): void {
	if (isLegacyPiShimLoopGuardInstalled || isCompiledBinary()) {
		// Compiled-binary mode serves shims as virtual modules in a separate
		// namespace; there is no file-namespace shim importer to guard.
		isLegacyPiShimLoopGuardInstalled = true;
		return;
	}
	isLegacyPiShimLoopGuardInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim-loop-guard",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, args => {
				if (!__isLegacyPiShimImporter(args.importer)) {
					// Not shim-originated: fall through to the compat resolver.
					return undefined;
				}
				const canonical = __canonicalizeLegacyPiSpecifier(args.path);
				// Prefer host-relative resolution (dev mode and source-link
				// installs), then the importer's own tree (plugin-installed
				// peer deps). Both failing means the canonical package is
				// genuinely unresolvable; fall through so the compat
				// resolver's own fallbacks (and error surface) apply.
				try {
					const resolved = Bun.resolveSync(canonical, import.meta.dir);
					if (!__isLegacyPiSelfLoopResolution(resolved, args.importer)) {
						return { path: resolved };
					}
				} catch {
					// Continue to importer-relative resolution below.
				}
				try {
					const resolved = Bun.resolveSync(canonical, path.dirname(args.importer));
					if (!__isLegacyPiSelfLoopResolution(resolved, args.importer)) {
						return { path: resolved };
					}
				} catch {
					// Fall through to the compat resolver.
				}
				return undefined;
			});
		},
	});
}

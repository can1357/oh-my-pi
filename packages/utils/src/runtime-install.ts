import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as Module from "node:module";
import * as path from "node:path";
import { withFileLock } from "./file-lock";
import { isEexist, isEnoent } from "./fs-error";

/**
 * On-demand runtime dependency support for native-heavy optional packages
 * (Transformers.js, fastembed) that are never bundled into the CLI or the
 * compiled binary. Consumers `bun install` a pinned dependency set into a
 * cache directory on first use ({@link ensureRuntimeInstalled}) and load the
 * entrypoint via `createRequire`.
 *
 * Bun's compiled-binary module resolver only finds `<pkg>/index.js` for bare
 * specifiers loaded from the *real* filesystem — it ignores `main`/`exports`
 * (issue #1763). Runtime-installed graphs (`@huggingface/transformers` →
 * `onnxruntime-node` → `onnxruntime-common`, `fastembed` →
 * `@anush008/tokenizers` → platform binding) all point `main`/`exports` at
 * nested files, so the stock resolver cannot load any of them. We patch
 * `Module._resolveFilename` to resolve those bare specifiers against the
 * registered runtime caches ourselves, honoring `main`/`exports`.
 *
 * This module is filesystem-pure aside from {@link installRuntimeModuleResolver}
 * mutating the `node:module` resolver, so the resolution logic is unit-testable
 * without a compiled binary.
 */

/** Conditions honored when resolving an `exports` map for a CommonJS `require`. */
const RUNTIME_CONDITIONS: Record<string, true> = { node: true, require: true, default: true };

/** Extension probes appended to a `main`/`exports` target that lacks one. */
const RUNTIME_EXTENSIONS: readonly string[] = [".js", ".cjs", ".mjs", ".json", ".node"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a conditional `exports` target (string, array of fallbacks, or a
 * condition object) and return the first relative path that matches a runtime
 * condition in declaration order. Returns `null` when nothing applies (e.g.
 * an `import`-only entry).
 */
export function selectConditionalTarget(target: unknown): string | null {
	if (typeof target === "string") return target;
	if (Array.isArray(target)) {
		for (const entry of target) {
			const resolved = selectConditionalTarget(entry);
			if (resolved) return resolved;
		}
		return null;
	}
	if (isRecord(target)) {
		for (const condition in target) {
			if (!RUNTIME_CONDITIONS[condition]) continue;
			const resolved = selectConditionalTarget(target[condition]);
			if (resolved) return resolved;
		}
	}
	return null;
}

/** Resolve a relative target inside a package to a concrete file path, probing extensions and `index`. */
function resolveFileTarget(pkgDir: string, relative: string): string | null {
	const base = path.join(pkgDir, relative);
	const candidates = [base, ...RUNTIME_EXTENSIONS.map(ext => base + ext)];
	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) return candidate;
			if (stat.isDirectory()) {
				const indexed = resolveFileTarget(candidate, "index");
				if (indexed) return indexed;
			}
		} catch {
			// missing candidate — keep probing
		}
	}
	return null;
}

function resolveExportsEntry(
	pkgDir: string,
	exports: Record<string, unknown>,
	subpath: string | undefined,
): string | null {
	let subpathMap = false;
	for (const key in exports) {
		subpathMap = key === "." || key.startsWith("./");
		break;
	}
	if (subpathMap) {
		const key = subpath ? `./${subpath}` : ".";
		if (!(key in exports)) return null;
		const target = selectConditionalTarget(exports[key]);
		return target ? resolveFileTarget(pkgDir, target) : null;
	}
	// A bare condition map only describes the package root, so a subpath
	// request falls through to plain path joining at the call site.
	if (subpath) return null;
	const target = selectConditionalTarget(exports);
	return target ? resolveFileTarget(pkgDir, target) : null;
}

/**
 * Split a bare specifier into its package name and optional subpath, handling
 * scoped packages (`@scope/name/sub` → `@scope/name` + `sub`).
 */
export function splitBareSpecifier(specifier: string): { packageName: string; subpath: string | undefined } {
	const segments = specifier.split("/");
	const take = specifier.startsWith("@") ? 2 : 1;
	const packageName = segments.slice(0, take).join("/");
	const subpath = segments.length > take ? segments.slice(take).join("/") : undefined;
	return { packageName, subpath };
}

/**
 * Resolve a bare specifier against an installed `node_modules` directory,
 * honoring `exports` (CommonJS conditions), then `main`, then `index.js`.
 * Returns an absolute file path, or `null` when the package/entry is absent.
 */
export function resolveRuntimeModule(runtimeNodeModules: string, specifier: string): string | null {
	const { packageName, subpath } = splitBareSpecifier(specifier);
	const pkgDir = path.join(runtimeNodeModules, ...packageName.split("/"));
	const manifest = readManifest(pkgDir);
	if (!manifest) return subpath ? resolveFileTarget(pkgDir, subpath) : null;

	const { exports } = manifest;
	if (typeof exports === "string" || isRecord(exports)) {
		const map = typeof exports === "string" ? { ".": exports } : exports;
		const resolved = resolveExportsEntry(pkgDir, map, subpath);
		if (resolved) return resolved;
	}
	if (subpath) return resolveFileTarget(pkgDir, subpath);
	if (typeof manifest.main === "string") {
		const resolved = resolveFileTarget(pkgDir, manifest.main);
		if (resolved) return resolved;
	}
	return resolveFileTarget(pkgDir, "index.js");
}

function readManifest(pkgDir: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface ModuleResolver {
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
}

interface ResolverRegistration {
	runtimeNodeModules: string;
	stubs: Record<string, string>;
}

const REGISTRY = Symbol.for("omp.runtimeModuleResolver.registry");
const PATCHED = Symbol.for("omp.runtimeModuleResolver.patched");

/**
 * The registration list lives on `globalThis` so a bundled copy and a
 * source copy of this module in one process share the same registry — the
 * resolver is patched once per process, and the patched closure must see
 * every registration.
 */
function resolverRegistry(): ResolverRegistration[] {
	const holder = globalThis as { [REGISTRY]?: ResolverRegistration[] };
	holder[REGISTRY] ??= [];
	return holder[REGISTRY];
}
function pathContains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parentFilename(parent: unknown): string | null {
	if (!isRecord(parent)) return null;
	const filename = parent.filename;
	return typeof filename === "string" ? filename : null;
}

export interface RuntimeResolverOptions {
	/** Absolute path to the runtime cache's `node_modules`. */
	runtimeNodeModules: string;
	/** Bare specifier → absolute file path overrides (e.g. `sharp` → no-op stub). */
	stubs?: Record<string, string>;
}

/**
 * Patch `node:module`'s resolver (idempotently) so bare specifiers that the
 * stock compiled-binary resolver cannot find fall back to the registered
 * runtime caches. Stock resolution is tried first and kept for anything
 * outside the registered roots (bundled imports, node builtins, host or
 * extension trees). Multiple runtime roots may register; they are consulted
 * in registration order. Returns an uninstaller that drops the registration
 * and restores the stock resolver once no registrations remain.
 *
 * One stock "success" is distrusted: the compiled-binary resolver ignores
 * `main`/`exports` for real-FS packages (Bun #1763), so a package shipping
 * its TS source next to `dist/` (e.g. `@huggingface/hub`'s root `index.ts`)
 * resolves to the wrong file. When the stock hit lands inside a registered
 * runtime root, the manifest-aware resolution wins.
 *
 * KNOWN LIMITATION (Bun 1.3.14): while any JS override of
 * `Module._resolveFilename` is installed, Bun routes `createRequire(...)`
 * resolution through it with `parent === undefined` — the requester context is
 * never passed, so relative requires from a `createRequire` require fail with
 * "Cannot find module './x' from ''". The override cannot recover what it is
 * never given. Keep this patch scoped to dedicated worker/runtime processes
 * (tiny-inference, fastembed); never install it in the main agent process,
 * where legacy-pi extensions rely on `createRequire` relative requires.
 */
export function installRuntimeModuleResolver({ runtimeNodeModules, stubs = {} }: RuntimeResolverOptions): () => void {
	const registry = resolverRegistry();
	const existing = registry.find(entry => entry.runtimeNodeModules === runtimeNodeModules);
	if (existing) Object.assign(existing.stubs, stubs);
	else registry.push({ runtimeNodeModules, stubs: { ...stubs } });

	const resolver = (Module as unknown as { default?: ModuleResolver } & ModuleResolver).default ?? Module;
	const target = resolver as unknown as ModuleResolver & { [PATCHED]?: () => void };
	const uninstall = (): void => {
		const entries = resolverRegistry();
		const index = entries.findIndex(entry => entry.runtimeNodeModules === runtimeNodeModules);
		if (index !== -1) entries.splice(index, 1);
		if (entries.length === 0) target[PATCHED]?.();
	};
	if (target[PATCHED]) return uninstall;
	const pristine = target._resolveFilename;
	const original = pristine.bind(target);
	target._resolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown): string => {
		let stockResolved: string | null = null;
		let stockError: unknown;
		try {
			stockResolved = original(request, parent, isMain, options);
		} catch (error) {
			stockError = error;
		}
		const bare = !request.startsWith(".") && !request.startsWith("node:") && !path.isAbsolute(request);
		if (bare) {
			const parentFile = parentFilename(parent);
			for (const registration of resolverRegistry()) {
				const parentInRuntime = parentFile !== null && pathContains(registration.runtimeNodeModules, parentFile);
				if (parentInRuntime) {
					const stub = registration.stubs[request];
					if (stub) return stub;
					if (!stockResolved || !pathContains(registration.runtimeNodeModules, stockResolved)) {
						const fallback = resolveRuntimeModule(registration.runtimeNodeModules, request);
						if (fallback) return fallback;
					}
				}
				if (stockResolved) {
					// Correct a stock hit only inside the top-level package the
					// request names. A hit in a nested node_modules (e.g. tar's
					// minizlib resolving its own minipass@3 under
					// <root>/minizlib/node_modules/) is version-correct — overriding
					// it with the top-level instance would cross major versions.
					const { packageName } = splitBareSpecifier(request);
					const pkgDir = path.join(registration.runtimeNodeModules, ...packageName.split("/"));
					if (!stockResolved.startsWith(pkgDir + path.sep)) continue;
					if (path.relative(pkgDir, stockResolved).split(path.sep).includes("node_modules")) continue;
					const expected = resolveRuntimeModule(registration.runtimeNodeModules, request);
					if (expected) return expected;
				} else {
					const stub = registration.stubs[request];
					if (stub) return stub;
					const fallback = resolveRuntimeModule(registration.runtimeNodeModules, request);
					if (fallback) return fallback;
				}
			}
		}
		if (stockResolved) return stockResolved;
		throw stockError;
	};
	target[PATCHED] = () => {
		target._resolveFilename = pristine;
		delete target[PATCHED];
	};
	return uninstall;
}

/** Pinned dependency set materialized into a runtime cache directory. */
export interface RuntimeInstallSpec {
	dependencies: Record<string, string>;
	/** Version pins forced across the whole runtime tree (bun `overrides`), e.g. dislodging a transitive dep. */
	overrides?: Record<string, string>;
	/** Packages whose lifecycle scripts bun may run during the install. */
	trustedDependencies?: string[];
}

export type RuntimeInstallPhase = "initiate" | "download" | "done";

export interface EnsureRuntimeInstalledOptions {
	/** Directory owning the runtime `package.json` + `node_modules`. */
	runtimeDir: string;
	install: RuntimeInstallSpec;
	/** Package whose installed manifest marks the runtime complete; defaults to the first dependency. */
	probePackage?: string;
	/** Phase notifications (progress UI); not emitted when already installed. */
	onPhase?: (phase: RuntimeInstallPhase) => void;
	lockAttempts?: number;
	lockSleepMs?: number;
}

/** No runtime install plausibly runs this long, so older legacy lock directories are crash orphans. */
const STALE_LEGACY_LOCK_MS = 10 * 60_000;

/**
 * Run `fn` while reserving the pre-crash-safe `${runtimeDir}.lock` namespace.
 *
 * Versions through 18.0.10 serialized installs with a bare lock *directory*
 * that only its creator removed; an installer killed outside that window
 * (SIGKILL/OOM/Ctrl-C) left it unreleasable, wedging every later install for
 * the full wait envelope (issue #10120). During an in-flight upgrade a legacy
 * process may still legitimately own this directory, so poll until it is
 * released and only force-reclaim once the directory is older than any
 * plausible install ({@link STALE_LEGACY_LOCK_MS}) — never merely because a
 * retry budget elapsed, which would delete a still-active legacy lock and let
 * two installers race the same tree. Once the namespace is free, atomically
 * create and retain a regular file through `fn`: an older process cannot
 * acquire it between the handoff check and the new install. A file left by a
 * crashed new installer can be reused immediately because the outer OS lock
 * proves its owner is gone, unlike a legacy directory whose owner is unknown.
 */
async function withLegacyInstallLock<T>(runtimeDir: string, sleepMs: number, fn: () => Promise<T>): Promise<T> {
	const legacy = `${runtimeDir}.lock`;
	for (;;) {
		try {
			const reservation = await fsp.open(legacy, "wx");
			await reservation.close();
		} catch (error) {
			if (!isEexist(error)) throw error;
			let stat: fs.Stats;
			try {
				stat = await fsp.stat(legacy);
			} catch (statError) {
				if (isEnoent(statError)) continue; // released between open and stat; retry
				throw statError;
			}
			// A non-directory is a reservation left by a newer installer. The
			// outer OS lock proves that installer is gone, so reuse it at once.
			if (!stat.isDirectory()) break;
			// A fresh directory may still belong to a live pre-18.x installer, so
			// wait for it to finish; only a crash orphan (older than any plausible
			// install) is force-reclaimed.
			if (Date.now() - stat.mtimeMs > STALE_LEGACY_LOCK_MS) {
				await fsp.rm(legacy, { recursive: true, force: true });
			} else {
				await Bun.sleep(sleepMs);
			}
			continue;
		}
		break;
	}
	// Retain the regular-file reservation across the install.
	try {
		return await fn();
	} finally {
		await fsp.rm(legacy, { force: true });
	}
}

export async function writeRuntimeManifest(runtimeDir: string, install: RuntimeInstallSpec): Promise<void> {
	await fsp.mkdir(runtimeDir, { recursive: true });
	const manifest: Record<string, unknown> = {
		private: true,
		type: "module",
		dependencies: install.dependencies,
	};
	if (install.overrides && Object.keys(install.overrides).length) manifest.overrides = install.overrides;
	if (install.trustedDependencies?.length) manifest.trustedDependencies = install.trustedDependencies;
	await Bun.write(path.join(runtimeDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

async function runRuntimeInstall(runtimeDir: string): Promise<void> {
	// `process.execPath` is plain bun in source/bundle mode and the compiled
	// binary otherwise; BUN_BE_BUN makes the compiled binary act as bun.
	const proc = Bun.spawn([process.execPath, "install", "--cwd", runtimeDir, "--production"], {
		env: { ...Bun.env, BUN_BE_BUN: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode === 0) return;
	const output = `${stdout}\n${stderr}`.trim();
	throw new Error(
		`Failed to install runtime at ${runtimeDir} with ${process.execPath} install (exit ${exitCode}): ${output}`,
	);
}

/**
 * Materialize a pinned dependency set into `runtimeDir` (idempotent,
 * cross-process safe). Returns `runtimeDir`.
 *
 * Serialization uses the OS-backed {@link withFileLock} at
 * `${runtimeDir}.install.lock`, which the kernel releases on process death, so
 * a crashed installer cannot wedge later attempts (issue #10120). The path is
 * deliberately distinct from the legacy `${runtimeDir}.lock` mkdir directory;
 * {@link withLegacyInstallLock} atomically reserves that namespace during the
 * new install so older processes cannot cross the migration boundary.
 */
export async function ensureRuntimeInstalled(options: EnsureRuntimeInstalledOptions): Promise<string> {
	const { runtimeDir, install, onPhase, lockAttempts = 240, lockSleepMs = 250 } = options;
	let probePackage = options.probePackage;
	if (!probePackage) {
		for (const name in install.dependencies) {
			probePackage = name;
			break;
		}
	}
	if (!probePackage) throw new Error(`Runtime install at ${runtimeDir} declares no dependencies`);
	const probeManifest = Bun.file(path.join(runtimeDir, "node_modules", ...probePackage.split("/"), "package.json"));
	if (await probeManifest.exists()) return runtimeDir;

	onPhase?.("initiate");
	// withFileLock does not create parent directories; the runtime cache dir may
	// not exist yet on the very first install.
	await fsp.mkdir(path.dirname(runtimeDir), { recursive: true });
	return withFileLock(
		`${runtimeDir}.install`,
		() =>
			withLegacyInstallLock(runtimeDir, lockSleepMs, async () => {
				if (await probeManifest.exists()) return runtimeDir;
				await writeRuntimeManifest(runtimeDir, install);
				onPhase?.("download");
				await runRuntimeInstall(runtimeDir);
				onPhase?.("done");
				return runtimeDir;
			}),
		{ retries: lockAttempts, retryDelayMs: lockSleepMs },
	);
}

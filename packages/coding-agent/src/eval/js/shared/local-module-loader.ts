import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { collectModuleSourceSpecifiers, stripTypeScriptSyntax } from "./rewrite-imports";

interface LocalModuleEntry {
	version: number;
	identifier: string;
	module: vm.SourceTextModule;
	/** Memoized link+evaluate of this module as a graph root; set lazily by `#loadLocalModule`. */
	loaded?: Promise<void>;
}

export type LocalImportResolution = { mode: "local"; value: unknown } | { mode: "external"; target: string };

const LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);

export class LocalModuleLoader {
	#context: vm.Context;
	#sessionTag: string;
	#moduleMtimes = new Map<string, number>();
	#moduleDeps = new Map<string, Set<string>>();
	#moduleParents = new Map<string, Set<string>>();
	#moduleVersions = new Map<string, number>();
	#moduleEntries = new Map<string, LocalModuleEntry>();
	#moduleBuilds = new Map<string, Promise<LocalModuleEntry>>();
	#externalModules = new Map<string, Promise<vm.Module>>();
	#requireCache = new Map<string, NodeJS.Require>();
	#modulePaths = new WeakMap<vm.Module, string>();
	#linkChain: Promise<void> = Promise.resolve();

	constructor(sessionId: string) {
		this.#context = vm.createContext(globalThis);
		this.#sessionTag = Bun.hash(sessionId).toString(16);
	}

	async resolveForRun(cwd: string, source: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		return await this.#resolveFromBase(cwd, source);
	}

	async resolveForModule(moduleUrl: string, source: string, cwd: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		const modulePath = this.filenameForUrl(moduleUrl);
		const baseDir = modulePath ? path.dirname(modulePath) : cwd;
		return await this.#resolveFromBase(baseDir, source);
	}

	requireForFile(moduleUrlOrPath: string | undefined, cwd: string): NodeJS.Require {
		const basePath = this.filenameForUrl(moduleUrlOrPath) ?? path.join(cwd, "[eval]");
		let cached = this.#requireCache.get(basePath);
		if (!cached) {
			cached = buildRequire(basePath);
			this.#requireCache.set(basePath, cached);
		}
		return cached;
	}

	filenameForUrl(moduleUrlOrPath: string | undefined): string | null {
		if (!moduleUrlOrPath) return null;
		if (moduleUrlOrPath.startsWith("file://")) return fileURLToPath(moduleUrlOrPath);
		return path.isAbsolute(moduleUrlOrPath) ? moduleUrlOrPath : null;
	}

	dirnameForUrl(moduleUrlOrPath: string | undefined, cwd: string): string {
		const filename = this.filenameForUrl(moduleUrlOrPath);
		return filename ? path.dirname(filename) : cwd;
	}

	async #resolveFromBase(baseDir: string, source: string): Promise<LocalImportResolution> {
		const resolved = resolveImportSpecifier(baseDir, source);
		if (isLocalPathSpecifier(source) && isManagedLocalModulePath(resolved)) {
			const module = await this.#loadLocalModule(resolved);
			return { mode: "local", value: module.namespace };
		}
		return { mode: "external", target: normalizeImportTarget(resolved) };
	}

	async #ensureLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const existing = this.#moduleEntries.get(modulePath);
		if (existing) return existing;
		const building = this.#moduleBuilds.get(modulePath);
		if (building) return await building;
		const buildPromise = this.#buildLocalModule(modulePath).finally(() => {
			if (this.#moduleBuilds.get(modulePath) === buildPromise) this.#moduleBuilds.delete(modulePath);
		});
		this.#moduleBuilds.set(modulePath, buildPromise);
		return await buildPromise;
	}

	// Construct (parse + register) a local module WITHOUT linking or evaluating it.
	// Linking and evaluation are driven once from the graph root in `#linkAndEvaluate`;
	// doing them per-module inside the recursive linker re-enters Bun's node:vm linker
	// mid-instantiation, which segfaults JSC (getImportedModule on a null record) whenever
	// the local graph contains an import cycle.
	async #buildLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const rawSource = fs.readFileSync(modulePath, "utf8");
		const stripped = stripTypeScriptSyntax(rawSource, {
			force: isTypeScriptModulePath(modulePath),
			loader: stripLoaderForPath(modulePath),
		});
		const moduleDir = path.dirname(modulePath);
		const localDeps = new Set<string>();
		for (const specifier of await collectModuleSourceSpecifiers(stripped)) {
			const resolved = resolveImportSpecifier(moduleDir, specifier);
			if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
				localDeps.add(resolved);
			}
		}
		this.#setModuleDependencies(modulePath, localDeps);
		this.#moduleMtimes.set(modulePath, fs.statSync(modulePath).mtimeMs);
		const version = this.#moduleVersions.get(modulePath) ?? 1;
		this.#moduleVersions.set(modulePath, version);
		const fileUrl = pathToFileURL(modulePath).href;
		const identifier = `${fileUrl}?omp-session=${this.#sessionTag}&v=${version}`;
		const wrappedSource = buildModuleSource(stripped, modulePath);
		const module = new vm.SourceTextModule(wrappedSource, {
			context: this.#context,
			identifier,
			initializeImportMeta: meta => {
				(meta as { url?: string; path?: string; dir?: string }).url = fileUrl;
				(meta as { url?: string; path?: string; dir?: string }).path = modulePath;
				(meta as { url?: string; path?: string; dir?: string }).dir = moduleDir;
			},
			importModuleDynamically: async specifier => {
				return await this.#resolveDynamicImport(modulePath, String(specifier));
			},
		});
		this.#modulePaths.set(module, modulePath);
		const entry: LocalModuleEntry = { version, identifier, module };
		this.#moduleEntries.set(modulePath, entry);
		return entry;
	}

	// Construct (if needed) then link+evaluate a local module as a graph root, returning
	// the evaluated module. Link and evaluate run exactly once over the whole reachable
	// graph; the static linker only constructs dependencies, letting node:vm instantiate
	// cyclic graphs in a single pass.
	async #loadLocalModule(modulePath: string): Promise<vm.SourceTextModule> {
		const entry = await this.#ensureLocalModule(modulePath);
		entry.loaded ??= this.#linkAndEvaluate(entry, modulePath);
		await entry.loaded;
		return entry.module;
	}

	async #linkAndEvaluate(entry: LocalModuleEntry, modulePath: string): Promise<void> {
		const { module } = entry;
		try {
			// Serialize the link phase across every graph root. Bun's node:vm linker
			// segfaults (getImportedModule on a null record) when two link passes
			// instantiate overlapping module instances concurrently — e.g.
			// Promise.all([import("./a"), import("./b")]) over a graph that shares
			// dependencies. Holding the lock for the whole module.link() (including its
			// async resolver callbacks) guarantees the linker is never re-entered
			// mid-instantiation. The lock is released before evaluate(), so a dynamic
			// import during evaluation can re-acquire it without deadlock.
			await this.#serializeLink(async () => {
				if (module.status === "unlinked") await module.link(this.#linkResolve);
			});
			if (module.status === "linked") await module.evaluate();
		} catch (error) {
			this.#invalidateFailedLoad(modulePath);
			throw error;
		}
		if (module.status === "errored") {
			this.#invalidateFailedLoad(modulePath);
			throw module.error;
		}
	}

	// Promise-chain mutex serializing node:vm link passes (see #linkAndEvaluate).
	// #linkChain is kept non-rejecting so a failed link never wedges the queue.
	#serializeLink<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#linkChain.then(run);
		this.#linkChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// Shared static-link resolver for `module.link()`. node:vm passes the referencing
	// module and reuses this one resolver for the entire graph, so the referrer path is
	// recovered from `#modulePaths`. Local dependencies are constructed but NOT linked or
	// evaluated here (the root drives that); externals are loaded eagerly — they carry no
	// imports and cannot participate in a cycle.
	#linkResolve = async (specifier: string, referencingModule: vm.Module): Promise<vm.Module> => {
		const referrerPath = this.#modulePaths.get(referencingModule);
		if (referrerPath === undefined) {
			throw new Error(`local module loader: unknown referrer while linking "${specifier}"`);
		}
		const resolved = resolveImportSpecifier(path.dirname(referrerPath), specifier);
		if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
			return (await this.#ensureLocalModule(resolved)).module;
		}
		return await this.#ensureExternalModule(normalizeImportTarget(resolved));
	};

	// Resolver for runtime `import()` inside evaluated module code: the result must be a
	// fully linked+evaluated module, so local targets are loaded as graph roots.
	async #resolveDynamicImport(referrerPath: string, specifier: string): Promise<vm.Module> {
		const resolved = resolveImportSpecifier(path.dirname(referrerPath), specifier);
		if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
			return await this.#loadLocalModule(resolved);
		}
		return await this.#ensureExternalModule(normalizeImportTarget(resolved));
	}

	// A failed link/evaluate can leave a partial graph cached. Drop every reachable module
	// that is not fully evaluated so the next attempt reconstructs it; fully evaluated
	// modules keep valid namespaces and stay cached.
	#invalidateFailedLoad(rootPath: string): void {
		const stack = [rootPath];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined || seen.has(current)) continue;
			seen.add(current);
			const entry = this.#moduleEntries.get(current);
			if (entry && entry.module.status === "evaluated") continue;
			this.#moduleEntries.delete(current);
			this.#moduleBuilds.delete(current);
			const deps = this.#moduleDeps.get(current);
			if (deps) for (const dep of deps) stack.push(dep);
		}
	}

	async #ensureExternalModule(target: string): Promise<vm.Module> {
		const existing = this.#externalModules.get(target);
		if (existing) return await existing;
		const loadPromise = (async () => {
			const namespace = await import(target);
			const exportNames = Object.keys(namespace);
			const module = new vm.SyntheticModule(
				exportNames,
				function () {
					for (const name of exportNames) {
						this.setExport(name, namespace[name as keyof typeof namespace]);
					}
				},
				{ context: this.#context, identifier: target },
			);
			await module.link(() => {
				throw new Error("Synthetic external modules have no dependencies");
			});
			await module.evaluate();
			return module;
		})();
		this.#externalModules.set(target, loadPromise);
		try {
			return await loadPromise;
		} catch (error) {
			if (this.#externalModules.get(target) === loadPromise) this.#externalModules.delete(target);
			throw error;
		}
	}

	#refreshTrackedLocalModules(): void {
		const changed: string[] = [];
		for (const [modulePath, previousMtime] of this.#moduleMtimes.entries()) {
			let nextMtime: number | undefined;
			try {
				nextMtime = fs.statSync(modulePath).mtimeMs;
			} catch {
				nextMtime = undefined;
			}
			if (nextMtime === previousMtime) continue;
			if (nextMtime === undefined) this.#moduleMtimes.delete(modulePath);
			else this.#moduleMtimes.set(modulePath, nextMtime);
			changed.push(modulePath);
		}
		for (const modulePath of changed) {
			this.#invalidateModuleAndParents(modulePath, new Set());
		}
	}

	#invalidateModuleAndParents(modulePath: string, seen: Set<string>): void {
		if (seen.has(modulePath)) return;
		seen.add(modulePath);
		this.#moduleEntries.delete(modulePath);
		this.#moduleBuilds.delete(modulePath);
		this.#moduleVersions.set(modulePath, (this.#moduleVersions.get(modulePath) ?? 1) + 1);
		const parents = [...(this.#moduleParents.get(modulePath) ?? [])];
		for (const parent of parents) this.#invalidateModuleAndParents(parent, seen);
	}

	#setModuleDependencies(modulePath: string, deps: Set<string>): void {
		const previousDeps = this.#moduleDeps.get(modulePath);
		if (previousDeps) {
			for (const dep of previousDeps) {
				const parents = this.#moduleParents.get(dep);
				if (!parents) continue;
				parents.delete(modulePath);
				if (parents.size === 0) this.#moduleParents.delete(dep);
			}
		}
		this.#moduleDeps.set(modulePath, new Set(deps));
		for (const dep of deps) {
			const parents = this.#moduleParents.get(dep) ?? new Set<string>();
			parents.add(modulePath);
			this.#moduleParents.set(dep, parents);
		}
	}
}

function buildRequire(fromPath: string): NodeJS.Require {
	const basePath = path.extname(fromPath) ? fromPath : path.join(fromPath, "[eval]");
	return createRequire(pathToFileURL(basePath).href);
}

function buildModuleSource(source: string, modulePath: string): string {
	const moduleDir = path.dirname(modulePath);
	return [
		`const require = globalThis.__omp_get_require__(${JSON.stringify(pathToFileURL(modulePath).href)});`,
		`const __filename = ${JSON.stringify(modulePath)};`,
		`const __dirname = ${JSON.stringify(moduleDir)};`,
		source,
	].join("\n");
}

function resolveImportSpecifier(cwd: string, source: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
	try {
		return Bun.resolveSync(source, cwd);
	} catch {
		return source;
	}
}

function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}

function isTypeScriptModulePath(modulePath: string): boolean {
	const ext = path.extname(modulePath);
	return ext === ".ts" || ext === ".tsx" || ext === ".mts";
}

function stripLoaderForPath(modulePath: string): "ts" | "tsx" {
	return path.extname(modulePath) === ".tsx" ? "tsx" : "ts";
}

function isManagedLocalModulePath(target: string): boolean {
	return (
		path.isAbsolute(target) &&
		LOCAL_MODULE_EXTENSIONS.has(path.extname(target)) &&
		!target.includes(`${path.sep}node_modules${path.sep}`)
	);
}

function normalizeImportTarget(target: string): string {
	if (path.isAbsolute(target)) return pathToFileURL(target).href;
	return target;
}

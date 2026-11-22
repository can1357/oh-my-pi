/**
 * Groups the npm bundle's code-split scripts by which kinds of omp process load them.
 *
 * Bun splits at every dynamic `import()`, leaving thousands of scripts, and a process that loads hundreds
 * of them commits far more memory than one that loads a single file (Bun reads each script on its thread
 * pool). One script per module group keeps each worker to the code it runs while a session still loads
 * only a handful of files:
 *
 * - Modules the profile (`bundle-profile.json`, written by `scripts/bundle-profile.ts`) names are grouped
 *   by the exact set of roles (session, daemon, JS eval worker, …) that loaded them, so no role parses
 *   code that only other roles use. Groups under {@link MIN_GROUP_BYTES} join a group whose roles are a
 *   superset of theirs.
 * - Other modules are grouped by the roles whose code can reach them, then split by directory into
 *   groups of at most {@link MAX_UNPROFILED_GROUP_BYTES}, so a rarely used feature loads only its
 *   neighbourhood. A stale profile therefore costs memory, never correctness.
 *
 * {@link groupedChunksPlugins} makes Bun emit that layout by rewriting `import("x")`. Within a group it
 * becomes a `require` (inlined into the group's script with `splitRequire: false`, and still evaluated on
 * first use); across groups it loads the target group's facade module, the group's only split point.
 * Facades also import the facades of groups their group statically depends on, so Bun keeps each
 * group's code in one script instead of splitting it by every combination of importers.
 */
import * as path from "node:path";

const repoDir = path.join(import.meta.dir, "../../..");

/** Roles (kinds of omp process or worker thread) that load each module; written by `scripts/bundle-profile.ts`. */
export const profilePath = path.join(import.meta.dir, "bundle-profile.json");

export interface BundleProfile {
	/** Module key ({@link bundleModuleKey}) → roles that loaded it. */
	modules: Record<string, string[]>;
}

/** Smaller groups join a group whose roles are a superset of theirs. */
const MIN_GROUP_BYTES = 64 * 1024;
/** Largest group of modules the profile does not name, unless one directory alone is larger. */
const MAX_UNPROFILED_GROUP_BYTES = 1024 * 1024;
const FACADE_NAMESPACE = "omp-bundle-group";
const DYNAMIC_IMPORT = /(?<![\w$.])import\(\s*(["'])([^"'\\\n]+)\1\s*\)/g;
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/;

/**
 * Machine-independent id of a bundled module: its repo-relative path, keeping a plugin namespace
 * (`omp-legacy-pi-modules-build:…`). Takes a metafile input path, which Bun makes relative to the
 * working directory, or an absolute path.
 */
export function bundleModuleKey(file: string): string {
	const namespaced = /^([a-z][\w-]+):(.+)$/i.exec(file);
	const [prefix, location] = namespaced ? [`${namespaced[1]}:`, namespaced[2]] : ["", path.resolve(file)];
	if (!path.isAbsolute(location)) return file;
	return prefix + path.relative(repoDir, location).replaceAll("\\", "/");
}

export interface ModuleGraph {
	/** Minified bytes of each module. */
	bytes: Map<string, number>;
	/** Modules each module imports statically or `require`s. */
	deps: Map<string, Set<string>>;
	/** `import()` targets of each module, by the specifier as written. */
	dynamicImports: Map<string, Map<string, string>>;
}

/** Reads the module graph from the metafile of a build split at every `import()` and `require()`. */
export function readModuleGraph(metafile: Bun.BuildMetafile): ModuleGraph {
	const bytes = new Map<string, number>();
	const entryOfScript = new Map<string, string>();
	for (const [output, info] of Object.entries(metafile.outputs)) {
		for (const [input, { bytesInOutput }] of Object.entries(info.inputs)) {
			const key = bundleModuleKey(input);
			bytes.set(key, (bytes.get(key) ?? 0) + bytesInOutput);
		}
		if (info.entryPoint) entryOfScript.set(`./${path.basename(output)}`, bundleModuleKey(info.entryPoint));
	}
	const deps = new Map<string, Set<string>>();
	const dynamicImports = new Map<string, Map<string, string>>();
	for (const [input, info] of Object.entries(metafile.inputs)) {
		const moduleDeps = new Set<string>();
		const moduleImports = new Map<string, string>();
		for (const record of info.imports) {
			// A split point names the target's script; other bundled imports name the module.
			const target = record.external ? entryOfScript.get(record.path) : bundleModuleKey(record.path);
			if (!target) continue;
			if (record.kind !== "dynamic-import") moduleDeps.add(target);
			else if (record.original) moduleImports.set(record.original, target);
		}
		const key = bundleModuleKey(input);
		// Inputs the pre-pass tree-shook entirely still need a group.
		if (!bytes.has(key)) bytes.set(key, 0);
		deps.set(key, moduleDeps);
		if (moduleImports.size > 0) dynamicImports.set(key, moduleImports);
	}
	return { bytes, deps, dynamicImports };
}

/** Assigns every module of `graph` to a named group. */
export function planGroups(graph: ModuleGraph, profile: BundleProfile): Map<string, string> {
	const allRoles = [...new Set(Object.values(profile.modules).flat())].sort();
	const roleSetName = (roles: Iterable<string>): string => {
		const sorted = [...new Set(roles)].sort();
		return sorted.length === allRoles.length ? "all" : sorted.join("-");
	};
	const rolesOfGroup = new Map<string, string[]>();
	const groupOf = new Map<string, string>();
	const groupBytes = new Map<string, number>();
	const assign = (module: string, group: string): void => {
		groupOf.set(module, group);
		groupBytes.set(group, (groupBytes.get(group) ?? 0) + (graph.bytes.get(module) ?? 0));
	};
	for (const [module, roles] of Object.entries(profile.modules)) {
		if (!graph.bytes.has(module)) continue;
		const group = roleSetName(roles);
		rolesOfGroup.set(group, [...new Set(roles)].sort());
		assign(module, group);
	}

	// Fold small groups into the superset group with the fewest extra roles (then the largest).
	for (;;) {
		const small = [...groupBytes]
			.filter(([, bytes]) => bytes < MIN_GROUP_BYTES)
			.sort((a, b) => a[1] - b[1])
			.map(([group]) => group)
			.find(group => findSuperset(group) !== undefined);
		if (small === undefined) break;
		const into = findSuperset(small)!;
		for (const [module, group] of groupOf) if (group === small) assign(module, into);
		groupBytes.delete(small);
		rolesOfGroup.delete(small);
	}
	function findSuperset(group: string): string | undefined {
		const roles = rolesOfGroup.get(group)!;
		let best: string | undefined;
		for (const [candidate, candidateRoles] of rolesOfGroup) {
			if (candidate === group || !roles.every(role => candidateRoles.includes(role))) continue;
			if (
				best === undefined ||
				candidateRoles.length < rolesOfGroup.get(best)!.length ||
				(candidateRoles.length === rolesOfGroup.get(best)!.length &&
					groupBytes.get(candidate)! > groupBytes.get(best)!)
			) {
				best = candidate;
			}
		}
		return best;
	}

	// Unprofiled modules: the roles whose profiled code can reach them, through other unprofiled modules.
	const reachingRoles = new Map<string, Set<string>>();
	for (const [module, group] of groupOf) {
		const roles = rolesOfGroup.get(group)!;
		const stack = [...successors(module)].filter(next => !groupOf.has(next));
		while (stack.length > 0) {
			const next = stack.pop()!;
			let reached = reachingRoles.get(next);
			if (!reached) reachingRoles.set(next, (reached = new Set()));
			const before = reached.size;
			for (const role of roles) reached.add(role);
			if (reached.size === before && before > 0) continue;
			for (const after of successors(next)) if (!groupOf.has(after)) stack.push(after);
		}
	}
	function successors(module: string): Iterable<string> {
		return [...(graph.deps.get(module) ?? []), ...(graph.dynamicImports.get(module)?.values() ?? [])];
	}
	const byRoles = new Map<string, Map<string, string[]>>();
	for (const module of graph.bytes.keys()) {
		if (groupOf.has(module)) continue;
		const roles = roleSetName(reachingRoles.get(module) ?? allRoles);
		// Neighbourhood: the module's directory, at most four segments deep.
		const directory = path.posix.dirname(module).split("/").slice(0, 4).join("/");
		let directories = byRoles.get(roles);
		if (!directories) byRoles.set(roles, (directories = new Map()));
		directories.get(directory)?.push(module) ?? directories.set(directory, [module]);
	}
	for (const [roles, directories] of byRoles) {
		const bins: { bytes: number; modules: string[] }[] = [];
		const sized = [...directories.values()].map(modules => ({
			modules,
			bytes: modules.reduce((sum, module) => sum + (graph.bytes.get(module) ?? 0), 0),
		}));
		for (const directory of sized.sort((a, b) => b.bytes - a.bytes)) {
			const bin = bins.find(candidate => candidate.bytes + directory.bytes <= MAX_UNPROFILED_GROUP_BYTES);
			if (bin) {
				bin.bytes += directory.bytes;
				bin.modules.push(...directory.modules);
			} else {
				bins.push({ ...directory, modules: [...directory.modules] });
			}
		}
		bins.forEach((bin, index) => {
			for (const module of bin.modules) assign(module, `lazy-${roles}-${index + 1}`);
		});
	}
	return groupOf;
}

function loaderFor(file: string): Bun.JavaScriptLoader {
	if (/\.[cm]?tsx$/.test(file)) return "tsx";
	if (/\.[cm]?ts$/.test(file)) return "ts";
	if (file.endsWith(".jsx")) return "jsx";
	return "js";
}

/**
 * Returns the build's plugins plus the grouping plugin, rewriting the `import()`s of the build so Bun
 * emits one script per group of `groupOf`. The given plugins' `onLoad` results (virtual modules such as
 * the legacy Pi module registry) are rewritten too.
 */
export function groupedChunksPlugins(
	graph: ModuleGraph,
	groupOf: Map<string, string>,
	profile: BundleProfile,
	config: { entrypoints: string[]; plugins: Bun.BunPlugin[]; files?: Record<string, unknown> },
): Bun.BunPlugin[] {
	// Plugin namespaces and the build's `files` overrides cannot be `require`d by path (a required
	// override loads as a second module), so their import()s stay ordinary split points.
	const overridden = new Set(Object.keys(config.files ?? {}).map(bundleModuleKey));
	// The entry module stays the entry script's own code: `require`d, it would become a lazily
	// initialized module in a shared script, where `import.meta.main` no longer holds. Its group is
	// loaded before anything else, so import()s of the group's other modules are `require`d in place.
	const entry = bundleModuleKey(config.entrypoints[0]);
	const entryGroup = groupOf.get(entry);
	const modulePath = (module: string): string | undefined =>
		/^[a-z][\w-]+:/i.test(module) || overridden.has(module) || module === entry
			? undefined
			: path.join(repoDir, module);
	const inPlace = (importer: string, target: string): boolean =>
		groupOf.get(target) === groupOf.get(importer) || groupOf.get(target) === entryGroup;
	// Each group's modules that other groups import(): its facade's `modules` array, in a stable order.
	const facadeModules = new Map<string, string[]>();
	const facadeIndex = new Map<string, number>();
	const addToFacade = (group: string, module: string): void => {
		if (facadeIndex.has(module)) return;
		let modules = facadeModules.get(group);
		if (!modules) facadeModules.set(group, (modules = []));
		facadeIndex.set(module, modules.push(module) - 1);
	};
	for (const [importer, imports] of [...graph.dynamicImports].sort(([a], [b]) => a.localeCompare(b))) {
		for (const target of imports.values()) {
			if (!inPlace(importer, target) && modulePath(target)) addToFacade(groupOf.get(target)!, target);
		}
	}
	// A group that statically imports or requires another group's modules imports that group's facade,
	// which lists those modules too. Bun then sees that loading the group loads the other, and keeps
	// each group's code in its own script instead of splitting it by every combination of importers.
	const facadeImports = new Map<string, Set<string>>();
	for (const [module, deps] of [...graph.deps].sort(([a], [b]) => a.localeCompare(b))) {
		const group = groupOf.get(module)!;
		const roles = profile.modules[module];
		for (const dep of deps) {
			const depGroup = groupOf.get(dep)!;
			if (depGroup === group || depGroup === entryGroup || group === entryGroup || !modulePath(dep)) continue;
			// Text, Markdown, and other assets load with their import's attributes; `require`d from a
			// facade they would load a second time under the default loader (Markdown as HTML).
			if (!SCRIPT_MODULE.test(dep)) continue;
			// The metafile keeps imports the transpiler drops (type-only uses) and `require`s that never
			// ran. When the profile shows a role ran the importer without loading the dependency, the edge
			// would only tie groups together, eventually into one script.
			if (roles && !roles.every(role => profile.modules[dep]?.includes(role))) continue;
			addToFacade(depGroup, dep);
			let imported = facadeImports.get(group);
			if (!imported) facadeImports.set(group, (imported = new Set()));
			imported.add(depGroup);
		}
	}

	function rewrite(importer: string, text: string, loader: Bun.JavaScriptLoader): string {
		const imports = graph.dynamicImports.get(importer);
		if (!imports) return text;
		const replacements = new Map<string, string>();
		for (const [specifier, target] of imports) {
			const file = modulePath(target);
			if (!file) continue;
			const group = groupOf.get(target)!;
			// The resolved path: a package's `exports` may offer no `require` condition.
			replacements.set(
				specifier,
				inPlace(importer, target)
					? `Promise.resolve().then(() => require(${JSON.stringify(file)}))`
					: `import(${JSON.stringify(`${FACADE_NAMESPACE}:${group}`)}).then(group => group.modules[${facadeIndex.get(target)}]())`,
			);
		}
		// The transpiler rejects a shebang; as a comment it keeps line numbers, and `bundleDist`
		// restores cli.js's own.
		const source = text.startsWith("#!") ? `//${text.slice(2)}` : text;
		// Rewrite a specifier only where every textual `import("…")` of it is a real dynamic import
		// (not inside a string or comment); the rest stay ordinary split points.
		const real = new Map<string, number>();
		for (const record of new Bun.Transpiler({ loader }).scanImports(source)) {
			if (record.kind === "dynamic-import") real.set(record.path, (real.get(record.path) ?? 0) + 1);
		}
		const textual = new Map<string, number>();
		for (const match of source.matchAll(DYNAMIC_IMPORT)) textual.set(match[2], (textual.get(match[2]) ?? 0) + 1);
		return source.replace(DYNAMIC_IMPORT, (call, _quote, specifier: string) => {
			const replacement = replacements.get(specifier);
			return replacement !== undefined && textual.get(specifier) === real.get(specifier) ? replacement : call;
		});
	}

	const wrapped = config.plugins.map((plugin): Bun.BunPlugin => ({
		...plugin,
		setup(build) {
			const onLoad: Bun.PluginBuilder["onLoad"] = (constraints, callback) =>
				build.onLoad(constraints, async args => {
					const result = await callback(args);
					if (!result || !("contents" in result) || typeof result.contents !== "string") return result;
					const loader = result.loader ?? loaderFor(args.path);
					if (loader !== "js" && loader !== "jsx" && loader !== "ts" && loader !== "tsx") return result;
					const importer = bundleModuleKey(
						args.namespace === "file" ? args.path : `${args.namespace}:${args.path}`,
					);
					return { ...result, contents: rewrite(importer, result.contents, loader) };
				});
			const proxy = new Proxy(build, {
				get(target, key) {
					if (key === "onLoad") return onLoad;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			return plugin.setup(proxy);
		},
	}));
	const grouping: Bun.BunPlugin = {
		name: "grouped-chunks",
		setup(build) {
			build.onResolve({ filter: new RegExp(`^${FACADE_NAMESPACE}:`) }, args => ({
				path: args.path.slice(FACADE_NAMESPACE.length + 1),
				namespace: FACADE_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: FACADE_NAMESPACE }, args => {
				const imports = [...(facadeImports.get(args.path) ?? [])]
					.filter(group => facadeModules.has(group))
					.map(group => `import ${JSON.stringify(`${FACADE_NAMESPACE}:${group}`)};\n`);
				const modules = (facadeModules.get(args.path) ?? []).map(
					module => `\t() => require(${JSON.stringify(modulePath(module))}),\n`,
				);
				return { contents: `${imports.join("")}export const modules = [\n${modules.join("")}];\n`, loader: "js" };
			});
			build.onLoad({ filter: SCRIPT_MODULE }, async args => {
				const importer = bundleModuleKey(args.path);
				if (!graph.dynamicImports.has(importer)) return undefined;
				const loader = loaderFor(args.path);
				return { contents: rewrite(importer, await Bun.file(args.path).text(), loader), loader };
			});
		},
	};
	return [...wrapped, grouping];
}

/**
 * Groups the npm bundle's code-split scripts by which kinds of omp process load them.
 *
 * Bun splits at every dynamic `import()`, leaving thousands of scripts, and a process that loads hundreds
 * of them commits far more memory than one that loads a single file (Bun reads each script on its thread
 * pool). Grouping modules by the processes that load them keeps each worker close to the code it runs
 * while a session still loads only a handful of files:
 *
 * - Modules the profile (`bundle-profile.json`, written by `scripts/bundle-profile.ts`) names are grouped
 *   by the exact set of roles (session, daemon, JS eval worker, …) that loaded them. Groups under
 *   {@link MIN_GROUP_BYTES} join a group whose roles are a superset of theirs, so a role may parse a
 *   little code it did not load.
 * - Other modules are grouped by the roles whose code can reach them, then split by directory into
 *   groups of at most {@link MAX_UNPROFILED_GROUP_BYTES}, so a rarely used feature loads only its
 *   neighbourhood. A stale profile therefore costs memory, never correctness.
 *
 * {@link buildGroupedBundle} makes Bun emit that layout by rewriting `import("x")` of ES modules. Into the
 * same group (or the entry's, which every process has loaded) it becomes a `require`, inlined into the
 * group's script with `splitRequire: false` and still evaluated on first use. Into another group it
 * loads that group's facade module, the group's only split point. Facades also import the facades of
 * groups their group statically depends on, so Bun keeps each group's code together instead of splitting
 * it by every combination of importers; Bun still adds a few small shared chunks.
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
/** A literal `import("…")`/`import('…')` call; group 1 is the string literal, escapes included. */
const DYNAMIC_IMPORT = /(?<![\w$.])import\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/g;
const PROBE_SPECIFIER = "omp-bundle-probe:";

/**
 * Machine-independent id of a bundled module: its repo-relative path, keeping a plugin namespace
 * (`omp-legacy-pi-modules-build:…`). Takes a metafile input path, which Bun makes relative to the
 * working directory (`../../C:/…` for a file on another Windows drive), or an absolute path.
 */
export function bundleModuleKey(file: string): string {
	const namespaced = /^([a-z][\w-]+):(.+)$/i.exec(file);
	const otherDrive = /^(?:\.\.[\\/])+([a-z]:[\\/].*)$/i.exec(file)?.[1];
	const [prefix, location] = namespaced
		? [`${namespaced[1]}:`, namespaced[2]]
		: ["", otherDrive ?? path.resolve(file)];
	if (!path.isAbsolute(location)) return file;
	return prefix + path.relative(repoDir, location).replaceAll("\\", "/");
}

interface ModuleGraph {
	/** Minified bytes of each module. */
	bytes: Map<string, number>;
	/** Modules each module imports statically or `require`s. */
	deps: Map<string, Set<string>>;
	/** `import()` targets of each module, by the specifier as written. */
	dynamicImports: Map<string, Map<string, string>>;
	/** Module format Bun detected. */
	formats: Map<string, string>;
}

/** Reads the module graph from the metafile of a build split at every `import()` and `require()`. */
function readModuleGraph(metafile: Bun.BuildMetafile): ModuleGraph {
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
	const formats = new Map<string, string>();
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
		// Inputs the graph build tree-shook entirely still need a group.
		if (!bytes.has(key)) bytes.set(key, 0);
		deps.set(key, moduleDeps);
		if (moduleImports.size > 0) dynamicImports.set(key, moduleImports);
		if (info.format) formats.set(key, info.format);
	}
	return { bytes, deps, dynamicImports, formats };
}

/** Assigns every module of `graph` to a named group. */
function planGroups(graph: ModuleGraph, profile: BundleProfile): Map<string, string> {
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
	for (const module of [...graph.bytes.keys()].sort()) {
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

/** The value of a JavaScript string literal, or `undefined` for escapes JSON cannot read. */
function stringLiteralValue(literal: string): string | undefined {
	const body = literal.slice(1, -1);
	const json = literal.startsWith('"') ? body : body.replaceAll("\\'", "'").replaceAll('"', '\\"');
	try {
		return JSON.parse(`"${json}"`);
	} catch {
		return undefined;
	}
}

/** Build settings `buildGroupedBundle` reads besides passing them through. */
export interface GroupableBuildConfig extends Bun.BuildConfig {
	entrypoints: string[];
	plugins: Bun.BunPlugin[];
}

interface GroupedChunksInput {
	graph: ModuleGraph;
	groupOf: Map<string, string>;
	profile: BundleProfile;
	config: GroupableBuildConfig;
	/** Modules Bun reported awaiting at their top level, which no `require` can load. */
	topLevelAwait: ReadonlySet<string>;
}

/**
 * Returns the build's plugins plus the grouping plugin, rewriting the `import()`s of the build so Bun
 * emits the groups of `groupOf`. The given plugins' `onLoad` results (virtual modules such as the legacy
 * Pi module registry) are rewritten too.
 */
function groupedChunksPlugins({ graph, groupOf, profile, config, topLevelAwait }: GroupedChunksInput): Bun.BunPlugin[] {
	// Plugin namespaces and the build's `files` overrides cannot be `require`d by path (a required
	// override loads as a second module), so their import()s stay ordinary split points.
	const overridden = new Set(Object.keys(config.files ?? {}).map(bundleModuleKey));
	// The entry module stays the entry script's own code: `require`d, it would become a lazily
	// initialized module in a shared script, where `import.meta.main` no longer holds. Its group is
	// loaded before anything else, so import()s of the group's other modules are `require`d in place.
	const entry = bundleModuleKey(config.entrypoints[0]);
	const entryGroup = groupOf.get(entry);
	const modulePath = (module: string): string | undefined => {
		if (/^[a-z][\w-]+:/i.test(module) || overridden.has(module) || module === entry) return undefined;
		return path.isAbsolute(module) ? module : path.join(repoDir, module);
	};
	// No `require` can load a module that awaits at its top level, or one that statically imports it.
	const importersOf = new Map<string, string[]>();
	for (const [module, deps] of graph.deps) {
		for (const dep of deps) importersOf.get(dep)?.push(module) ?? importersOf.set(dep, [module]);
	}
	const awaits = new Set(topLevelAwait);
	const pending = [...awaits];
	while (pending.length > 0) {
		for (const importer of importersOf.get(pending.pop()!) ?? []) {
			if (awaits.has(importer)) continue;
			awaits.add(importer);
			pending.push(importer);
		}
	}
	// `require` returns what `import()` resolves to only for an ES module: `import()` wraps CommonJS
	// and JSON in a `default` export.
	const requirable = (module: string): boolean =>
		graph.formats.get(module) === "esm" && !awaits.has(module) && modulePath(module) !== undefined;
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
	for (const importer of [...graph.dynamicImports.keys()].sort()) {
		for (const target of graph.dynamicImports.get(importer)!.values()) {
			if (!inPlace(importer, target) && requirable(target)) addToFacade(groupOf.get(target)!, target);
		}
	}
	// A group that statically imports or requires another group's modules imports that group's facade,
	// which lists those modules too. Bun then sees that loading the group loads the other, and keeps
	// each group's code together instead of splitting it by every combination of importers.
	const facadeImports = new Map<string, Set<string>>();
	for (const module of [...graph.deps.keys()].sort()) {
		const group = groupOf.get(module)!;
		const roles = profile.modules[module];
		for (const dep of graph.deps.get(module)!) {
			const depGroup = groupOf.get(dep)!;
			if (depGroup === group || depGroup === entryGroup || group === entryGroup || !requirable(dep)) continue;
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
		// The transpiler rejects a shebang; as a comment it keeps line numbers, and `bundleDist`
		// restores cli.js's own.
		const source = text.startsWith("#!") ? `//${text.slice(2)}` : text;
		const calls = [...source.matchAll(DYNAMIC_IMPORT)].map(match => {
			const target = imports.get(stringLiteralValue(match[1]) ?? "");
			return { match, target: target !== undefined && requirable(target) ? target : undefined };
		});
		if (!calls.some(call => call.target)) return source;
		// Text that only looks like a call (inside a string, template, or comment) must stay as it is:
		// give every candidate a probe specifier and keep those the parser reports as real imports.
		let probed = "";
		let end = 0;
		calls.forEach(({ match, target }, index) => {
			if (!target) return;
			const quote = match[1][0];
			probed += `${source.slice(end, match.index)}import(${quote}${PROBE_SPECIFIER}${index}${quote})`;
			end = match.index + match[0].length;
		});
		probed += source.slice(end);
		const real = new Set(
			new Bun.Transpiler({ loader })
				.scanImports(probed)
				.filter(record => record.kind === "dynamic-import")
				.map(record => record.path),
		);
		let rewritten = "";
		end = 0;
		calls.forEach(({ match, target }, index) => {
			if (!target || !real.has(`${PROBE_SPECIFIER}${index}`)) return;
			const group = groupOf.get(target)!;
			// The resolved path: a package's `exports` may offer no `require` condition.
			const load = inPlace(importer, target)
				? `Promise.resolve().then(() => require(${JSON.stringify(modulePath(target))}))`
				: `import(${JSON.stringify(`${FACADE_NAMESPACE}:${group}`)}).then(group => group.modules[${facadeIndex.get(target)}]())`;
			rewritten += source.slice(end, match.index) + load;
			end = match.index + match[0].length;
		});
		return rewritten + source.slice(end);
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
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
				const importer = bundleModuleKey(args.path);
				if (!graph.dynamicImports.has(importer)) return undefined;
				const loader = loaderFor(args.path);
				return { contents: rewrite(importer, await Bun.file(args.path).text(), loader), loader };
			});
		},
	};
	return [...wrapped, grouping];
}

/** Modules Bun reported awaiting at their top level when a `require` reached them. */
function topLevelAwaitModules(logs: Bun.BuildOutput["logs"]): string[] {
	return logs.flatMap(log => {
		if (!log.message.includes("contains a top-level await")) return [];
		// Bun's typings omit `notes`; the last one points at the await itself.
		const { notes } = log as unknown as { notes?: { position?: { file?: string } | null }[] };
		const file = notes?.at(-1)?.position?.file;
		return file ? [bundleModuleKey(file)] : [];
	});
}

/**
 * Builds `config` code-split by the groups planned from its own module graph and `profile`. The module
 * graph comes from the same build split at every `import()` and `require()`, kept in memory. Failed
 * builds are returned for the caller to report.
 */
export async function buildGroupedBundle(
	config: GroupableBuildConfig,
	profile: BundleProfile,
): Promise<Bun.BuildOutput> {
	const { outdir: _outdir, ...inMemory } = config;
	const graphBuild = await Bun.build({ ...inMemory, splitting: true, metafile: true, throw: false });
	if (!graphBuild.success || !graphBuild.metafile) return graphBuild;
	const graph = readModuleGraph(graphBuild.metafile);
	const groupOf = planGroups(graph, profile);
	const topLevelAwait = new Set<string>();
	for (;;) {
		const output = await Bun.build({
			...config,
			plugins: groupedChunksPlugins({ graph, groupOf, profile, config, topLevelAwait }),
			splitting: true,
			// Same-group import()s become require()s, which must stay in their group's script.
			splitRequire: false,
			throw: false,
		});
		// Each build that fails this way names more such modules; their import()s stay native.
		const found = output.success
			? []
			: topLevelAwaitModules(output.logs).filter(module => !topLevelAwait.has(module));
		if (found.length === 0) return output;
		for (const module of found) topLevelAwait.add(module);
	}
}

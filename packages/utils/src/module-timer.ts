/**
 * Module-load timing preload.
 *
 * `bun --preload .../module-timer.ts <entry>` installs Bun plugin hooks (only
 * when `PI_TIMING` is set) that record an inclusive module window plus resolved
 * static child edges:
 *
 *   onLoad start → appended end marker after the module's top-level body
 *
 * Events are pushed into a process-global buffer that {@link logger.printTimings}
 * drains and renders as a module DAG/tree. Each module row can therefore show
 * both total time and `self` time after subtracting child module intervals.
 *
 * Why a preload (and not a normal import): Bun reads the *entire* statically
 * reachable graph before evaluating any module, so hooks installed from inside
 * that graph cannot observe its own loading — they only catch later dynamically
 * loaded modules. A preload runs first, so it sees the static-import phase that
 * dominates startup.
 *
 * Kept dependency-free on purpose: the sole import is Bun's `plugin`, so this is
 * cheap to preload before pi-utils (and winston) exist. The buffer is shared with
 * the logger via a registry Symbol so neither side needs to import the other.
 *
 * **What is measured:** an inclusive per-module window. `onLoad` stamps the
 * start before reading source; the returned source has a tiny marker appended at
 * the end of the module. That marker runs after Bun parses/transpiles the module
 * and after any top-level await in that module completes, so the duration
 * includes read + parse/transpile + dependency wait + top-level execution/TLA.
 * If a module throws before its final statement, no end marker is recorded.
 *
 * **Tree shape:** `onResolve` observes importer → specifier edges and resolves
 * them with `Bun.resolveSync` without taking over Bun's real resolution. The
 * logger renders these edges as a DAG/tree and computes module `self` time by
 * subtracting the union of child intervals, avoiding misleading flat inclusive
 * totals.
 *
 * **Coverage limits:**
 * - TS/TSX only — intercepting `node_modules` CJS `.js`/`.cjs` and forcing ESM
 *   breaks their default-export detection, so they are left to Bun's default path.
 * - **Dev runs only.** In the compiled `omp` binary every module is pre-bundled
 *   into bunfs, so `onLoad` never fires; profile with a `bun --preload` dev run.
 */
import { plugin } from "bun";
import { moduleLoadBuffer } from "./timing-buffer";

// Restrict to TS/TSX only. node_modules ships CommonJS `.js`/`.cjs` that Bun
// auto-detects when loaded via its default path; if we intercept and return
// `{ contents, loader: "js" }`, Bun forces ESM and CJS modules fail to load
// (e.g. `Missing 'default' export`). Our own source tree (where the interesting
// timing lives) is uniformly TypeScript, so a TS-only filter is both safe and
// sufficient.
const MODULE_LOADER_FILTER = /\.[mc]?tsx?$/;
const MODULE_COMPLETE_KEY: symbol = Symbol.for("omp.moduleLoadComplete");
const MODULE_BODY_START_KEY: symbol = Symbol.for("omp.moduleBodyStart");
const STATIC_IMPORT_PATTERN =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

type CompleteStore = Record<symbol, ((path: string) => void) | undefined>;

function bodyStartMarker(path: string): string {
	return `;globalThis[Symbol.for("omp.moduleBodyStart")]?.(${JSON.stringify(path)});\n`;
}

function completionMarker(path: string): string {
	return `\n;globalThis[Symbol.for("omp.moduleLoadComplete")]?.(${JSON.stringify(path)});\n`;
}

function instrumentContents(path: string, contents: string): string {
	const start = bodyStartMarker(path);
	const end = completionMarker(path);
	if (!contents.startsWith("#!")) return `${start}${contents}${end}`;
	const newline = contents.indexOf("\n");
	if (newline === -1) return `${contents}\n${start}${end}`;
	return `${contents.slice(0, newline + 1)}${start}${contents.slice(newline + 1)}${end}`;
}
function importerDir(importer: string): string {
	const slash = importer.lastIndexOf("/");
	if (slash === -1) return ".";
	return importer.slice(0, slash);
}

function childSetFor(importsByPath: Map<string, Set<string>>, path: string): Set<string> {
	let children = importsByPath.get(path);
	if (!children) {
		children = new Set<string>();
		importsByPath.set(path, children);
	}
	return children;
}

function addImportEdges(importsByPath: Map<string, Set<string>>, importer: string, contents: string): void {
	STATIC_IMPORT_PATTERN.lastIndex = 0;
	for (const match of contents.matchAll(STATIC_IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (!specifier) continue;
		try {
			const resolved = Bun.resolveSync(specifier, importerDir(importer));
			if (MODULE_LOADER_FILTER.test(resolved) && resolved !== importer) {
				childSetFor(importsByPath, importer).add(resolved);
			}
		} catch {
			// Leave Bun's real resolver/runtime to surface any error. This scanner is only an observer.
		}
	}
}

if (process.env.PI_TIMING) {
	const buffer = moduleLoadBuffer();
	const starts = new Map<string, number>();
	const bodyStarts = new Map<string, number>();
	const importsByPath = new Map<string, Set<string>>();
	const store = globalThis as unknown as CompleteStore;
	store[MODULE_BODY_START_KEY] = (path: string): void => {
		bodyStarts.set(path, performance.now());
	};
	store[MODULE_COMPLETE_KEY] = (path: string): void => {
		const start = starts.get(path);
		if (start === undefined) return;
		starts.delete(path);
		const end = performance.now();
		const bodyStart = bodyStarts.get(path);
		bodyStarts.delete(path);
		const imports = importsByPath.get(path);
		buffer.push({
			path,
			start,
			durationMs: end - start,
			bodyMs: bodyStart === undefined ? undefined : end - bodyStart,
			imports: imports ? [...imports] : [],
		});
	};

	plugin({
		name: "pi-module-load-timer",
		setup(build) {
			build.onLoad({ filter: MODULE_LOADER_FILTER }, async args => {
				starts.set(args.path, performance.now());
				childSetFor(importsByPath, args.path);
				const contents = await Bun.file(args.path).text();
				addImportEdges(importsByPath, args.path, contents);
				return {
					contents: instrumentContents(args.path, contents),
					loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
				};
			});
		},
	});
}

import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getFastembedRuntimeDir,
	installRuntimeModuleResolver,
	logger,
	type RuntimeInstallSpec,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils";
import type * as Fastembed from "fastembed";
import packageManifest from "../../package.json" with { type: "json" };

type FastembedModule = typeof Fastembed;

/** Runtime install inputs for the optional fastembed embedding stack. */
export interface FastembedRuntimeInstallPlan {
	/** Cache directory key; changes when runtime resolution policy changes. */
	versionKey: string;
	/** Dependency graph written to the runtime cache package manifest. */
	install: RuntimeInstallSpec;
}

/**
 * `fastembed` is an optional peer (~270MB of native assets across platforms),
 * never bundled and never installed eagerly. When the direct import cannot
 * resolve — bundled `dist/cli.js`, compiled binary, a consumer that skipped the
 * optional peer, or a native loader failure — fastembed is `bun install`ed into
 * a per-version runtime cache on first use and loaded from there (#2389).
 *
 * The fastembed pin lives in `peerDependencies` as an exact version (not
 * `catalog:`) so this module reads a concrete spec even when the workspace
 * manifest is inlined into a bundle. The runtime install deliberately does not
 * override fastembed's `onnxruntime-node` dependency: the prebuilt native addon
 * links against that package's bundled ORT dylib/so/dll name.
 */
const FASTEMBED_SPEC = packageManifest.peerDependencies.fastembed;

/** Build the deterministic fastembed runtime install plan used by local embeddings. */
export function fastembedRuntimeInstallPlan(): FastembedRuntimeInstallPlan {
	return {
		versionKey: `fastembed-${FASTEMBED_SPEC}_transitive-ort`.replace(/[^A-Za-z0-9._-]/g, "_"),
		install: {
			dependencies: { fastembed: FASTEMBED_SPEC },
			trustedDependencies: ["onnxruntime-node"],
		},
	};
}
let fastembedLoad: Promise<FastembedModule> | null = null;

/** Inputs for selecting the Windows DLL directory paired with a fastembed installation. */
export interface WindowsFastembedRuntimeOptions {
	/** Resolved fastembed package entry whose dependency graph owns the ORT binding. */
	fastembedEntry: string;
	/** Directory containing fastembed's manifest and nested dependency graph. */
	fastembedPackageDir: string;
	/** Native architecture to select; defaults to the current process architecture. */
	arch?: string;
	/** Environment receiving the DLL search path; defaults to the subprocess environment. */
	env?: NodeJS.ProcessEnv;
}

/** The ORT module and DLL directory selected from fastembed's own dependency graph. */
export interface WindowsFastembedRuntime {
	/** Resolved entry for fastembed's own ONNX Runtime dependency. */
	ortEntry: string;
	/** Package directory containing the selected ORT manifest and native assets. */
	ortPackageDir: string;
	/** Directory prepended to `PATH` so Windows finds the paired native DLL. */
	dllDir: string;
}

/**
 * Prepend the ORT DLL directory paired with fastembed before Bun loads its
 * native binding. Compiled Windows binaries extract `.node` files to a
 * temporary directory, so the default DLL search can otherwise select an
 * unrelated `onnxruntime.dll` from the inherited system path.
 */
export async function prepareWindowsFastembedRuntime({
	fastembedEntry,
	fastembedPackageDir,
	arch = process.arch,
	env = process.env,
}: WindowsFastembedRuntimeOptions): Promise<WindowsFastembedRuntime> {
	const nestedNodeModules = path.join(fastembedPackageDir, "node_modules");
	const rootNodeModules = path.dirname(fastembedPackageDir);
	const nestedOrtEntry = resolveRuntimeModule(nestedNodeModules, "onnxruntime-node");
	const ortEntry = nestedOrtEntry ?? resolveRuntimeModule(rootNodeModules, "onnxruntime-node");
	const ortPackageDir = path.join(nestedOrtEntry ? nestedNodeModules : rootNodeModules, "onnxruntime-node");
	if (!ortEntry) {
		throw new Error(`Cannot find module onnxruntime-node beside ${fastembedEntry}`);
	}
	const dllGlob = new Bun.Glob(`bin/napi-*/win32/${arch}/onnxruntime.dll`);
	let dllDir: string | undefined;
	for await (const dll of dllGlob.scan({ cwd: ortPackageDir, absolute: true, onlyFiles: true })) {
		dllDir = path.dirname(dll);
		break;
	}
	if (!dllDir) {
		throw new Error(`Cannot find module onnxruntime-node Windows DLL for ${arch} beside ${ortEntry}`);
	}

	const currentPath = env.PATH;
	const normalizedDllDir = path.resolve(dllDir).toLowerCase();
	const alreadyPresent = currentPath
		?.split(path.delimiter)
		.some(entry => path.resolve(entry).toLowerCase() === normalizedDllDir);
	if (!alreadyPresent) env.PATH = currentPath ? `${dllDir}${path.delimiter}${currentPath}` : dllDir;
	return { ortEntry, ortPackageDir, dllDir };
}

export function loadFastembed(): Promise<FastembedModule> {
	fastembedLoad ??= loadFastembedOnce().catch(error => {
		fastembedLoad = null;
		throw error;
	});
	return fastembedLoad;
}

async function loadFastembedOnce(): Promise<FastembedModule> {
	try {
		const requireDirect = createRequire(import.meta.url);
		const manifestPath = requireDirect.resolve("fastembed/package.json");
		const manifest: { version?: unknown } = requireDirect(manifestPath);
		if (manifest.version !== FASTEMBED_SPEC) {
			throw new Error(`Cannot find package fastembed@${FASTEMBED_SPEC}; resolved ${String(manifest.version)}`);
		}
		return await loadResolvedFastembed(requireDirect.resolve("fastembed"), path.dirname(manifestPath));
	} catch (error) {
		if (!isRecoverableFastembedLoadError(error)) throw error;
		logger.debug("mnemopi: fastembed not loadable, using on-demand runtime install", {
			error: String(error),
		});
		return loadFromRuntimeInstall();
	}
}

async function loadResolvedFastembed(entry: string, fastembedPackageDir: string): Promise<FastembedModule> {
	const requireFastembed = createRequire(entry);
	if (process.platform === "win32") {
		const { ortEntry } = await prepareWindowsFastembedRuntime({ fastembedEntry: entry, fastembedPackageDir });
		requireFastembed(ortEntry);
	}
	const loaded: FastembedModule = requireFastembed(entry);
	return loaded;
}

async function loadFromRuntimeInstall(): Promise<FastembedModule> {
	const plan = fastembedRuntimeInstallPlan();
	const runtimeDir = await ensureRuntimeInstalled({
		runtimeDir: path.join(getFastembedRuntimeDir(), plan.versionKey),
		install: plan.install,
		probePackage: "fastembed",
	});
	const nodeModules = path.join(runtimeDir, "node_modules");
	// The compiled-binary resolver ignores `main`/`exports` for real-FS bare
	// specifiers (Bun #1763); route the runtime graph's requires (fastembed →
	// onnxruntime-node, @anush008/tokenizers → platform binding, …) through
	// the runtime cache.
	installRuntimeModuleResolver({ runtimeNodeModules: nodeModules });
	const entry = resolveRuntimeModule(nodeModules, "fastembed");
	if (!entry) throw new Error(`fastembed runtime install at ${runtimeDir} has no loadable entry`);
	return loadResolvedFastembed(entry, path.join(nodeModules, "fastembed"));
}

function isRecoverableFastembedLoadError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
	if (name === "ResolveMessage") return true;
	if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_DLOPEN_FAILED") return true;
	return typeof message === "string" && /cannot find (module|package)/i.test(message);
}

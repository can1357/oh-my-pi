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
 *
 * It does override `@anush008/tokenizers`: every fastembed release pins
 * `^0.0.0`, which resolves to a build without linux-arm64 bindings (#14083).
 * {@link TOKENIZERS_SPEC} keeps the identical JS API and adds them.
 */
const FASTEMBED_SPEC = packageManifest.peerDependencies.fastembed;

/** `@anush008/tokenizers` release with linux-arm64 gnu/musl bindings (added in 0.5.0). */
const TOKENIZERS_SPEC = "0.6.0";

/** Build the deterministic fastembed runtime install plan used by local embeddings. */
export function fastembedRuntimeInstallPlan(): FastembedRuntimeInstallPlan {
	return {
		versionKey: `fastembed-${FASTEMBED_SPEC}_transitive-ort_tokenizers-${TOKENIZERS_SPEC}`.replace(
			/[^A-Za-z0-9._-]/g,
			"_",
		),
		install: {
			dependencies: { fastembed: FASTEMBED_SPEC },
			overrides: { "@anush008/tokenizers": TOKENIZERS_SPEC },
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
		return await loadFastembedResolvedOrInstall();
	} catch (error) {
		throw describeFastembedLoadFailure(error);
	}
}

async function loadFastembedResolvedOrInstall(): Promise<FastembedModule> {
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

/**
 * System libraries the prebuilt `onnxruntime-node` addon links against but
 * never ships. Its `DT_RUNPATH` is `$ORIGIN/`, which covers the bundled ORT
 * library and nothing else, so the C++ runtime has to come from the loader's
 * own search path — absent on NixOS, minimal containers, and Alpine without
 * `gnu-compat`.
 */
const MISSING_SYSTEM_LIBRARY_RE =
	/\b(libstdc\+\+\.so(?:\.[0-9]+)*|libgcc_s\.so(?:\.[0-9]+)*)\b[^\n]*:\s*cannot open shared object file/iu;

/**
 * Every `message` along the `cause` chain. `dlopen` failures bury the loader's
 * own text (`libstdc++.so.6: cannot open shared object file`) one or more
 * levels down, so matching only the outermost message misses it.
 */
function loadFailureText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
		parts.push(current instanceof Error ? current.message : String(current));
		current = typeof current === "object" && "cause" in current ? current.cause : undefined;
	}
	return parts.join("\n");
}

/**
 * Actionable remedy for a fastembed load failure, or `undefined` when the
 * cause is not one omp can advise on. Mirrors `cudaFailureHint` for the
 * inference worker (#14346): without it the user only sees a loader string
 * that reads like a broken model download, and no model was ever fetched.
 */
export function fastembedLoadFailureHint(error: unknown): string | undefined {
	const missing = MISSING_SYSTEM_LIBRARY_RE.exec(loadFailureText(error))?.[1];
	if (missing === undefined) return undefined;
	return (
		`the host C++ runtime is not on the dynamic loader path; the prebuilt onnxruntime addon bundles only ` +
		`its own ORT library (DT_RUNPATH $ORIGIN), so ${missing} must come from the system. Install it ` +
		`(nixpkgs stdenv.cc / gnu-compat on Alpine) or point OMP_NATIVE_LIBRARY_PATH at a directory ` +
		`containing ${missing}.`
	);
}

/**
 * Attach {@link fastembedLoadFailureHint} to a failure that has one, keeping
 * the original loader text as the message prefix and as `cause`. Failures
 * without a known remedy are returned untouched so their messages stay
 * verbatim.
 */
export function describeFastembedLoadFailure(error: unknown): unknown {
	const hint = fastembedLoadFailureHint(error);
	if (hint === undefined) return error;
	const detail = error instanceof Error ? error.message : String(error);
	return new Error(`${detail} — ${hint}`, { cause: error });
}

/**
 * Whether re-running `bun install` of the same prebuilt addons could plausibly
 * fix this. A `dlopen` failure is not a missing install: the package resolved,
 * so the runtime cache holds the same broken addon and the ~270MB install
 * would fail identically (#14346). Only "not installed here" is recoverable.
 * @internal exported for tests
 */
export function isRecoverableFastembedLoadError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
	if (name === "ResolveMessage") return true;
	if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
	return typeof message === "string" && /cannot find (module|package)/i.test(message);
}

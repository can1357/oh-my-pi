import { createRequire } from "node:module";
import * as os from "node:os";
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
import type * as Ort from "onnxruntime-node";
import packageManifest from "../../package.json" with { type: "json" };

type FastembedModule = typeof Fastembed;
type OrtModule = typeof Ort;
type OrtSessionOptions = Ort.InferenceSession.SessionOptions;

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
/** The fastembed installation {@link loadFastembed} resolved, and the `require` that sees its dependency graph. */
let loadedFastembed: { entry: string; fastembedPackageDir: string; require: NodeRequire } | null = null;

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

/** The `onnxruntime-node` installation fastembed's own dependency graph loads: nested first, then the hoisted copy beside it. */
function resolveFastembedOrt(fastembedPackageDir: string): { ortEntry: string | null; ortPackageDir: string } {
	const nestedNodeModules = path.join(fastembedPackageDir, "node_modules");
	const rootNodeModules = path.dirname(fastembedPackageDir);
	const nestedOrtEntry = resolveRuntimeModule(nestedNodeModules, "onnxruntime-node");
	const ortEntry = nestedOrtEntry ?? resolveRuntimeModule(rootNodeModules, "onnxruntime-node");
	return {
		ortEntry,
		ortPackageDir: path.join(nestedOrtEntry ? nestedNodeModules : rootNodeModules, "onnxruntime-node"),
	};
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
	const { ortEntry, ortPackageDir } = resolveFastembedOrt(fastembedPackageDir);
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

/**
 * Upper bound on the intra-op thread pool of an embedding session.
 *
 * fastembed creates its ONNX session without any thread option, so
 * onnxruntime applies its own defaults: one intra-op thread per physical core,
 * with those threads spinning between operators. The real work of embedding a
 * recall query is about half a CPU-second (fastembed pads every text to the
 * model's maximum length), so on a many-core host most of what the default
 * pool burns beyond that is spin and scheduling. Measured on a 32-core host,
 * one short query cost 3.85 CPU-seconds and kept 31 cores busy for 124 ms;
 * with the budget below it costs 0.56 CPU-seconds and finishes in 178 ms, and its
 * vector points the same way (cosine 0.9999997 against the unbudgeted one;
 * `bench/embed-session-threads.bench.ts` measures and checks both).
 *
 * The cap is a trade, not a free win: on an otherwise idle many-core host a
 * single embedding finishes later (124 ms to 178 ms above, about 40% slower)
 * for about 7x less CPU. It is fixed because the default pool's cost
 * multiplies with every process embedding at the same time, while the extra
 * latency is tens of milliseconds per retain or recall.
 */
const EMBED_INTRA_OP_THREAD_CAP = 4;

/** Narrow an `extra` sub-object for merging; anything else is replaced wholesale. */
function extraSection(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Session options for one embedding session: a bounded intra-op pool, a single
 * inter-op thread, and no thread spinning. Every value the caller set wins,
 * including inside `extra.session`, so a consumer that tunes onnxruntime itself
 * keeps its own numbers.
 */
export function embedSessionOptions(base: OrtSessionOptions, parallelism: number): OrtSessionOptions {
	const extra = extraSection(base.extra);
	const session = extraSection(extra?.session);
	return {
		...base,
		intraOpNumThreads: base.intraOpNumThreads ?? Math.max(1, Math.min(EMBED_INTRA_OP_THREAD_CAP, parallelism)),
		interOpNumThreads: base.interOpNumThreads ?? 1,
		extra: {
			...extra,
			session: {
				...session,
				intra_op: { allow_spinning: "0", ...extraSection(session?.intra_op) },
				inter_op: { allow_spinning: "0", ...extraSection(session?.inter_op) },
			},
		},
	};
}

/** One open budget: the host's core count it sizes for, and the model directory its sessions load from. */
interface EmbedBudgetScope {
	parallelism: number;
	cacheRoot: string;
}

/** The single budgeting wrapper installed on an ORT session factory, and the scopes it currently serves. */
interface BudgetedFactory {
	original: typeof Ort.InferenceSession.create;
	wrapper: typeof Ort.InferenceSession.create;
	scopes: EmbedBudgetScope[];
}

const budgetedFactories = new WeakMap<object, BudgetedFactory>();

/** Whether `model` is a model file under `cacheRoot`, the only sessions an embedding budget may touch. */
function isEmbeddingModelPath(model: unknown, cacheRoot: string): boolean {
	return typeof model === "string" && path.resolve(model).startsWith(path.resolve(cacheRoot) + path.sep);
}

/**
 * Apply {@link embedSessionOptions} to sessions created through this ORT module
 * from a model file under `cacheRoot`, until the returned function releases the
 * scope. fastembed's `FlagEmbedding.init` passes only `executionProviders` and
 * `graphOptimizationLevel` and exposes no way to reach the session options, so
 * the module its dependency graph loads is the only seam. That module is
 * onnxruntime-common's exported class, which an unrelated consumer shares when
 * ORT is hoisted beside fastembed rather than nested inside it, so the budget
 * is confined twice: only to model files under `cacheRoot`, and only while a
 * scope is open. One wrapper serves every open scope (the newest open scope
 * whose cache holds the model applies); releasing the last scope, in any
 * order, puts the original `create` back unless something else has since
 * wrapped it.
 */
export function applyEmbedSessionBudget(ort: OrtModule, parallelism: number, cacheRoot: string): () => void {
	const factory = ort.InferenceSession;
	let budgeted = budgetedFactories.get(factory);
	if (budgeted === undefined) {
		const original = factory.create;
		const create = original.bind(factory);
		const scopes: EmbedBudgetScope[] = [];
		const wrapper = ((
			model: string | ArrayBufferLike | Uint8Array,
			...rest: unknown[]
		): Promise<Ort.InferenceSession> => {
			// A budgeted call is always the `(path, options?)` form: only a path
			// can name a model file under a scope's cache. Every other call,
			// including the buffer forms, reaches ORT exactly as it was made.
			// The newest scope that owns this model wins, so two scopes on
			// different caches each budget their own sessions.
			const scope = scopes.findLast(open => isEmbeddingModelPath(model, open.cacheRoot));
			if (scope === undefined) {
				return create(model as string, ...(rest as [OrtSessionOptions]));
			}
			return create(
				model as string,
				embedSessionOptions((rest[0] as OrtSessionOptions | undefined) ?? {}, scope.parallelism),
			);
		}) as typeof factory.create;
		budgeted = { original, wrapper, scopes };
		budgetedFactories.set(factory, budgeted);
		factory.create = wrapper;
	}
	const held = budgeted;
	const scope: EmbedBudgetScope = { parallelism, cacheRoot };
	held.scopes.push(scope);
	return () => {
		const index = held.scopes.indexOf(scope);
		if (index === -1) return;
		held.scopes.splice(index, 1);
		if (held.scopes.length > 0) return;
		// The last scope is gone: forget the factory so the next scope installs
		// a fresh wrapper, and restore the original only when ours is still the
		// installed `create` — something wrapped on top of it owns the chain.
		budgetedFactories.delete(factory);
		if (factory.create === held.wrapper) factory.create = held.original;
	};
}

/** The ORT module paired with the fastembed {@link loadFastembed} resolved. */
function pairedFastembedOrt(): OrtModule {
	const loaded = loadedFastembed;
	if (loaded === null) throw new Error("fastembed is not loaded");
	const { ortEntry } = resolveFastembedOrt(loaded.fastembedPackageDir);
	if (ortEntry === null) throw new Error(`Cannot find module onnxruntime-node beside ${loaded.entry}`);
	return loaded.require(ortEntry);
}

/**
 * Run `work` with the embedding thread budget on the ORT module paired with the
 * loaded fastembed, for sessions built from model files under `cacheRoot`, and
 * take it off again afterwards. Budgeting is best-effort: an ORT that cannot be
 * found or loaded leaves the defaults in place rather than failing the
 * embedding that asked for it. `loadOrt` is the test seam.
 */
export async function withEmbedSessionBudget<T>(
	cacheRoot: string,
	work: () => Promise<T>,
	loadOrt: () => OrtModule = pairedFastembedOrt,
): Promise<T> {
	let release: (() => void) | undefined;
	try {
		release = applyEmbedSessionBudget(loadOrt(), os.availableParallelism(), cacheRoot);
	} catch (error) {
		logger.debug("mnemopi: onnxruntime not budgetable; embedding sessions keep ORT thread defaults", {
			error: String(error),
		});
	}
	try {
		return await work();
	} finally {
		release?.();
	}
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
	// Where the ORT paired with this fastembed lives, for `withEmbedSessionBudget`.
	loadedFastembed = { entry, fastembedPackageDir, require: requireFastembed };
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

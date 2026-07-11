import { createRequire } from "node:module";
import * as path from "node:path";
import type { ProgressInfo } from "@huggingface/transformers";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	installRuntimeModuleResolver,
	isCompiledBinary,
	resolveRuntimeModule,
} from "@pk-nerdsaver-ai/pi-utils";
import packageJson from "../../package.json" with { type: "json" };

/**
 * Child-side scaffolding shared by the ONNX inference worker bodies
 * (`stt/asr-worker`, `tiny/worker`, `tts/tts-worker`). These are the helpers
 * that run inside the spawned subprocess: error serialization, structured log
 * and progress reporting over the worker's typed transport, side-runtime
 * install (sharp stubbing + module-resolver patch), once-per-process runtime
 * memoization, and the Transformers.js runtime loader. The parent/client-side
 * complement lives in `worker-client.ts`.
 *
 * Each worker keeps its own strongly-typed transport / model-key / progress
 * event; the structural {@link WorkerLogTransport} / {@link WorkerProgressTransport}
 * interfaces below are the minimal shapes these helpers need, and every worker's
 * concrete transport satisfies them.
 */

export const TRANSFORMERS_PACKAGE = "@huggingface/transformers";
const COMPILED_TRANSFORMERS_VERSION = process.env.PI_TINY_TRANSFORMERS_VERSION;
const sourceRequire = createRequire(import.meta.url);

// ── Error serialization ─────────────────────────────────────────────

export function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── Structured logging ──────────────────────────────────────────────

export type WorkerLogLevel = "debug" | "warn" | "error";

/** Minimal transport surface a worker exposes for forwarding log lines. */
export interface WorkerLogTransport {
	send(message: { type: "log"; level: WorkerLogLevel; msg: string; meta?: Record<string, unknown> }): void;
}

export function sendLog(
	transport: WorkerLogTransport,
	level: WorkerLogLevel,
	msg: string,
	meta?: Record<string, unknown>,
): void {
	transport.send({ type: "log", level, msg, meta });
}

// ── Progress reporting ──────────────────────────────────────────────

/**
 * Generic worker progress event. Each worker's protocol declares an identical
 * shape with its own `modelKey` type; this is the parameterized version the
 * shared helpers emit, structurally assignable to each protocol's event.
 */
export interface WorkerProgressEvent<K> {
	modelKey: K;
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
	task?: string;
	model?: string;
}

/** Minimal transport surface a worker exposes for emitting progress events. */
export interface WorkerProgressTransport<K> {
	send(message: { type: "progress"; id: string; event: WorkerProgressEvent<K> }): void;
}

/** Map a Transformers.js {@link ProgressInfo} onto the worker progress event. */
function toProgressEvent<K>(modelKey: K, info: ProgressInfo): WorkerProgressEvent<K> {
	if (info.status === "ready") {
		return { modelKey, status: info.status, task: info.task, model: info.model };
	}
	if (info.status === "progress_total") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
			files: info.files,
		};
	}
	if (info.status === "progress") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			file: info.file,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
		};
	}
	return { modelKey, status: info.status, name: info.name, file: info.file };
}

export function sendProgress<K>(
	transport: WorkerProgressTransport<K>,
	id: string,
	modelKey: K,
	info: ProgressInfo,
): void {
	transport.send({ type: "progress", id, event: toProgressEvent(modelKey, info) });
}

// ── Model cache ─────────────────────────────────────────────────────

/**
 * If a model is already warming/warm in `cache`, replay a `ready` progress
 * event for this request once it resolves and return the cached promise so the
 * caller can short-circuit; otherwise return `undefined`.
 */
export function replayCachedReady<K, M>(
	cache: Map<K, Promise<M>>,
	modelKey: K,
	transport: WorkerProgressTransport<K>,
	requestId: string,
	task: string,
	model: string,
): Promise<M> | undefined {
	const cached = cache.get(modelKey);
	if (!cached) return undefined;
	void cached
		.then(() => {
			transport.send({ type: "progress", id: requestId, event: { modelKey, status: "ready", task, model } });
		})
		.catch(() => undefined);
	return cached;
}

// ── Side-runtime install scaffolding ────────────────────────────────

/**
 * Stub `sharp` (the speech/text pipelines are not image codecs, so the native
 * image dependency is dead weight) and patch the module resolver so a side
 * runtime's bare requires resolve against its own `node_modules`. Returns the
 * runtime's `node_modules` directory.
 */
export async function installSharpStubResolver(runtimeDir: string): Promise<string> {
	const nodeModules = path.join(runtimeDir, "node_modules");
	const sharpStub = path.join(runtimeDir, "omp-sharp-stub.cjs");
	await Bun.write(sharpStub, "module.exports = {};\n");
	installRuntimeModuleResolver({ runtimeNodeModules: nodeModules, stubs: { sharp: sharpStub } });
	return nodeModules;
}

/**
 * Prepare a freshly-installed compiled runtime for loading and return the
 * absolute entrypoint of `packageName` to `require`.
 */
async function prepareCompiledRuntime(runtimeDir: string, packageName: string): Promise<string> {
	const nodeModules = await installSharpStubResolver(runtimeDir);
	const entry = resolveRuntimeModule(nodeModules, packageName);
	if (!entry) throw new Error(`Unable to resolve ${packageName} in compiled runtime at ${nodeModules}`);
	return entry;
}

// ── Transformers version resolution ─────────────────────────────────

function resolveTransformersVersionSpec(): string {
	const manifest = packageJson as {
		optionalDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	const versionSpec =
		manifest.optionalDependencies?.[TRANSFORMERS_PACKAGE] ?? manifest.dependencies?.[TRANSFORMERS_PACKAGE];
	if (!versionSpec) throw new Error(`${TRANSFORMERS_PACKAGE} is missing from package.json optionalDependencies`);
	if (!versionSpec.startsWith("catalog:")) return versionSpec;
	if (COMPILED_TRANSFORMERS_VERSION) return COMPILED_TRANSFORMERS_VERSION;
	const installed = sourceRequire(`${TRANSFORMERS_PACKAGE}/package.json`) as { version: string };
	return installed.version;
}

let cachedTransformersVersionSpec: string | undefined;

/**
 * Lazily resolve (and memoize) the transformers version spec. In the `catalog:`
 * case {@link resolveTransformersVersionSpec} `require`s the installed
 * `@huggingface/transformers/package.json`, so it is only ever touched on the
 * compiled-binary runtime-install path — loading a worker (smoke-test ping,
 * online path) never triggers the transformers resolve/install dance.
 */
export function getTransformersVersionSpec(): string {
	cachedTransformersVersionSpec ??= resolveTransformersVersionSpec();
	return cachedTransformersVersionSpec;
}

// ── Transformers runtime loader ─────────────────────────────────────

/** The subset of the Transformers.js module surface {@link configureTransformers} touches. */
interface ConfigurableTransformers {
	env: { cacheDir?: string; allowLocalModels?: boolean; logLevel?: unknown };
	LogLevel: { ERROR: unknown };
}

function configureTransformers<T extends ConfigurableTransformers>(transformers: T): T {
	transformers.env.cacheDir = getTinyModelsCacheDir();
	transformers.env.allowLocalModels = false;
	transformers.env.logLevel = transformers.LogLevel.ERROR;
	return transformers;
}

/**
 * Memoize an async runtime load so it runs at most once per process, clearing
 * the cache on failure so a later call can retry. Each worker holds one
 * instance per runtime it loads.
 */
export class MemoizedRuntime<T> {
	#promise: Promise<T> | null = null;

	load(build: () => Promise<T>): Promise<T> {
		if (this.#promise) return this.#promise;
		const promise = build().catch(error => {
			this.#promise = null;
			throw error;
		});
		this.#promise = promise;
		return promise;
	}
}

/**
 * Load the `@huggingface/transformers` runtime into `holder` (memoized): from
 * the ambient install when running from source, or from a version-keyed side
 * runtime (resolved lazily at `runtimeDir()`) when running as a compiled binary.
 * The result is cast to the caller's concrete runtime type `T`.
 */
export function loadTransformersRuntime<T extends ConfigurableTransformers, K>(
	holder: MemoizedRuntime<T>,
	transport: WorkerProgressTransport<K>,
	requestId: string,
	modelKey: K,
	runtimeDir: () => string,
): Promise<T> {
	return holder.load(async () => {
		if (!isCompiledBinary()) return configureTransformers(sourceRequire(TRANSFORMERS_PACKAGE) as T);
		const installedDir = await ensureRuntimeInstalled({
			runtimeDir: runtimeDir(),
			install: {
				dependencies: { [TRANSFORMERS_PACKAGE]: getTransformersVersionSpec() },
				trustedDependencies: ["onnxruntime-node"],
			},
			probePackage: TRANSFORMERS_PACKAGE,
			onPhase: phase =>
				transport.send({
					type: "progress",
					id: requestId,
					event: {
						modelKey,
						status: phase,
						name: `${TRANSFORMERS_PACKAGE}@${getTransformersVersionSpec()}`,
					},
				}),
		});
		const entry = await prepareCompiledRuntime(installedDir, TRANSFORMERS_PACKAGE);
		const require_ = createRequire(entry);
		return configureTransformers(require_(entry) as T);
	});
}

import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { ProgressInfo } from "@huggingface/transformers";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	installRuntimeModuleResolver,
	isCompiledBinary,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils";
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
const ONNX_RUNTIME_NODE_PACKAGE = "onnxruntime-node";
const ONNX_RUNTIME_CUDA_INSTALL = "cuda12";
const ONNX_RUNTIME_CUDA_PROVIDER_FILES = [
	"libonnxruntime_providers_cuda.so",
	"libonnxruntime_providers_shared.so",
	"libonnxruntime_providers_tensorrt.so",
] as const;
const LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR = path.join("bin", "napi-v6", "linux", "x64");

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

function shouldInstallOnnxRuntimeCudaProviders(device: string | undefined): boolean {
	const normalized = device?.trim().toLowerCase();
	return (
		process.platform === "linux" &&
		process.arch === "x64" &&
		(normalized === "cuda" || normalized === "gpu" || normalized === "auto")
	);
}

async function missingOnnxRuntimeCudaProviderFiles(binDir: string): Promise<string[]> {
	const missing: string[] = [];
	for (const file of ONNX_RUNTIME_CUDA_PROVIDER_FILES) {
		try {
			await fsp.access(path.join(binDir, file));
		} catch {
			missing.push(file);
		}
	}
	return missing;
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

async function installOnnxRuntimeCudaProviders(packageDir: string, runtimeDir: string, binDir: string): Promise<void> {
	const script = path.join(packageDir, "script", "install.js");
	try {
		await fsp.access(script);
	} catch {
		throw new Error(
			`ONNX Runtime CUDA provider binaries are missing from ${binDir}, and ${script} is unavailable. Remove the tiny-model side runtime cache at ${runtimeDir} and retry.`,
		);
	}

	const proc = Bun.spawn([process.execPath, script], {
		cwd: runtimeDir,
		env: { ...Bun.env, BUN_BE_BUN: "1", ONNXRUNTIME_NODE_INSTALL: ONNX_RUNTIME_CUDA_INSTALL },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode !== 0) {
		const output = `${stdout}\n${stderr}`.trim();
		throw new Error(
			`Failed to install ONNX Runtime CUDA provider binaries into ${binDir} with ${process.execPath} ${script} (exit ${exitCode}). Remove the tiny-model side runtime cache at ${runtimeDir} and retry with network access. ${output}`,
		);
	}
}

/**
 * Repairs the compiled Transformers side runtime when CUDA was requested and
 * Bun skipped `onnxruntime-node`'s NuGet sidecar install.
 */
export async function ensureOnnxRuntimeCudaProviders(
	runtimeDir: string,
	device = process.env.PI_TINY_DEVICE,
): Promise<void> {
	if (!shouldInstallOnnxRuntimeCudaProviders(device)) return;
	const nodeModules = path.join(runtimeDir, "node_modules");
	const manifest = resolveRuntimeModule(nodeModules, `${ONNX_RUNTIME_NODE_PACKAGE}/package.json`);
	if (!manifest)
		throw new Error(`Unable to resolve ${ONNX_RUNTIME_NODE_PACKAGE} in compiled runtime at ${nodeModules}`);
	const packageDir = path.dirname(manifest);
	const binDir = path.join(packageDir, LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR);
	const missing = await missingOnnxRuntimeCudaProviderFiles(binDir);
	if (missing.length === 0) return;

	await installOnnxRuntimeCudaProviders(packageDir, runtimeDir, binDir);
	const stillMissing = await missingOnnxRuntimeCudaProviderFiles(binDir);
	if (stillMissing.length === 0) return;
	throw new Error(
		`ONNX Runtime CUDA provider install completed but ${stillMissing.join(", ")} are still missing from ${binDir}. Remove the tiny-model side runtime cache at ${runtimeDir} and retry.`,
	);
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

export interface TransformersRuntimeMetadata {
	__ompRuntimeNodeModules?: string;
	__ompTransformersEntry?: string;
	__ompCudaRepairError?: string;
}

function attachTransformersRuntimeMetadata<T extends ConfigurableTransformers>(
	transformers: T,
	metadata: TransformersRuntimeMetadata,
): T {
	const runtime = transformers as T & TransformersRuntimeMetadata;
	runtime.__ompRuntimeNodeModules = metadata.__ompRuntimeNodeModules;
	runtime.__ompTransformersEntry = metadata.__ompTransformersEntry;
	runtime.__ompCudaRepairError = metadata.__ompCudaRepairError;
	return runtime;
}

const TRANSITIVE_CUDA_LIBRARY_RE =
	/\b(lib(?:cu|nv)[A-Za-z0-9_.+-]*\.so(?:\.[0-9]+)*)\b[^:\n]*:\s*cannot open shared object file/iu;
const CUDA_DEVICE_UNAVAILABLE_RE = /\bCUDA failure 100\b|no CUDA-capable device is detected|cudaSetDevice|GPU=-1/iu;

function cudaDeviceUnavailable(error: unknown): boolean {
	return CUDA_DEVICE_UNAVAILABLE_RE.test(errorText(error));
}

function missingCudaLibrary(error: unknown): string | undefined {
	return TRANSITIVE_CUDA_LIBRARY_RE.exec(errorText(error))?.[1];
}

function cudaFailureCause(
	metadata: TransformersRuntimeMetadata,
	error: unknown,
	missingFiles: readonly string[],
): string {
	if (metadata.__ompCudaRepairError) {
		return `ONNX Runtime CUDA provider install failed: ${metadata.__ompCudaRepairError}`;
	}
	if (missingFiles.length > 0) return `missing ONNX Runtime CUDA provider file(s): ${missingFiles.join(", ")}`;
	const missingLibrary = missingCudaLibrary(error);
	if (missingLibrary) return `${missingLibrary}: cannot open shared object file`;
	if (cudaDeviceUnavailable(error)) {
		return "CUDA provider files are present; CUDA runtime reports no CUDA-capable device";
	}
	return "CUDA provider files are present; inspect the original ONNX Runtime CUDA error";
}

function cudaFailureHint(
	metadata: TransformersRuntimeMetadata,
	error: unknown,
	missingFiles: readonly string[],
): string {
	if (metadata.__ompCudaRepairError) {
		return "restore network access to nuget.org (or pre-populate the tiny side runtime) and rerun; CPU inference remained available";
	}
	if (missingFiles.length > 0) return "reinstall the tiny side runtime with ONNX Runtime postinstall enabled";
	if (missingCudaLibrary(error)) {
		return "install the matching CUDA/cuDNN shared libraries and expose them on the dynamic loader path";
	}
	if (cudaDeviceUnavailable(error)) {
		return "make the NVIDIA GPU visible to this process/session, or use providers.tinyModelDevice=default/cpu";
	}
	return "check the host CUDA driver, device visibility, and ONNX Runtime CUDA compatibility";
}

function resolveOnnxRuntimePackageDir(metadata: TransformersRuntimeMetadata): string | null {
	const entry = metadata.__ompTransformersEntry;
	if (entry) {
		try {
			return path.dirname(createRequire(entry).resolve(`${ONNX_RUNTIME_NODE_PACKAGE}/package.json`));
		} catch {
			// Fall through to the side-runtime resolver below.
		}
	}
	const nodeModules = metadata.__ompRuntimeNodeModules;
	if (!nodeModules) return null;
	const manifest = resolveRuntimeModule(nodeModules, `${ONNX_RUNTIME_NODE_PACKAGE}/package.json`);
	return manifest ? path.dirname(manifest) : null;
}

export async function formatOnnxRuntimeCudaDiagnostics(
	metadata: TransformersRuntimeMetadata,
	requestedDevice: string,
	error: unknown,
): Promise<string | null> {
	const device = requestedDevice.trim().toLowerCase();
	if (device !== "cuda" && device !== "gpu" && device !== "auto") return null;
	if (process.platform !== "linux" || process.arch !== "x64") return null;
	const packageDir = resolveOnnxRuntimePackageDir(metadata);
	if (!packageDir) {
		return [
			"ONNX Runtime CUDA diagnostics:",
			`  PI_TINY_DEVICE=${requestedDevice} requested CUDAExecutionProvider`,
			"  cause: unable to resolve onnxruntime-node in the tiny-model runtime",
		].join("\n");
	}
	const binDir = path.join(packageDir, LINUX_X64_ONNX_RUNTIME_CUDA_PROVIDER_DIR);
	const missingFiles = await missingOnnxRuntimeCudaProviderFiles(binDir);
	const sideRuntime = metadata.__ompRuntimeNodeModules;
	const lines = [
		"ONNX Runtime CUDA diagnostics:",
		`  PI_TINY_DEVICE=${requestedDevice} requested CUDAExecutionProvider`,
		sideRuntime ? `  side runtime: ${sideRuntime}` : `  onnxruntime-node: ${packageDir}`,
		`  cause: ${cudaFailureCause(metadata, error, missingFiles)}`,
	];
	lines.push(`  hint: ${cudaFailureHint(metadata, error, missingFiles)}`);
	return lines.join("\n");
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
		if (!isCompiledBinary()) {
			const entry = sourceRequire.resolve(TRANSFORMERS_PACKAGE);
			return attachTransformersRuntimeMetadata(configureTransformers(sourceRequire(entry) as T), {
				__ompTransformersEntry: entry,
			});
		}
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
		let cudaRepairError: string | undefined;
		try {
			await ensureOnnxRuntimeCudaProviders(installedDir);
		} catch (repairError) {
			// Deferred failure: keep loading Transformers so `loadPipelineWithDeviceFallback`
			// still gets its CUDA→CPU retry. The error is surfaced through the CUDA
			// diagnostics attached to the runtime metadata.
			cudaRepairError = errorMessage(repairError);
		}
		const entry = await prepareCompiledRuntime(installedDir, TRANSFORMERS_PACKAGE);
		const require_ = createRequire(entry);
		return attachTransformersRuntimeMetadata(configureTransformers(require_(entry) as T), {
			__ompRuntimeNodeModules: path.join(installedDir, "node_modules"),
			__ompTransformersEntry: entry,
			__ompCudaRepairError: cudaRepairError,
		});
	});
}

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AutomaticSpeechRecognitionOutput,
	AutomaticSpeechRecognitionPipeline,
	ProgressInfo,
} from "@huggingface/transformers";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	isCompiledBinary,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import {
	errorMessage,
	errorText,
	getTransformersVersionSpec,
	loadTransformersRuntime,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
} from "../subprocess/worker-runtime";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "../tiny/device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "../tiny/dtype";
import type { SttTransport, SttWorkerInbound } from "./asr-protocol";
import { type EndpointerEvent, StreamEndpointer } from "./endpointer";
import {
	getSttModelSpec,
	type SherpaSttModelSpec,
	type SttModel,
	type SttModelKey,
	type TransformersSttModelSpec,
} from "./models";
import { loadSourceSherpaRuntime, type SherpaOfflineRecognizer, type SherpaRuntime } from "./sherpa-runtime";

const ASR_TASK = "automatic-speech-recognition";
const SHERPA_PACKAGE = "sherpa-onnx-node";
// Whisper long-form decoding: split into 30s windows with 5s overlap so audio of
// any length transcribes without exceeding the 30s receptive field.
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;
// The client always resamples to 16 kHz mono float32 before sending; sherpa-onnx
// is told the true input rate (it resamples internally to its feature config).
const ASR_SAMPLE_RATE = 16_000;
// Hub origin for raw sherpa-onnx model files (encoder/decoder/joiner/tokens).
const HF_RESOLVE_BASE = "https://huggingface.co";
// Coalesce download progress so streaming a multi-hundred-MB model file doesn't
// flood the IPC channel with one event per chunk.
const PROGRESS_EMIT_BYTES = 4_000_000;

const sttModelDevicePreference = resolveTinyModelDevicePreference();
const sttModelDtypeOverride = resolveTinyModelDtypeOverride();

/**
 * Subset of the transformers.js ASR call options we set. The index signature
 * mirrors `GenerationFunctionParameters` so this is assignable to the pipeline's
 * `Partial<AutomaticSpeechRecognitionConfig>` param (not re-exported from the
 * package root, so we model only what we pass).
 */
interface AsrCallOptions {
	chunk_length_s: number;
	stride_length_s: number;
	return_timestamps: boolean;
	task?: string;
	language?: string;
	[key: string]: unknown;
}

interface TransformersRuntime {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
	};
	LogLevel: {
		ERROR: unknown;
	};
	pipeline: (
		task: typeof ASR_TASK,
		model: string,
		options: {
			device: TinyModelDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<AutomaticSpeechRecognitionPipeline>;
}

/** A warm model plus the engine that loaded it; cached per tier key. */
type LoadedModel =
	| { engine: "transformers"; pipeline: AutomaticSpeechRecognitionPipeline }
	| { engine: "sherpa"; recognizer: SherpaOfflineRecognizer };

const models = new Map<SttModelKey, Promise<LoadedModel>>();
// Serialize all model inference on a single chain: the recognizers are not
// guaranteed reentrant and there is one CPU-bound model per tier. Batch
// transcribes and live-stream segment/partial decodes share this lock.
let modelLock = Promise.resolve();
function runOnModel<T>(work: () => Promise<T>): Promise<T> {
	const run = modelLock.then(work, work);
	modelLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
const transformersRuntime = new MemoizedRuntime<TransformersRuntime>();
const sherpaRuntime = new MemoizedRuntime<SherpaRuntime>();

let cachedSherpaVersionSpec: string | undefined;
function resolveSherpaVersionSpec(): string {
	const manifest = packageJson as {
		optionalDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	const versionSpec = manifest.optionalDependencies?.[SHERPA_PACKAGE] ?? manifest.dependencies?.[SHERPA_PACKAGE];
	if (!versionSpec) throw new Error(`${SHERPA_PACKAGE} is missing from package.json optionalDependencies`);
	return versionSpec;
}

function getSherpaVersionSpec(): string {
	cachedSherpaVersionSpec ??= resolveSherpaVersionSpec();
	return cachedSherpaVersionSpec;
}

function getSttRuntimeDir(): string {
	const key = getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `transformers-${key}`);
}

function getSherpaRuntimeDir(): string {
	const key = getSherpaVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `sherpa-${key}`);
}

/**
 * Resolve the native `sherpa-onnx-node` module. In a compiled binary the addon
 * (plus its per-platform prebuilt `sherpa-onnx.node` + bundled onnxruntime
 * dylibs) is installed into a side runtime dir; the addon resolves its native
 * library relative to its own location, so a plain `createRequire` of the entry
 * is enough — no module-resolver patch or bare-require stubbing is needed.
 * Memoized so the runtime loads once per process.
 */
function loadSherpaRuntime(transport: SttTransport, requestId: string, modelKey: SttModelKey): Promise<SherpaRuntime> {
	return sherpaRuntime.load(async () => {
		if (!isCompiledBinary()) return loadSourceSherpaRuntime(import.meta.url);
		const runtimeDir = await ensureRuntimeInstalled({
			runtimeDir: getSherpaRuntimeDir(),
			install: { dependencies: { [SHERPA_PACKAGE]: getSherpaVersionSpec() } },
			probePackage: SHERPA_PACKAGE,
			onPhase: phase =>
				transport.send({
					type: "progress",
					id: requestId,
					event: { modelKey, status: phase, name: `${SHERPA_PACKAGE}@${getSherpaVersionSpec()}` },
				}),
		});
		const nodeModules = path.join(runtimeDir, "node_modules");
		const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
		if (!entry) throw new Error(`Unable to resolve ${SHERPA_PACKAGE} in compiled runtime at ${nodeModules}`);
		return createRequire(entry)(entry) as SherpaRuntime;
	});
}

async function loadPipelineOnDevice(
	transformers: TransformersRuntime,
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
	device: TinyModelDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
	return transformers.pipeline(ASR_TASK, spec.repo, {
		device,
		dtype: sttModelDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadPipelineWithDeviceFallback(
	transformers: TransformersRuntime,
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<{ pipeline: AutomaticSpeechRecognitionPipeline; device: TinyModelDevice }> {
	const devices = tinyModelDeviceLoadOrder(sttModelDevicePreference);
	if (devices[0] !== sttModelDevicePreference.device) {
		sendLog(transport, "warn", "stt: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: sttModelDevicePreference.device,
			device: devices[0],
		});
	}
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return {
				pipeline: await loadPipelineOnDevice(transformers, spec, modelKey, transport, requestId, device),
				device,
			};
		} catch (error) {
			if (i === devices.length - 1) throw error;
			const fallbackDevice = devices[i + 1]!;
			sendLog(transport, "warn", "stt: accelerated device failed; falling back", {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			});
		}
	}
	throw new Error("No stt model devices configured");
}

async function loadTransformersModel(
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<LoadedModel> {
	const transformers = await loadTransformersRuntime(
		transformersRuntime,
		transport,
		requestId,
		modelKey,
		getSttRuntimeDir,
	);
	const startedAt = performance.now();
	const { pipeline, device } = await loadPipelineWithDeviceFallback(
		transformers,
		spec,
		modelKey,
		transport,
		requestId,
	);
	sendLog(transport, "debug", "stt: local model loaded", {
		modelKey,
		repo: spec.repo,
		engine: "transformers",
		device,
		requestedDevice: sttModelDevicePreference.device,
		dtype: sttModelDtypeOverride ?? spec.dtype,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return { engine: "transformers", pipeline };
}

/**
 * Stream a single sherpa-onnx model file from the Hub into the cache, writing to
 * a `.part` sidecar and renaming on completion so an interrupted fetch never
 * reads as cached. Emits coalesced per-file progress for the aggregating client.
 */
async function downloadSherpaFile(
	repo: string,
	filename: string,
	dest: string,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<void> {
	const url = `${HF_RESOLVE_BASE}/${repo}/resolve/main/${filename}`;
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${filename} (${repo}): HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length") ?? 0);
	transport.send({
		type: "progress",
		id: requestId,
		event: { modelKey, status: "download", name: `${repo}/${filename}`, file: filename },
	});
	const part = `${dest}.part`;
	const handle = await fs.open(part, "w");
	let loaded = 0;
	let lastEmitted = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			await handle.write(value);
			loaded += value.byteLength;
			if (loaded - lastEmitted >= PROGRESS_EMIT_BYTES || (total > 0 && loaded >= total)) {
				lastEmitted = loaded;
				transport.send({
					type: "progress",
					id: requestId,
					event: {
						modelKey,
						status: "progress",
						name: `${repo}/${filename}`,
						file: filename,
						loaded,
						total: total || loaded,
					},
				});
			}
		}
	} finally {
		await handle.close();
	}
	await fs.rename(part, dest);
}

/**
 * Ensure all sherpa-onnx model files for a tier are present in the cache,
 * downloading any that are missing, and return their absolute paths.
 */
async function ensureSherpaModelFiles(
	spec: SherpaSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<{ encoder: string; decoder: string; joiner: string; tokens: string }> {
	const dir = path.join(getTinyModelsCacheDir(), spec.repo);
	await fs.mkdir(dir, { recursive: true });
	const resolved = {} as { encoder: string; decoder: string; joiner: string; tokens: string };
	for (const role in spec.files) {
		const key = role as keyof typeof spec.files;
		const filename = spec.files[key];
		const dest = path.join(dir, filename);
		const present = await fs
			.stat(dest)
			.then(stats => stats.size > 0)
			.catch(() => false);
		if (!present) await downloadSherpaFile(spec.repo, filename, dest, modelKey, transport, requestId);
		resolved[key] = dest;
	}
	return resolved;
}

async function loadSherpaModel(
	spec: SherpaSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<LoadedModel> {
	const runtime = await loadSherpaRuntime(transport, requestId, modelKey);
	const files = await ensureSherpaModelFiles(spec, modelKey, transport, requestId);
	const startedAt = performance.now();
	const numThreads = Math.max(1, Math.min(4, os.availableParallelism()));
	const recognizer = await runtime.OfflineRecognizer.createAsync({
		modelConfig: {
			transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
			tokens: files.tokens,
			modelType: spec.modelType,
			numThreads,
			provider: "cpu",
			debug: 0,
		},
		decodingMethod: "greedy_search",
	});
	sendLog(transport, "debug", "stt: local model loaded", {
		modelKey,
		repo: spec.repo,
		engine: "sherpa",
		provider: "cpu",
		numThreads,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return { engine: "sherpa", recognizer };
}

async function loadModel(modelKey: SttModelKey, transport: SttTransport, requestId: string): Promise<LoadedModel> {
	const spec = getSttModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown stt model: ${modelKey}`);
	const cached = replayCachedReady(models, modelKey, transport, requestId, ASR_TASK, spec.repo);
	if (cached) return cached;

	const loading =
		spec.engine === "sherpa"
			? loadSherpaModel(spec, modelKey, transport, requestId)
			: loadTransformersModel(spec, modelKey, transport, requestId);
	const loaded = loading.then(
		model => {
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: ASR_TASK, model: spec.repo },
			});
			return model;
		},
		error => {
			models.delete(modelKey);
			throw error;
		},
	);
	models.set(modelKey, loaded);
	return loaded;
}

async function decodeSegment(
	model: LoadedModel,
	spec: SttModel,
	audio: Float32Array,
	language: string | undefined,
): Promise<string> {
	if (model.engine === "sherpa") {
		const stream = model.recognizer.createStream();
		stream.acceptWaveform({ samples: audio, sampleRate: ASR_SAMPLE_RATE });
		const result = await model.recognizer.decodeAsync(stream);
		return (result.text ?? "").trim();
	}
	const options: AsrCallOptions = {
		chunk_length_s: CHUNK_LENGTH_S,
		stride_length_s: STRIDE_LENGTH_S,
		return_timestamps: false,
	};
	// English-only Whisper checkpoints reject `language`/`task`; multilingual ones
	// take the configured source language (auto-detected when omitted).
	if (!spec.englishOnly) {
		options.task = "transcribe";
		if (language) options.language = language;
	}
	const output = (await model.pipeline(audio, options)) as AutomaticSpeechRecognitionOutput;
	return (output.text ?? "").trim();
}

async function transcribeAudio(
	transport: SttTransport,
	requestId: string,
	modelKey: SttModelKey,
	audio: Float32Array,
	language: string | undefined,
): Promise<string> {
	const spec = getSttModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown stt model: ${modelKey}`);
	const model = await loadModel(modelKey, transport, requestId);
	return runOnModel(() => decodeSegment(model, spec, audio, language));
}

async function handleBatchRequest(
	transport: SttTransport,
	request: Extract<SttWorkerInbound, { type: "transcribe" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadModel(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const text = await transcribeAudio(transport, request.id, request.modelKey, request.audio, request.language);
		transport.send({ type: "transcription", id: request.id, text });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

// ── Live streaming sessions ─────────────────────────────────────────

/** State for one in-flight {@link StreamEndpointer}-driven streaming session. */
interface StreamingSession {
	id: string;
	spec: SttModel;
	language: string | undefined;
	model: Promise<LoadedModel>;
	endpointer: StreamEndpointer;
	/** Finalized segments awaiting decode, in order. */
	segmentQueue: Float32Array[];
	/** Latest in-progress segment audio awaiting a volatile partial decode (coalesced). */
	pendingPartial: Float32Array | null;
	/** Committed segment transcripts, joined for the final result. */
	committed: string[];
	segmentIndex: number;
	pumping: boolean;
	cancelled: boolean;
	ended: boolean;
}

const sessions = new Map<string, StreamingSession>();

function startStreamingSession(
	transport: SttTransport,
	request: Extract<SttWorkerInbound, { type: "stream_start" }>,
): void {
	const spec = getSttModelSpec(request.modelKey);
	if (!spec) {
		transport.send({ type: "error", id: request.id, error: `Unknown stt model: ${request.modelKey}` });
		return;
	}
	sessions.set(request.id, {
		id: request.id,
		spec,
		language: request.language,
		model: loadModel(request.modelKey, transport, request.id),
		endpointer: new StreamEndpointer(),
		segmentQueue: [],
		pendingPartial: null,
		committed: [],
		segmentIndex: 0,
		pumping: false,
		cancelled: false,
		ended: false,
	});
}

function ingestStreamEvents(session: StreamingSession, events: EndpointerEvent[]): void {
	for (const event of events) {
		if (event.kind === "segment") session.segmentQueue.push(event.audio);
		else session.pendingPartial = event.audio;
	}
}

/**
 * Drain a session's pending work: finalized segments first (committed in order),
 * then a single coalesced partial preview. Re-entrant-safe via `pumping`; new
 * audio that arrives mid-decode is picked up when the current decode resolves.
 */
async function pumpSession(session: StreamingSession, transport: SttTransport): Promise<void> {
	if (session.pumping) return;
	session.pumping = true;
	try {
		const model = await session.model;
		while (!session.cancelled) {
			if (session.segmentQueue.length > 0) {
				const audio = session.segmentQueue.shift()!;
				// A fresh segment supersedes any queued preview for the prior one.
				session.pendingPartial = null;
				const text = await runOnModel(() => decodeSegment(model, session.spec, audio, session.language));
				if (session.cancelled) return;
				if (text.length > 0) {
					session.committed.push(text);
					transport.send({ type: "segment", id: session.id, index: session.segmentIndex++, text });
				}
				continue;
			}
			if (session.pendingPartial) {
				const audio = session.pendingPartial;
				session.pendingPartial = null;
				const text = await runOnModel(() => decodeSegment(model, session.spec, audio, session.language));
				if (session.cancelled) return;
				// Skip a now-stale preview if a segment finalized mid-decode.
				if (text.length > 0 && session.segmentQueue.length === 0) {
					transport.send({ type: "partial", id: session.id, text });
				}
				continue;
			}
			break;
		}
		if (session.ended && !session.cancelled && session.segmentQueue.length === 0 && !session.pendingPartial) {
			transport.send({ type: "stream_done", id: session.id, text: session.committed.join(" ") });
			sessions.delete(session.id);
		}
	} catch (error) {
		if (!session.cancelled) transport.send({ type: "error", id: session.id, error: errorText(error) });
		sessions.delete(session.id);
	} finally {
		session.pumping = false;
	}
}

function handleStreamMessage(
	transport: SttTransport,
	message: Extract<SttWorkerInbound, { type: "stream_start" | "stream_audio" | "stream_stop" | "stream_cancel" }>,
): void {
	if (message.type === "stream_start") {
		startStreamingSession(transport, message);
		return;
	}
	const session = sessions.get(message.id);
	if (!session || session.cancelled) return;
	switch (message.type) {
		case "stream_audio":
			ingestStreamEvents(session, session.endpointer.push(message.audio));
			void pumpSession(session, transport);
			return;
		case "stream_stop":
			session.ended = true;
			session.pendingPartial = null;
			ingestStreamEvents(session, session.endpointer.flush());
			void pumpSession(session, transport);
			return;
		case "stream_cancel":
			session.cancelled = true;
			sessions.delete(message.id);
			return;
	}
}

export function startSttWorker(transport: SttTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "transcribe":
			case "download":
				void handleBatchRequest(transport, message);
				return;
			default:
				handleStreamMessage(transport, message);
				return;
		}
	});
}

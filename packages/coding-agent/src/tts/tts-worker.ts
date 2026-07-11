import { createRequire } from "node:module";
import type { ProgressInfo, RawAudio } from "@huggingface/transformers";
import { ensureRuntimeInstalled, getTinyModelsCacheDir, resolveRuntimeModule } from "@pk-nerdsaver-ai/pi-utils";
import {
	errorMessage,
	errorText,
	installSharpStubResolver,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
	TRANSFORMERS_PACKAGE,
} from "../subprocess/worker-runtime";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "../tiny/device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "../tiny/dtype";
import { getTtsLocalModelSpec, resolveTtsVoice, type TtsLocalModelKey, type TtsLocalModelSpec } from "./models";
import {
	getTtsRuntimeDir,
	KOKORO_PACKAGE,
	KOKORO_VERSION,
	ONNXRUNTIME_NODE_PACKAGE,
	ONNXRUNTIME_NODE_VERSION,
} from "./runtime";
import type { TtsTransport, TtsWorkerInbound } from "./tts-protocol";

const TTS_TASK = "text-to-speech";
// kokoro-js is NEVER a dependency of the main tree: its transformers@3.8.1 +
// onnxruntime-node@1.21 graph must not pollute it (1.21 segfaults Bun on session
// creation). It is lazily `bun install`ed into a side runtime dir on first use,
// with onnxruntime-node force-pinned to the Bun-safe version the rest of the
// stack runs. Bump KOKORO_VERSION to roll the cached runtime + model wrapper.

const ttsDevicePreference = resolveTinyModelDevicePreference();
const ttsDtypeOverride = resolveTinyModelDtypeOverride();

/** Device values `kokoro-js` accepts; the tiny device order is mapped onto these. */
type KokoroDevice = "cpu" | "wasm" | "webgpu";

/** A loaded Kokoro voice synthesizer (subset of `kokoro-js`'s `KokoroTTS`). */
interface KokoroTtsInstance {
	generate(text: string, options: { voice: string }): Promise<RawAudio>;
	stream(
		text: string | TextSplitterStreamInstance,
		options: { voice: string },
	): AsyncGenerator<{ text: string; phonemes: string; audio: RawAudio }, void, void>;
}

/**
 * Incremental text source for {@link KokoroTtsInstance.stream} (subset of
 * `kokoro-js`'s `TextSplitterStream`). Text pushed at any time is split into
 * complete sentences; `close` flushes the trailing buffer and ends the stream.
 */
interface TextSplitterStreamInstance {
	push(...texts: string[]): void;
	close(): void;
}

/** `KokoroTTS` static surface used to load a model from the Hugging Face Hub. */
interface KokoroRuntime {
	KokoroTTS: {
		from_pretrained(
			repo: string,
			options: {
				dtype: TinyModelDtype;
				device: KokoroDevice;
				progress_callback: (info: ProgressInfo) => void;
			},
		): Promise<KokoroTtsInstance>;
	};
	TextSplitterStream: new () => TextSplitterStreamInstance;
}

/**
 * The `@huggingface/transformers` instance `kokoro-js` runs on. We only touch its
 * `env` (cache dir + log level) and `LogLevel`; inference goes through Kokoro.
 */
interface TransformersEnv {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
		backends?: {
			onnx?: {
				logLevel?: unknown;
			};
		};
	};
	LogLevel?: {
		ERROR: unknown;
	};
}

const models = new Map<TtsLocalModelKey, Promise<KokoroTtsInstance>>();
let synthesizeQueue = Promise.resolve();
const kokoroRuntime = new MemoizedRuntime<KokoroRuntime>();

/**
 * In-flight streaming sessions keyed by request id. A session is created on
 * `stream-start` and torn down when its generator finishes. Text pushed before
 * the model finishes loading is held in `buffered` and flushed into the splitter
 * once it exists; pushes after that go straight to the live splitter.
 */
interface StreamSession {
	modelKey: TtsLocalModelKey;
	voice: string | undefined;
	buffered: string[];
	splitter: TextSplitterStreamInstance | null;
	ended: boolean;
	cancelled: boolean;
}
const streamSessions = new Map<string, StreamSession>();

/**
 * Map a tiny-model device onto the narrow set `kokoro-js` accepts. The worker
 * always runs `kokoro-js` on Node, where `cpu` (onnxruntime-node) is the only
 * safe option; `webgpu`/`wasm` are honored if explicitly requested.
 */
function toKokoroDevice(device: TinyModelDevice): KokoroDevice {
	if (device === "wasm") return "wasm";
	if (device === "webgpu" || device === "gpu") return "webgpu";
	return "cpu";
}

function configureTransformers(transformers: TransformersEnv): void {
	transformers.env.cacheDir = getTinyModelsCacheDir();
	transformers.env.allowLocalModels = false;
	transformers.env.logLevel = transformers.LogLevel?.ERROR ?? "error";
	if (transformers.env.backends?.onnx) transformers.env.backends.onnx.logLevel = "error";
}

/**
 * Lazily `bun install` `kokoro-js` into a side runtime dir (idempotent, version-
 * keyed) and return its module, with the `@huggingface/transformers` instance it
 * loads configured (cache dir + quiet logging). `kokoro-js` is NEVER a dependency
 * of the main tree: its transformers@3.8.1 graph pulls onnxruntime-node@1.21,
 * which segfaults Bun on session creation, so the runtime manifest force-pins
 * onnxruntime-node to the Bun-safe version via `overrides`. `sharp` is stubbed —
 * the TTS pipeline is audio-only, so the native image codec transformers eagerly
 * requires is dead weight. Memoized so the runtime loads once per process.
 */
function loadKokoroRuntime(
	transport: TtsTransport,
	requestId: string,
	modelKey: TtsLocalModelKey,
): Promise<KokoroRuntime> {
	return kokoroRuntime.load(async () => {
		const runtimeDir = await ensureRuntimeInstalled({
			runtimeDir: getTtsRuntimeDir(),
			install: {
				dependencies: { [KOKORO_PACKAGE]: KOKORO_VERSION },
				overrides: { [ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_VERSION },
				trustedDependencies: [ONNXRUNTIME_NODE_PACKAGE],
			},
			probePackage: KOKORO_PACKAGE,
			onPhase: phase =>
				transport.send({
					type: "progress",
					id: requestId,
					event: { modelKey, status: phase, name: `${KOKORO_PACKAGE}@${KOKORO_VERSION}` },
				}),
		});
		const nodeModules = await installSharpStubResolver(runtimeDir);
		const kokoroEntry = resolveRuntimeModule(nodeModules, KOKORO_PACKAGE);
		if (!kokoroEntry) throw new Error(`Unable to resolve ${KOKORO_PACKAGE} in runtime at ${nodeModules}`);
		const transformersEntry = resolveRuntimeModule(nodeModules, TRANSFORMERS_PACKAGE);
		if (!transformersEntry) throw new Error(`Unable to resolve ${TRANSFORMERS_PACKAGE} in runtime at ${nodeModules}`);
		const runtimeRequire = createRequire(kokoroEntry);
		configureTransformers(runtimeRequire(transformersEntry) as TransformersEnv);
		return runtimeRequire(kokoroEntry) as KokoroRuntime;
	});
}

async function loadModelOnDevice(
	runtime: KokoroRuntime,
	spec: TtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
	device: KokoroDevice,
): Promise<KokoroTtsInstance> {
	return runtime.KokoroTTS.from_pretrained(spec.repo, {
		device,
		dtype: ttsDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadModelWithDeviceFallback(
	runtime: KokoroRuntime,
	spec: TtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<{ model: KokoroTtsInstance; device: KokoroDevice }> {
	const order = tinyModelDeviceLoadOrder(ttsDevicePreference);
	if (order[0] !== ttsDevicePreference.device) {
		sendLog(transport, "warn", "tts: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: ttsDevicePreference.device,
			device: order[0],
		});
	}
	const devices: KokoroDevice[] = [];
	for (const device of order) {
		const mapped = toKokoroDevice(device);
		if (!devices.includes(mapped)) devices.push(mapped);
	}
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return { model: await loadModelOnDevice(runtime, spec, modelKey, transport, requestId, device), device };
		} catch (error) {
			if (i === devices.length - 1) throw error;
			const fallbackDevice = devices[i + 1]!;
			sendLog(transport, "warn", "tts: accelerated device failed; falling back", {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			});
		}
	}
	throw new Error("No TTS devices configured");
}

async function loadModel(
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<KokoroTtsInstance> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown local TTS model: ${modelKey}`);
	const cached = replayCachedReady(models, modelKey, transport, requestId, TTS_TASK, spec.repo);
	if (cached) return cached;

	const runtime = await loadKokoroRuntime(transport, requestId, modelKey);
	const startedAt = performance.now();
	const loaded = loadModelWithDeviceFallback(runtime, spec, modelKey, transport, requestId).then(
		({ model, device }) => {
			sendLog(transport, "debug", "tts: local model loaded", {
				modelKey,
				repo: spec.repo,
				device,
				requestedDevice: ttsDevicePreference.device,
				dtype: ttsDtypeOverride ?? spec.dtype,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: TTS_TASK, model: spec.repo },
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

async function synthesize(
	transport: TtsTransport,
	requestId: string,
	modelKey: TtsLocalModelKey,
	text: string,
	voice: string | undefined,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
	const synthesizer = await loadModel(modelKey, transport, requestId);
	const output = await synthesizer.generate(text, { voice: resolveTtsVoice(modelKey, voice) });
	const spec = getTtsLocalModelSpec(modelKey);
	const audio = Array.isArray(output.audio) ? output.audio[0] : output.audio;
	if (!audio) throw new Error("Kokoro synthesis returned no audio samples");
	return { pcm: audio, sampleRate: output.sampling_rate || spec?.sampleRate || 24_000 };
}

function enqueueRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): void {
	synthesizeQueue = synthesizeQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadModel(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const { pcm, sampleRate } = await synthesize(
			transport,
			request.id,
			request.modelKey,
			request.text,
			request.voice,
		);
		transport.send({ type: "audio", id: request.id, pcm, sampleRate });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

/**
 * Drive one streaming session to completion: load the model, create the
 * splitter, flush any text pushed before the model was ready, then emit one
 * `audio-chunk` per synthesized sentence followed by a single `stream-done`.
 * Serialized through {@link synthesizeQueue} so it never interleaves model
 * access with a batch synthesize/download.
 */
async function runStreamSession(transport: TtsTransport, id: string, session: StreamSession): Promise<void> {
	try {
		if (session.cancelled) return;
		const runtime = await loadKokoroRuntime(transport, id, session.modelKey);
		if (session.cancelled) return;
		const synthesizer = await loadModel(session.modelKey, transport, id);
		if (session.cancelled) return;
		const spec = getTtsLocalModelSpec(session.modelKey);
		const splitter = new runtime.TextSplitterStream();
		// Flush buffered text before exposing the splitter so a push racing this
		// block can't slip ahead of the already-queued fragments.
		for (const text of session.buffered) {
			if (session.cancelled) return;
			splitter.push(text);
		}
		session.buffered = [];
		session.splitter = splitter;
		if (session.ended || session.cancelled) splitter.close();
		const voice = resolveTtsVoice(session.modelKey, session.voice);
		let index = 0;
		for await (const chunk of synthesizer.stream(splitter, { voice })) {
			if (session.cancelled) break;
			const audio = Array.isArray(chunk.audio.audio) ? chunk.audio.audio[0] : chunk.audio.audio;
			if (!audio) continue;
			transport.send({
				type: "audio-chunk",
				id,
				index: index++,
				text: chunk.text,
				pcm: audio,
				sampleRate: chunk.audio.sampling_rate || spec?.sampleRate || 24_000,
			});
		}
		if (!session.cancelled) transport.send({ type: "stream-done", id });
	} catch (error) {
		if (!session.cancelled) transport.send({ type: "error", id, error: errorText(error) });
	} finally {
		streamSessions.delete(id);
	}
}

function startStreamSession(
	transport: TtsTransport,
	message: Extract<TtsWorkerInbound, { type: "stream-start" }>,
): void {
	const session: StreamSession = {
		modelKey: message.modelKey,
		voice: message.voice,
		buffered: [],
		splitter: null,
		ended: false,
		cancelled: false,
	};
	streamSessions.set(message.id, session);
	synthesizeQueue = synthesizeQueue.then(
		() => runStreamSession(transport, message.id, session),
		() => runStreamSession(transport, message.id, session),
	);
}

function pushToStreamSession(id: string, text: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	if (session.splitter) session.splitter.push(text);
	else session.buffered.push(text);
}

function endStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	session.ended = true;
	session.splitter?.close();
}

function cancelStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session) return;
	session.cancelled = true;
	session.buffered = [];
	session.splitter?.close();
	streamSessions.delete(id);
}

export function startTtsWorker(transport: TtsTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "stream-start":
				startStreamSession(transport, message);
				return;
			case "stream-push":
				pushToStreamSession(message.id, message.text);
				return;
			case "stream-end":
				endStreamSession(message.id);
				return;
			case "stream-cancel":
				cancelStreamSession(message.id);
				return;
			default:
				enqueueRequest(transport, message);
				return;
		}
	});
}

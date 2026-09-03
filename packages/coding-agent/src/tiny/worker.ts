/**
 * ONNX tiny-model worker: one process per local model, owning the model's
 * socket (see `title-protocol.ts`), serving every omp process on the machine,
 * and exiting on its own once idle. Entered from `cli.ts` via
 * {@link TINY_WORKER_ARG} with the socket/model/tag env set by
 * `title-client.ts`. Runs `onnxruntime-node` outside every omp process so its
 * NAPI finalizer never runs in a shared address space.
 */
import * as path from "node:path";
import type {
	ProgressInfo,
	TextGenerationPipeline,
	TextGenerationStringOutput,
	StoppingCriteria as TransformersStoppingCriteria,
} from "@huggingface/transformers";
import { getTinyModelsCacheDir, logger, setProcessName } from "@oh-my-pi/pi-utils";
import {
	errorMessage,
	errorText,
	formatOnnxRuntimeCudaDiagnostics,
	getTransformersVersionSpec,
	loadTransformersRuntime,
	MemoizedRuntime,
	sendProgress,
	type TransformersRuntimeMetadata,
} from "../subprocess/worker-runtime";
import { renderTextChatTemplate } from "./completion-prompt";
import {
	resolveTinyModelDevicePreference,
	type TinyModelDevicePreference,
	type TinyOnnxDevice,
	tinyModelDeviceLoadOrder,
} from "./device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "./dtype";
import {
	getTinyLocalModelSpec,
	isTinyLocalModelKey,
	type TinyLocalModelKey,
	type TinyTitleLocalModelSpec,
} from "./models";
import {
	TINY_WORKER_IDLE_MS,
	TINY_WORKER_IDLE_MS_ENV,
	TINY_WORKER_MODEL_ENV,
	TINY_WORKER_SOCKET_ENV,
	TINY_WORKER_TAG_ENV,
	type TinyWorkerRequest,
	type TinyWorkerResponse,
} from "./title-protocol";
import { TinyWorkerServer } from "./worker-server";

const STOP_DECODE_WINDOW_TOKENS = 32;

export interface TransformersRuntime extends TransformersRuntimeMetadata {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
	};
	LogLevel: {
		ERROR: unknown;
	};
	StoppingCriteria: new () => TransformersStoppingCriteria;
	pipeline: (
		task: "text-generation",
		model: string,
		options: {
			device: TinyOnnxDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<TextGenerationPipeline>;
}

/** Minimal outbound surface the shared progress/runtime helpers need for one request. */
interface ReplyTransport {
	send(message: TinyWorkerResponse): void;
}

function getTinyTitleRuntimeDir(): string {
	return path.join(
		path.dirname(getTinyModelsCacheDir()),
		"tiny-title-runtime",
		`transformers-${getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_")}`,
	);
}

/** Stops generation at the first occurrence of `text` in the *generated* tokens.
 *
 *  The window must be anchored to the generation boundary, not to the end of the
 *  whole sequence: a prompt that itself contains the stop string (chat-level
 *  few-shot examples ending in `</title>`, for instance) would otherwise match on
 *  prompt tokens and stop before the model emits anything. */
export function createStopOnTextCriteria(
	transformers: TransformersRuntime,
	tokenizer: TextGenerationPipeline["tokenizer"],
	text: string,
): TransformersStoppingCriteria {
	class StopOnTextCriteria extends transformers.StoppingCriteria {
		#tokenizer: TextGenerationPipeline["tokenizer"];
		#text: string;
		/** First generated index per batch entry, captured on the first call. */
		#generatedStarts: number[] = [];

		constructor() {
			super();
			this.#tokenizer = tokenizer;
			this.#text = text;
		}

		override _call(inputIds: number[][]): boolean[] {
			return inputIds.map((ids, index) => {
				const generatedStart = this.#generatedStarts[index] ?? Math.max(0, ids.length - 1);
				this.#generatedStarts[index] = generatedStart;
				const tail = ids.slice(Math.max(generatedStart, ids.length - STOP_DECODE_WINDOW_TOKENS));
				const decoded = this.#tokenizer.decode(tail, {
					skip_special_tokens: false,
					clean_up_tokenization_spaces: false,
				});
				return decoded.includes(this.#text);
			});
		}
	}
	return new StopOnTextCriteria();
}

/** The worker's single ONNX model: transformers.js pipeline with the device fallback chain. */
class OnnxModel {
	#spec: TinyTitleLocalModelSpec;
	#modelKey: TinyLocalModelKey;
	#devicePreference: TinyModelDevicePreference;
	#dtypeOverride: TinyModelDtype | undefined;
	#runtime = new MemoizedRuntime<TransformersRuntime>();
	#pipeline: Promise<TextGenerationPipeline> | null = null;

	constructor(
		modelKey: TinyLocalModelKey,
		spec: TinyTitleLocalModelSpec,
		devicePreference: TinyModelDevicePreference,
		dtypeOverride: TinyModelDtype | undefined,
	) {
		this.#modelKey = modelKey;
		this.#spec = spec;
		this.#devicePreference = devicePreference;
		this.#dtypeOverride = dtypeOverride;
	}

	#loadRuntime(reply: ReplyTransport, requestId: string): Promise<TransformersRuntime> {
		return loadTransformersRuntime(this.#runtime, reply, requestId, this.#modelKey, getTinyTitleRuntimeDir);
	}

	async #loadPipelineWithDeviceFallback(
		transformers: TransformersRuntime,
		reply: ReplyTransport,
		requestId: string,
	): Promise<{ generator: TextGenerationPipeline; device: TinyOnnxDevice }> {
		const devices = tinyModelDeviceLoadOrder(this.#devicePreference);
		if (devices[0] !== this.#devicePreference.device) {
			logger.warn("tiny-model: requested device is not an ONNX provider usable in the worker; using CPU", {
				modelKey: this.#modelKey,
				requestedDevice: this.#devicePreference.device,
				device: devices[0],
			});
		}
		let cudaDiagnostics: string | null = null;
		for (let i = 0; i < devices.length; i += 1) {
			const device = devices[i]!;
			try {
				const generator = await transformers.pipeline("text-generation", this.#spec.repo, {
					device,
					dtype: this.#dtypeOverride ?? this.#spec.dtype,
					progress_callback: info => sendProgress(reply, requestId, this.#modelKey, info),
				});
				return { generator, device };
			} catch (error) {
				const deviceDiagnostics = await formatOnnxRuntimeCudaDiagnostics(transformers, device, error);
				if (deviceDiagnostics) cudaDiagnostics = deviceDiagnostics;
				if (i === devices.length - 1) {
					if (cudaDiagnostics) throw new Error(`${errorText(error)}\n${cudaDiagnostics}`);
					throw error;
				}
				const meta: Record<string, unknown> = {
					modelKey: this.#modelKey,
					device,
					fallbackDevice: devices[i + 1],
					error: errorMessage(error),
				};
				if (deviceDiagnostics) meta.cudaDiagnostics = deviceDiagnostics;
				logger.warn("tiny-model: accelerated device failed; falling back", meta);
			}
		}
		throw new Error("No tiny model devices configured");
	}

	/** Resident pipeline, loading (with progress for `requestId`) on first use. */
	pipeline(reply: ReplyTransport, requestId: string): Promise<TextGenerationPipeline> {
		if (this.#pipeline) return this.#pipeline;
		if (this.#spec.onnxUnsupportedReason) {
			return Promise.reject(new Error(`${this.#modelKey} is unavailable: ${this.#spec.onnxUnsupportedReason}`));
		}
		const startedAt = performance.now();
		const loaded = this.#loadRuntime(reply, requestId)
			.then(transformers => this.#loadPipelineWithDeviceFallback(transformers, reply, requestId))
			.then(
				({ generator, device }) => {
					logger.debug("tiny-model: local model loaded", {
						modelKey: this.#modelKey,
						repo: this.#spec.repo,
						device,
						requestedDevice: this.#devicePreference.device,
						dtype: this.#dtypeOverride ?? this.#spec.dtype,
						elapsedMs: Math.round(performance.now() - startedAt),
					});
					return generator;
				},
				error => {
					this.#pipeline = null;
					throw error;
				},
			);
		this.#pipeline = loaded;
		return loaded;
	}

	/** Send the `ready` marker the client's download UI waits for. */
	sendReady(reply: ReplyTransport, requestId: string): void {
		reply.send({
			type: "progress",
			id: requestId,
			event: { modelKey: this.#modelKey, status: "ready", task: "text-generation", model: this.#spec.repo },
		});
	}

	async chat(request: Extract<TinyWorkerRequest, { type: "chat" }>, reply: ReplyTransport): Promise<string> {
		const generator = await this.pipeline(reply, request.id);
		const rendered = renderTextChatTemplate(generator.tokenizer, request.messages, {
			addGenerationPrompt: true,
			enableThinking: false,
		});
		const promptText = request.prefill ? `${rendered}${request.prefill}` : rendered;
		const stoppingCriteria = request.stop
			? createStopOnTextCriteria(await this.#loadRuntime(reply, request.id), generator.tokenizer, request.stop)
			: undefined;
		const output = (await generator(promptText, {
			max_new_tokens: request.maxNewTokens,
			do_sample: false,
			return_full_text: false,
			...(stoppingCriteria ? { stopping_criteria: stoppingCriteria } : {}),
		})) as TextGenerationStringOutput;
		return output[0]?.generated_text ?? "";
	}
}

/** Run the ONNX worker for the model/endpoint selected by the CLI worker host environment. */
export async function startTinyWorkerFromEnvironment(): Promise<void> {
	const endpoint = process.env[TINY_WORKER_SOCKET_ENV];
	const modelKey = process.env[TINY_WORKER_MODEL_ENV];
	const tag = process.env[TINY_WORKER_TAG_ENV];
	if (!endpoint || !modelKey || !tag) throw new Error("tiny worker environment is incomplete");
	if (!isTinyLocalModelKey(modelKey)) throw new Error(`Unknown tiny local model: ${modelKey}`);
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	setProcessName(`omp tiny ${modelKey}`);
	const model = new OnnxModel(modelKey, spec, resolveTinyModelDevicePreference(), resolveTinyModelDtypeOverride());
	const server = new TinyWorkerServer({
		tag,
		idleMs: Number(process.env[TINY_WORKER_IDLE_MS_ENV]) || TINY_WORKER_IDLE_MS,
		async handle(request, reply) {
			if (request.type === "load") {
				await model.pipeline(reply, request.id);
				model.sendReady(reply, request.id);
				reply.send({ type: "loaded", id: request.id });
				return;
			}
			const text = await model.chat(request, reply);
			reply.send({ type: "text", id: request.id, text });
		},
	});
	await server.serve(endpoint);
}

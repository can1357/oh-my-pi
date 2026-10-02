/**
 * ONNX tiny-model worker: one process per local model, owning the model's
 * socket (see `title-protocol.ts`), serving every omp process on the machine,
 * and exiting on its own once idle. Entered from `cli.ts` via
 * {@link TINY_WORKER_ARG} with the socket/model/tag env set by
 * `title-client.ts`. Runs `onnxruntime-node` outside every omp process so its
 * NAPI finalizer never runs in a shared address space.
 */
import * as path from "node:path";
import { createRequire } from "node:module";
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
	resolveOnnxRuntimePackageDir,
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
import { fillJudgeBatch, packJudgeBatch, serializeJudgeRow, sliceJudgeLogits } from "./judge-serialize";
import { ensureJuliaJudgeFiles } from "./judge-weights";
import {
	getTinyLocalModelSpec,
	isTinyJudgeLocalModelKey,
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
	type JudgeQuestionPayload,
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

/** Tokenizer surface `JuliaJudgeModel` needs (subset of transformers.js `PreTrainedTokenizer`). */
interface JuliaJudgeTokenizer {
	mask_token_id: number;
	mask_token: string | undefined;
	cls_token_id: number | undefined;
	bos_token_id: number | undefined;
	sep_token_id: number;
	(text: string, options: { add_special_tokens: false }): { input_ids: { data: ArrayLike<number> } };
}

/** Minimal `onnxruntime-node` surface for the Julia-1 judge session. */
interface OrtTensor {
	getData(): Promise<ArrayLike<number>>;
}
interface OrtSession {
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
/** Minimal `onnxruntime-node` module surface: tensor constructor + session factory. */
interface OrtRuntime {
	Tensor: new (type: string, data: BigInt64Array | Uint8Array, dims: number[]) => unknown;
	InferenceSession: { create(modelPath: string, options: { executionProviders: ["cpu"] }): Promise<OrtSession> };
}

/** Transformers runtime extended with the tokenizer loader the Julia-1 judge needs. */
interface JuliaTransformersRuntime extends TransformersRuntime {
	AutoTokenizer: {
		from_pretrained(dir: string): Promise<JuliaJudgeTokenizer>;
	};
}

/** Encode raw text to ids with no special tokens (matches the reference serializer's `encode`). */
function encodeJudgeText(tokenizer: JuliaJudgeTokenizer, text: string): number[] {
	return Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number);
}

/** Map one wire question onto the serializer's row shape (state passes through as a string). */
function toJudgeSerializeRow(
	question: JudgeQuestionPayload,
	state: string,
): { type: "choice" | "score" | "noul"; question: string; options: string[]; state: string } {
	return { type: question.type, question: question.instructions, options: [...question.options], state };
}

/**
 * Julia-1 judge model: raw `InferenceSession` + `AutoTokenizer`, no
 * transformers.js pipeline (the Julia-1-ONNX root layout — `model.onnx` +
 * `model.onnx.data` + `tokenizer.json` — has no `config.json`, so
 * `pipeline("text-classification")` cannot resolve it).
 *
 * The transformers-BUNDLED `onnxruntime-node` copy (nested 1.30.0) is the
 * ONLY one loaded in this process: the top-level 1.26.0 copy
 * dlopen-clashes with it (`libonnxruntime.so.1` VERS symbols, proven in
 * smoke), so it is never imported here. Resolution goes through
 * `createRequire` from the transformers package path: from the ambient
 * install in source runs, from the side-runtime entry
 * (`__ompTransformersEntry`) in compiled runs. Transformers.js itself is
 * imported lazily for the tokenizer only — never eagerly at module top, so
 * this file never triggers the dual load.
 *
 * MLX is out of scope for judge keys: the Julia-1-MLX layout
 * (`encoder/config.json` + `julia_config.json`) does not match
 * `mlx-server.py` DOWNLOAD_PATTERNS, so the client forces the ONNX backend.
 */
class JuliaJudgeModel {
	#modelKey: TinyLocalModelKey;
	#spec: TinyTitleLocalModelSpec;
	#runtime = new MemoizedRuntime<JuliaTransformersRuntime>();
	#loaded: Promise<{ tokenizer: JuliaJudgeTokenizer; ort: OrtRuntime; session: OrtSession }> | null = null;

	constructor(modelKey: TinyLocalModelKey, spec: TinyTitleLocalModelSpec) {
		this.#modelKey = modelKey;
		this.#spec = spec;
	}

	/** Resident tokenizer + session, downloading weights on first use. */
	load(
		reply: ReplyTransport,
		requestId: string,
	): Promise<{
		tokenizer: JuliaJudgeTokenizer;
		ort: OrtRuntime;
		session: OrtSession;
	}> {
		if (this.#loaded) return this.#loaded;
		const startedAt = performance.now();
		const loaded = this.#load(reply, requestId).then(
			result => {
				logger.debug("tiny-model: local judge model loaded", {
					modelKey: this.#modelKey,
					repo: this.#spec.repo,
					elapsedMs: Math.round(performance.now() - startedAt),
				});
				return result;
			},
			error => {
				this.#loaded = null;
				throw error;
			},
		);
		this.#loaded = loaded;
		return loaded;
	}

	async #load(
		reply: ReplyTransport,
		requestId: string,
	): Promise<{ tokenizer: JuliaJudgeTokenizer; ort: OrtRuntime; session: OrtSession }> {
		const dir = await ensureJuliaJudgeFiles(this.#modelKey, this.#spec.repo, reply, requestId);
		const runtime = await this.#transformersEntry(reply, requestId);
		const { tokenizer, ort } = await this.#loadDeps(runtime, dir);
		const session = await ort.InferenceSession.create(path.join(dir, "model.onnx"), {
			executionProviders: ["cpu"],
		});
		return { tokenizer, ort, session };
	}

	/**
	 * Loaded transformers runtime carrying the tokenizer loader (never
	 * top-level ORT). Loads the tiny side runtime on first use (memoized) so
	 * the compiled-binary path resolves the nested onnxruntime-node copy from
	 * the version-keyed runtime dir, exactly like the chat path.
	 */
	async #transformersEntry(reply: ReplyTransport, requestId: string): Promise<JuliaTransformersRuntime> {
		return loadTransformersRuntime<JuliaTransformersRuntime, TinyLocalModelKey>(
			this.#runtime,
			reply,
			requestId,
			this.#modelKey,
			getTinyTitleRuntimeDir,
		);
	}

	async #loadDeps(
		runtime: JuliaTransformersRuntime,
		dir: string,
	): Promise<{ tokenizer: JuliaJudgeTokenizer; ort: OrtRuntime }> {
		// `loadTransformersRuntime` disables local models (pipeline-only chat
		// path resolves repos from the HF cache); the judge dir IS the local
		// model, so re-enable it for this runtime before loading the tokenizer.
		runtime.env.allowLocalModels = true;
		const tokenizer = await runtime.AutoTokenizer.from_pretrained(dir);
		// Nested copy only: resolve ORT through the transformers entry so the
		// side-runtime's own `node_modules/onnxruntime-node` (1.30.0) is used,
		// never the top-level 1.26.0 (dual load segfaults/dlopen-clashes).
		const packageDir = resolveOnnxRuntimePackageDir(runtime);
		if (!packageDir) throw new Error("Unable to resolve onnxruntime-node in the tiny-model runtime");
		const ort: OrtRuntime = createRequire(path.join(packageDir, "package.json"))(packageDir);
		return { tokenizer, ort };
	}

	/** Send the `ready` marker the client's download UI waits for. */
	sendReady(reply: ReplyTransport, requestId: string): void {
		reply.send({
			type: "progress",
			id: requestId,
			event: { modelKey: this.#modelKey, status: "ready", task: "text-classification", model: this.#spec.repo },
		});
	}

	async judge(
		request: Extract<TinyWorkerRequest, { type: "judge" }>,
		reply: ReplyTransport,
	): Promise<Record<string, number[]>> {
		const names = Object.keys(request.questions);
		// Empty batch would build zero-dim ORT tensors that session.run rejects.
		if (names.length === 0) return {};
		const { tokenizer, ort, session } = await this.load(reply, request.id);
		// Matches the reference clean(): scrub the marker string so id 4 appears only at option markers.
		const marker = tokenizer.mask_token;
		const clean = (text: string): string => (marker ? text.split(marker).join(" ") : text);
		const state = clean(request.state);
		// The state text is identical across rows: memoize encoding so it is
		// tokenized once per judge() call instead of once per question.
		const encodeCache = new Map<string, number[]>();
		const encode = (text: string): number[] => {
			const cached = encodeCache.get(text);
			if (cached) return cached;
			const ids = encodeJudgeText(tokenizer, text);
			encodeCache.set(text, ids);
			return ids;
		};
		const rows = names.map(name => {
			const question = request.questions[name]!;
			const instructions = clean(question.instructions);
			// Rebuild per variant so the `noul` tuple option type is preserved.
			const cleaned: JudgeQuestionPayload =
				question.type === "choice"
					? { type: "choice", instructions, options: question.options.map(clean) }
					: question.type === "noul"
						? { type: "noul", instructions, options: [clean(question.options[0]!), clean(question.options[1]!)] }
						: { type: "score", instructions, options: question.options.map(clean) };
			return serializeJudgeRow(toJudgeSerializeRow(cleaned, state), encode, {
				mask: tokenizer.mask_token_id,
				cls: tokenizer.cls_token_id ?? tokenizer.bos_token_id ?? 2,
				sep: tokenizer.sep_token_id,
			});
		});
		const batch = packJudgeBatch(rows);
		const length = batch.length;
		const count = batch.count;
		const { ids, attention, positions, mask, qtype } = fillJudgeBatch(rows, batch);
		const output = await session.run({
			input_ids: new ort.Tensor("int64", ids, [names.length, length]),
			attention_mask: new ort.Tensor("int64", attention, [names.length, length]),
			marker_pos: new ort.Tensor("int64", positions, [names.length, count]),
			marker_mask: new ort.Tensor("bool", mask, [names.length, count]),
			qtype: new ort.Tensor("int64", qtype, [names.length]),
		});
		const values = Array.from(await output.logits!.getData());
		return sliceJudgeLogits(
			names,
			rows.map(row => row.markers.length),
			values,
			count,
		);
	}
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
	if (isTinyJudgeLocalModelKey(modelKey)) {
		const judge = new JuliaJudgeModel(modelKey, spec);
		const judgeServer = new TinyWorkerServer({
			tag,
			idleMs: Number(process.env[TINY_WORKER_IDLE_MS_ENV]) || TINY_WORKER_IDLE_MS,
			async handle(request, reply) {
				if (request.type === "load") {
					await judge.load(reply, request.id);
					judge.sendReady(reply, request.id);
					reply.send({ type: "loaded", id: request.id });
					return;
				}
				if (request.type === "chat")
					throw new Error(`${modelKey} is a judge model and does not serve chat requests`);
				const logits = await judge.judge(request, reply);
				reply.send({ type: "judged", id: request.id, logits });
			},
		});
		await judgeServer.serve(endpoint);
		return;
	}
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
			if (request.type === "judge")
				throw new Error(`${modelKey} is not a judge model and does not serve judge requests`);
			const text = await model.chat(request, reply);
			reply.send({ type: "text", id: request.id, text });
		},
	});
	await server.serve(endpoint);
}

import * as path from "node:path";
import type {
	ProgressInfo,
	TextGenerationPipeline,
	TextGenerationStringOutput,
	StoppingCriteria as TransformersStoppingCriteria,
} from "@huggingface/transformers";
import { getTinyModelsCacheDir, prompt } from "@oh-my-pi/pi-utils";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import {
	errorMessage,
	errorText,
	formatOnnxRuntimeCudaDiagnostics,
	getTransformersVersionSpec,
	loadTransformersRuntime,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
	type TransformersRuntimeMetadata,
} from "../subprocess/worker-runtime";
import { buildCompletionPrompt } from "./completion-prompt";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "./device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "./dtype";
import { formatTitleUserMessage } from "./message-preproc";
import {
	getTinyLocalModelSpec,
	type TinyLocalModelKey,
	type TinyTitleLocalModelKey,
	type TinyTitleLocalModelSpec,
} from "./models";
import { normalizeGeneratedTitle } from "./text";
import type { TinyTitleTransport, TinyTitleWorkerInbound } from "./title-protocol";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const STOP_DECODE_WINDOW_TOKENS = 32;
const MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS = 256;
const COMPLETION_MAX_NEW_TOKENS = 1024;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const tinyModelDevicePreference = resolveTinyModelDevicePreference();
const tinyModelDtypeOverride = resolveTinyModelDtypeOverride();

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
			device: TinyModelDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<TextGenerationPipeline>;
}

const pipelines = new Map<TinyLocalModelKey, Promise<TextGenerationPipeline>>();

function getTransformersRuntimeKey(): string {
	return getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
}
let generateQueue = Promise.resolve();
const transformersRuntime = new MemoizedRuntime<TransformersRuntime>();

function getTinyTitleRuntimeDir(): string {
	return path.join(
		path.dirname(getTinyModelsCacheDir()),
		"tiny-title-runtime",
		`transformers-${getTransformersRuntimeKey()}`,
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

async function loadPipelineOnDevice(
	transformers: TransformersRuntime,
	spec: TinyTitleLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
	device: TinyModelDevice,
): Promise<TextGenerationPipeline> {
	return transformers.pipeline("text-generation", spec.repo, {
		device,
		dtype: tinyModelDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadPipelineWithDeviceFallback(
	transformers: TransformersRuntime,
	spec: TinyTitleLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
): Promise<{ generator: TextGenerationPipeline; device: TinyModelDevice }> {
	const devices = tinyModelDeviceLoadOrder(tinyModelDevicePreference);
	if (devices[0] !== tinyModelDevicePreference.device) {
		sendLog(transport, "warn", "tiny-model: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: tinyModelDevicePreference.device,
			device: devices[0],
		});
	}
	let cudaDiagnostics: string | null = null;
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return {
				generator: await loadPipelineOnDevice(transformers, spec, modelKey, transport, requestId, device),
				device,
			};
		} catch (error) {
			const deviceDiagnostics = await formatOnnxRuntimeCudaDiagnostics(transformers, device, error);
			if (deviceDiagnostics) cudaDiagnostics = deviceDiagnostics;
			if (i === devices.length - 1) {
				if (cudaDiagnostics) throw new Error(`${errorText(error)}\n${cudaDiagnostics}`);
				throw error;
			}
			const fallbackDevice = devices[i + 1]!;
			const meta: Record<string, unknown> = {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			};
			if (deviceDiagnostics) meta.cudaDiagnostics = deviceDiagnostics;
			sendLog(transport, "warn", "tiny-model: accelerated device failed; falling back", meta);
		}
	}
	throw new Error("No tiny model devices configured");
}

async function loadPipeline(
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
): Promise<TextGenerationPipeline> {
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	if (spec.unsupportedReason) throw new Error(`${modelKey} is unavailable: ${spec.unsupportedReason}`);
	const cached = replayCachedReady(pipelines, modelKey, transport, requestId, "text-generation", spec.repo);
	if (cached) return cached;

	const transformers = await loadTransformersRuntime(
		transformersRuntime,
		transport,
		requestId,
		modelKey,
		getTinyTitleRuntimeDir,
	);
	const startedAt = performance.now();
	const loaded = loadPipelineWithDeviceFallback(transformers, spec, modelKey, transport, requestId).then(
		({ generator, device }) => {
			sendLog(transport, "debug", "tiny-model: local model loaded", {
				modelKey,
				repo: spec.repo,
				device,
				requestedDevice: tinyModelDevicePreference.device,
				dtype: tinyModelDtypeOverride ?? spec.dtype,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: "text-generation", model: spec.repo },
			});
			return generator;
		},
		error => {
			pipelines.delete(modelKey);
			throw error;
		},
	);
	pipelines.set(modelKey, loaded);
	return loaded;
}

function buildPrompt(generator: TextGenerationPipeline, message: string, systemPrompt?: string): string {
	const selectedSystemPrompt = systemPrompt?.trim() || TINY_TITLE_SYSTEM_PROMPT;
	const chat = [
		{ role: "system", content: selectedSystemPrompt },
		{ role: "user", content: formatTitleUserMessage(message) },
	];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${generator.tokenizer.apply_chat_template(chat, chatTemplateOptions)}${TITLE_PREFILL}`;
}

function extractTinyTitle(text: string, sourceText: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	// Self-closing tag: <title/> or <title /> (only when the prefill is present).
	if (titleStart >= 0 && /^\s*\/>/.test(withoutPrefix)) return null;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag, sourceText);
}

async function generateTitle(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyTitleLocalModelKey,
	message: string,
	systemPrompt?: string,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport, requestId);
	const promptText = buildPrompt(generator, message, systemPrompt);
	const transformers = await loadTransformersRuntime(
		transformersRuntime,
		transport,
		requestId,
		modelKey,
		getTinyTitleRuntimeDir,
	);
	const output = (await generator(promptText, {
		max_new_tokens: TITLE_MAX_NEW_TOKENS,
		do_sample: false,
		return_full_text: false,
		stopping_criteria: createStopOnTextCriteria(transformers, generator.tokenizer, TITLE_CLOSE),
	})) as TextGenerationStringOutput;
	return extractTinyTitle(output[0]?.generated_text ?? "", message);
}

/**
 * Generic completion used by Mnemopi memory tasks (fact extraction and
 * consolidation) and the small classifiers. The caller supplies the task
 * prompt as the user turn and, optionally, its rules as a system turn; we
 * decode greedily and return the raw text for the caller's own parser. Output
 * is capped to keep local inference latency bounded.
 */
async function generateCompletion(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
	promptText: string,
	maxTokens: number | undefined,
	systemPrompt: string | undefined,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport, requestId);
	const text = buildCompletionPrompt(generator.tokenizer, promptText, systemPrompt);
	const requested = maxTokens ?? MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS;
	const maxNewTokens = Math.min(Math.max(1, requested), COMPLETION_MAX_NEW_TOKENS);
	const output = (await generator(text, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
	})) as TextGenerationStringOutput;
	const generated = (output[0]?.generated_text ?? "").trim();
	return generated === "" ? null : generated;
}

function enqueueRequest(
	transport: TinyTitleTransport,
	request: Extract<TinyTitleWorkerInbound, { type: "generate" | "complete" | "download" }>,
): void {
	generateQueue = generateQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TinyTitleTransport,
	request: Extract<TinyTitleWorkerInbound, { type: "generate" | "complete" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadPipeline(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		if (request.type === "complete") {
			const text = await generateCompletion(
				transport,
				request.id,
				request.modelKey,
				request.prompt,
				request.maxTokens,
				request.systemPrompt,
			);
			transport.send({ type: "completion", id: request.id, text });
			return;
		}
		const title = await generateTitle(transport, request.id, request.modelKey, request.message, request.systemPrompt);
		transport.send({ type: "title", id: request.id, title });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

export function startTinyTitleWorker(transport: TinyTitleTransport): void {
	transport.onMessage(message => {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		enqueueRequest(transport, message);
	});
}

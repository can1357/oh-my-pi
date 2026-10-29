/**
 * Native judgment client: the {@link Judge} backend for catalog models whose
 * API answers typed questions directly ({@link isJudgmentApi}).
 *
 * Each judgment API is one wire dialect: TypeSafe's System One route
 * (`POST /v1/systemone`), OpenRouter Decisions (`POST /api/alpha/decisions`,
 * same body), Cloudflare Workers AI (`POST /ai/run/{model}`, same body plus
 * top-level data URL images; `systemone.ts`), and OpenAI Decisions
 * (`POST /v1/decisions`, translated both ways; `openai-decisions.ts`).
 * Credentials flow through {@link withAuth}, so a stored key rotates on
 * 401/403 exactly like chat providers; transient 429/5xx responses retry with
 * bounded, `retry-after`-aware backoff. Endpoints that cap the questions per
 * request (the catalog's `judgment-questions-max`, e.g. OpenJEV at 16) get
 * oversized requests split into chunks under `maxQuestions`, at most
 * {@link CHUNK_PARALLEL} in flight at once.
 *
 * Environment (mirrors the official TypeSafe SDK, for judges built without an
 * explicit model): `TYPESAFE_API_KEY` is resolved by the auth registry
 * (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL` overrides the API root,
 * `TYPESAFE_DEFAULT_MODEL` the model.
 */
import { resolveJudgmentImageInput, type JudgmentImageInput } from "@oh-my-pi/pi-catalog/compat/judgment-images";
import { resolveJudgmentQuestionsMax } from "@oh-my-pi/pi-catalog/compat/judgment-questions";
import { TYPESAFE_DEFAULT_BASE_URL } from "@oh-my-pi/pi-catalog/discovery";
import type { Api, FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $env, isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { validateImageInput } from "../images/shared";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { ImageContent, Model, Usage } from "../types";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { openaiDecisionsWire } from "./openai-decisions";
import { openrouterDecisionsWire, referencedImageAssets, typesafeWire, workersAiWire } from "./systemone";
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";
import type { JudgmentImageAssets, JudgmentWire } from "./wire";
export type { JudgmentImageAssets } from "./wire";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

const JUDGMENT_WIRES = {
	typesafe: typesafeWire,
	"openrouter-decisions": openrouterDecisionsWire,
	"workers-ai-systemone": workersAiWire,
	"openai-decisions": openaiDecisionsWire,
} as const satisfies Partial<Record<Api, JudgmentWire>>;

/** APIs {@link NativeJudge} can serve. */
export type JudgmentApi = keyof typeof JUDGMENT_WIRES;

/** Whether a catalog API answers judgments natively. */
export function isJudgmentApi(api: Api): api is JudgmentApi {
	return Object.hasOwn(JUDGMENT_WIRES, api);
}

/** Whether both the native protocol and catalog model support image input. */
export function nativeJudgmentSupportsImages(model: Model): boolean {
	return isJudgmentApi(model.api) && JUDGMENT_WIRES[model.api].images !== undefined && model.input.includes("image");
}

/** Whether `model`'s native judgment takes images and its wire forwards box questions. The model itself may still refuse them (Box needs Jev 1.14+). */
export function nativeJudgmentSupportsBoxes(model: Model): boolean {
	return nativeJudgmentSupportsImages(model) && isJudgmentApi(model.api) && JUDGMENT_WIRES[model.api].boxes === true;
}

/**
 * Every image bound `model`'s native judgment enforces: its wire's transport limits tightened by the
 * catalog's model bounds. `undefined` when it takes no images. Native APIs reject images outside these
 * rather than resizing them, so callers size images to them first.
 */
export function nativeJudgmentImageBounds(model: Model): JudgmentImageInput | undefined {
	if (!isJudgmentApi(model.api) || !model.input.includes("image")) return undefined;
	const wire = JUDGMENT_WIRES[model.api].images;
	if (wire === undefined) return undefined;
	const catalog = resolveJudgmentImageInput(model);
	return catalog === undefined ? wire : intersectImageInput(wire, catalog);
}

/** Whether `model`'s native judgment API takes these exact images: image support within every {@link nativeJudgmentImageBounds}. */
export function nativeJudgmentAcceptsImages(model: Model, images: readonly ImageContent[]): boolean {
	const bounds = nativeJudgmentImageBounds(model);
	return bounds !== undefined && imageLimitViolation(images, bounds) === undefined;
}

/** The bounds both `a` and `b` allow: shared MIME types, the lower of each cap, the higher of each floor. */
function intersectImageInput(a: JudgmentImageInput, b: JudgmentImageInput): JudgmentImageInput {
	const bounds: JudgmentImageInput = {};
	const mimeTypes =
		a.mimeTypes && b.mimeTypes
			? a.mimeTypes.filter(type => b.mimeTypes?.includes(type))
			: (a.mimeTypes ?? b.mimeTypes);
	if (mimeTypes !== undefined) bounds.mimeTypes = mimeTypes;
	for (const cap of ["maxCount", "maxBytes", "maxTotalBytes", "maxPixels", "maxSide"] as const) {
		const limit = a[cap] === undefined ? b[cap] : b[cap] === undefined ? a[cap] : Math.min(a[cap], b[cap]);
		if (limit !== undefined) bounds[cap] = limit;
	}
	for (const floor of ["minPixels", "minSide"] as const) {
		const limit =
			a[floor] === undefined ? b[floor] : b[floor] === undefined ? a[floor] : Math.max(a[floor], b[floor]);
		if (limit !== undefined) bounds[floor] = limit;
	}
	return bounds;
}

/**
 * Reject images that `model`'s native judgment API cannot take — no image support, an unsupported or
 * unreferenced asset, or a transport or catalog bound exceeded — before any credential or upstream work.
 * @throws {AIError.ValidationError} naming the reason.
 */
export function checkNativeJudgmentImages(
	model: Model,
	request: JudgmentRequest,
	imageAssets?: JudgmentImageAssets,
): void {
	const label = `${model.provider}/${model.id}`;
	if (isJudgmentApi(model.api)) {
		checkJudgmentImages(
			label,
			JUDGMENT_WIRES[model.api],
			model.input.includes("image"),
			request,
			imageAssets,
			resolveJudgmentImageInput(model),
		);
	} else if ((request.images?.length ?? 0) > 0 || Object.keys(imageAssets ?? {}).length > 0) {
		throw new AIError.ValidationError(`Native judgment backend ${label} does not support image inputs`);
	}
}

/**
 * Reject box questions whose `image` is not an index into `request.images`: nothing would say which
 * image their edges measure.
 * @throws {AIError.ValidationError} naming the question.
 */
export function checkBoxQuestions(request: JudgmentRequest): void {
	const count = request.images?.length ?? 0;
	for (const id in request.questions) {
		const question = request.questions[id];
		if (question.type !== "box") continue;
		if (Number.isInteger(question.image) && question.image >= 0 && question.image < count) continue;
		throw new AIError.ValidationError(
			`judgment: box question "${id}" names image ${question.image}, but the request has ${count} images`,
		);
	}
}

/** `TYPESAFE_BASE_URL` when set, else the public API root; trailing slashes stripped. */
export function typesafeBaseUrl(): string {
	return ($env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** `TYPESAFE_DEFAULT_MODEL` when set, else {@link TYPESAFE_DEFAULT_MODEL}. */
export function typesafeModel(): string {
	return $env.TYPESAFE_DEFAULT_MODEL?.trim() || TYPESAFE_DEFAULT_MODEL;
}

/** Credential and transport overrides for a judge; see {@link createNativeJudge}. */
export interface NativeJudgeConnection {
	apiKey: ApiKey;
	/** Static headers attached to judgment requests (e.g. proxy routing, gateway auth). */
	headers?: Record<string, string>;
	fetch?: FetchImpl;
}

export interface NativeJudgeOptions extends NativeJudgeConnection {
	/** Wire dialect; defaults to TypeSafe's own API. */
	api?: JudgmentApi;
	/** Catalog provider reported on results; defaults to {@link TYPESAFE_PROVIDER}. */
	provider?: string;
	/** Defaults to {@link typesafeBaseUrl}. */
	baseUrl?: string;
	/** Wire model id; defaults to {@link typesafeModel}. */
	model?: string;
	/** Per-attempt timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * Most questions per request the endpoint accepts, a positive integer; larger
	 * requests are split. Unset: no cap.
	 */
	maxQuestions?: number;
	/**
	 * Whether images are enabled for this judge. `false` disables image input; `true` enables
	 * dialects that require explicit opt-in but cannot enable a wire without image support.
	 */
	supportsImages?: boolean;
	/** Catalog-selected image bounds, applied in addition to the wire's transport constraints. */
	imageInput?: JudgmentImageInput;
}

/** Per-call options for {@link NativeJudge.judge}. */
export interface NativeJudgeCallOptions extends JudgeOptions {
	/** Assets keyed by their existing references; wires without asset transport reject them. */
	imageAssets?: JudgmentImageAssets;
	/**
	 * Called before a split judgment rejects, with the summed usage of the chunks that had already
	 * succeeded: billed upstream, but their answers are discarded with the failure. Not called when
	 * no chunk succeeded or the request was not split.
	 */
	onPartialUsage?: (usage: Usage) => void;
}

/** Non-2xx response from a native judgment API. */
export class JudgmentApiError extends AIError.ProviderHttpError {
	override readonly name = "JudgmentApiError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;
/** Chunks of one split judgment in flight at once, so a split never bursts the endpoint unboundedly. */
const CHUNK_PARALLEL = 4;

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** Whether `value` is a wire answer of `type`. Answers are trusted past their discriminant, as forwarded verbatim. */
function isAnswerOf(value: unknown, type: Answer["type"]): value is Answer {
	return isRecord(value) && value.type === type;
}

/** The first documented cap `images` exceed, phrased to follow the backend label; `undefined` when within every cap. */
function imageLimitViolation(images: readonly ImageContent[], limits: JudgmentImageInput): string | undefined {
	if (limits.maxCount !== undefined && images.length > limits.maxCount) {
		return `accepts at most ${limits.maxCount} images, got ${images.length}`;
	}
	let totalBytes = 0;
	const { minPixels, maxPixels, minSide, maxSide } = limits;
	const checkDimensions =
		minPixels !== undefined || maxPixels !== undefined || minSide !== undefined || maxSide !== undefined;
	const needsBytes = limits.maxBytes !== undefined || limits.maxTotalBytes !== undefined;
	for (const [index, image] of images.entries()) {
		const mimeType = image.mimeType.toLowerCase();
		if (limits.mimeTypes && !limits.mimeTypes.includes(mimeType)) {
			return `does not accept ${mimeType} images (images[${index}]); use ${limits.mimeTypes.join(", ")}`;
		}
		if (!needsBytes && !checkDimensions) continue;
		const bytes = Buffer.from(image.data, "base64");
		totalBytes += bytes.length;
		if (limits.maxBytes !== undefined && bytes.length > limits.maxBytes) {
			return `accepts images up to ${limits.maxBytes} bytes; images[${index}] is ${bytes.length} bytes`;
		}
		if (!checkDimensions) continue;
		const metadata = parseImageMetadata(bytes);
		if (!metadata?.width || !metadata.height) continue;
		const { width, height } = metadata;
		const size = `images[${index}] is ${width}x${height}`;
		if (maxPixels !== undefined && width * height > maxPixels)
			return `accepts images up to ${maxPixels} pixels; ${size}`;
		if (minPixels !== undefined && width * height < minPixels) {
			return `accepts images of at least ${minPixels} pixels; ${size}`;
		}
		if (maxSide !== undefined && Math.max(width, height) > maxSide) {
			return `accepts images up to ${maxSide} pixels per side; ${size}`;
		}
		if (minSide !== undefined && Math.min(width, height) < minSide) {
			return `accepts images of at least ${minSide} pixels per side; ${size}`;
		}
	}
	if (limits.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes) {
		return `accepts at most ${limits.maxTotalBytes} image bytes per request, got ${totalBytes}`;
	}
	return undefined;
}

/**
 * Reject images `wire` would refuse: assets on a wire without asset transport, images when they are
 * disabled, an asset `request` never references (TypeSafe refuses those), malformed data, or a
 * documented cap exceeded.
 * @throws {AIError.ValidationError} naming the first problem.
 */
function checkJudgmentImages(
	label: string,
	wire: JudgmentWire,
	imagesEnabled: boolean,
	request: JudgmentRequest,
	imageAssets: JudgmentImageAssets | undefined,
	modelImageInput?: JudgmentImageInput,
): void {
	const assets = Object.values(imageAssets ?? {});
	if (assets.length > 0 && wire.supportsImageAssets !== true) {
		throw new AIError.ValidationError(`Native judgment backend ${label} does not support image assets`);
	}
	const images = [...(request.images ?? []), ...assets];
	if (images.length === 0) return;
	if (!imagesEnabled || wire.images === undefined) {
		throw new AIError.ValidationError(`Native judgment backend ${label} does not support image inputs`);
	}
	if (imageAssets !== undefined && assets.length > 0) {
		const referenced = referencedImageAssets(request, imageAssets);
		for (const reference in imageAssets) {
			if (Object.hasOwn(referenced, reference)) continue;
			throw new AIError.ValidationError(
				`Native judgment backend ${label}: image asset ${JSON.stringify(reference)} is not referenced in state, instructions, or criteria`,
			);
		}
	}
	for (const image of images) validateImageInput(image);
	for (const limits of [wire.images, modelImageInput]) {
		if (limits === undefined) continue;
		const violation = imageLimitViolation(images, limits);
		if (violation !== undefined) throw new AIError.ValidationError(`Native judgment backend ${label} ${violation}`);
	}
}

export class NativeJudge implements Judge {
	readonly label: string;
	/** True when the selected native wire and model or direct-call option permit image input. */
	readonly supportsImages?: boolean;
	readonly api: JudgmentApi;
	readonly provider: string;
	/** Wire model id sent with every request. */
	readonly model: string;
	readonly baseUrl: string;
	readonly #wire: JudgmentWire;
	readonly #apiKey: ApiKey;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;
	readonly #maxQuestions: number | undefined;
	readonly #imageInput: JudgmentImageInput | undefined;

	constructor(options: NativeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.#wire = JUDGMENT_WIRES[this.api];
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (options.maxQuestions !== undefined && !(Number.isInteger(options.maxQuestions) && options.maxQuestions > 0)) {
			throw new RangeError(`NativeJudge maxQuestions must be a positive integer, got ${options.maxQuestions}`);
		}
		this.#maxQuestions = options.maxQuestions;
		this.#imageInput = options.imageInput;
		const optedIntoImages = options.supportsImages ?? this.#wire.imagesRequireOptIn !== true;
		if (this.#wire.images !== undefined && optedIntoImages) this.supportsImages = true;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: NativeJudgeCallOptions,
	): Promise<JudgmentResult<Q>> {
		checkJudgmentImages(
			this.label,
			this.#wire,
			this.supportsImages === true,
			request,
			options?.imageAssets,
			this.#imageInput,
		);
		checkBoxQuestions(request);
		if (this.#wire.boxes !== true) {
			for (const id in request.questions) {
				if (request.questions[id].type !== "box") continue;
				throw new AIError.ValidationError(`Native judgment backend ${this.label} does not answer box questions`);
			}
		}
		const ids = Object.keys(request.questions);
		const cap = this.#maxQuestions;
		if (cap !== undefined && ids.length > cap) return this.#judgeChunked(request, ids, cap, options);
		return this.#judgeOnce(request, options);
	}

	/** Effective image detail for cache identity after applying this wire's forwarding behavior. */
	effectiveImageDetail(detail: ImageContent["detail"]): ImageContent["detail"] {
		return this.#wire.ignoresImageDetail ? undefined : detail;
	}

	/**
	 * Answer `request` in requests of at most `cap` questions each, {@link CHUNK_PARALLEL} at a time;
	 * answers merge and usage sums. The first failing chunk aborts its in-flight siblings and stops
	 * dispatch, so a doomed judgment stops spending; once every chunk settles, the usage of those that
	 * succeeded goes to `onPartialUsage` before the judgment rejects.
	 */
	async #judgeChunked<Q extends Questions>(
		request: JudgmentRequest<Q>,
		ids: string[],
		cap: number,
		options: NativeJudgeCallOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const chunks: Questions[] = [];
		for (let start = 0; start < ids.length; start += cap) {
			const questions: Questions = {};
			for (const id of ids.slice(start, start + cap)) questions[id] = request.questions[id];
			chunks.push(questions);
		}
		const failed = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
		const imageAssets = options?.imageAssets;
		const results: JudgmentResult[] = [];
		let next = 0;
		const drain = async (): Promise<void> => {
			while (next < chunks.length && !signal.aborted) {
				const index = next++;
				const chunk = { ...request, questions: chunks[index] };
				// TypeSafe refuses unreferenced assets: a chunk carries only those its own questions or the state use.
				const chunkAssets = imageAssets === undefined ? undefined : referencedImageAssets(chunk, imageAssets);
				try {
					results[index] = await this.#judgeOnce(chunk, { signal, imageAssets: chunkAssets });
				} catch (error) {
					failed.abort(error);
					throw error;
				}
			}
		};
		// Settle every worker, not just the first failure, so no sibling's billed result goes uncounted.
		await Promise.allSettled(Array.from({ length: Math.min(CHUNK_PARALLEL, chunks.length) }, drain));
		const answers: Record<string, Answer> = {};
		let settled = 0;
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const result of results) {
			if (result === undefined) continue;
			settled++;
			Object.assign(answers, result.answers);
			input += result.usage.input;
			output += result.usage.output;
			cost += result.usage.cost.total;
		}
		// Every chunk failure aborts `failed`, so `signal` carries the first failure or the caller's abort.
		if (signal.aborted) {
			if (settled > 0) options?.onPartialUsage?.(tokenUsage(input, output, cost));
			throw signal.reason;
		}
		return {
			api: this.api,
			provider: this.provider,
			model: results[0].model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(input, output, cost),
		};
	}

	async #judgeOnce<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: NativeJudgeCallOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify(this.#wire.encode(request, this.model, options?.imageAssets));
		const hasImages = (request.images?.length ?? 0) > 0 || Object.keys(options?.imageAssets ?? {}).length > 0;
		const requestHeaders = hasImages ? this.#wire.imageHeaders : undefined;
		const signal = options?.signal;
		const payload = await withAuth(this.#apiKey, key => this.#attempt(body, key, signal, requestHeaders), { signal });
		const decoded = this.#wire.decode(payload);
		if (!decoded) {
			throw new AIError.ProviderResponseError(`${this.label} returned a malformed judgment response`, {
				provider: this.provider,
				kind: "envelope",
			});
		}
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const type = request.questions[id].type;
			if (decoded.refused.includes(id)) {
				throw new AIError.ProviderResponseError(`${this.label} refused to answer question "${id}"`, {
					provider: this.provider,
					kind: "content-blocked",
				});
			}
			const answer = decoded.answers[id];
			if (!isAnswerOf(answer, type)) {
				throw new AIError.ProviderResponseError(
					`${this.label} response is missing a "${type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
			answers[id] = answer;
		}
		return {
			api: this.api,
			provider: this.provider,
			model: decoded.model ?? this.model,
			// Each id was checked against its question's type above.
			answers: answers as JudgmentResult<Q>["answers"],
			usage: decoded.usage,
		};
	}

	async #attempt(
		body: string,
		key: string,
		signal: AbortSignal | undefined,
		requestHeaders: Readonly<Record<string, string>> | undefined,
	): Promise<unknown> {
		const target = this.#wire.target(this.baseUrl, this.model, key);
		const headers: Record<string, string> = {
			...this.#headers,
			...requestHeaders,
			Authorization: `Bearer ${target.token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(
					target.url,
					withInferenceUserAgent(target.url, {
						method: "POST",
						headers,
						body,
						signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
					}),
				);
			} catch (error) {
				if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await Bun.sleep(backoffMs(attempt, undefined));
				continue;
			}
			if (response.ok) return await response.json();
			const text = await response.text();
			const error = new JudgmentApiError(`${this.label} API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}

/**
 * The {@link NativeJudge} for a catalog judge model: its API's dialect, wire id
 * (`requestModelId ?? id`), base URL, and catalog question cap
 * (`judgment-questions-max`). Shared by the coding agent's judge chain and the
 * auth-gateway System One route so both address a model the same way.
 *
 * @throws ConfigurationError when the model's API is not a judgment API.
 */
export function createNativeJudge(model: Model, connection: NativeJudgeConnection): NativeJudge {
	if (!isJudgmentApi(model.api)) {
		throw new AIError.ConfigurationError(`${model.provider}/${model.id} does not answer native judgments`);
	}
	return new NativeJudge({
		...connection,
		api: model.api,
		provider: model.provider,
		model: model.requestModelId ?? model.id,
		baseUrl: model.baseUrl,
		maxQuestions: resolveJudgmentQuestionsMax(model),
		supportsImages: nativeJudgmentSupportsImages(model),
		imageInput: resolveJudgmentImageInput(model),
	});
}

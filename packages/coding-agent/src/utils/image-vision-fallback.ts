/**
 * Vision fallback for text-only models. When a request to a model that cannot
 * accept image input carries an input image, this:
 *  1. saves each image under the session `local://` root (for later analysis), and
 *  2. asks a vision-capable model to describe it and injects that description as
 *     a text block in place of the image:
 *
 *     <image path="local://image-<hash>.png">
 *     <description>
 *     </image>
 *
 * Without this the provider layer drops the image entirely (NON_VISION_IMAGE_PLACEHOLDER).
 */
import * as path from "node:path";
import {
	type AgentMessage,
	type AgentTelemetry,
	type AgentTelemetryConfig,
	instrumentedCompleteSimple,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Api, Context, completeSimple, ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { getEffectiveTokenCost, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { isEnoent, logger, prompt, toError, untilAborted } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { extractTextContent } from "../commit/utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import { disabledModelRule, disabledSelectorRule, withoutDisabledModels } from "../config/disabled-models";
import { withDisabledModelFallbackPolicy } from "../config/model-fallback-policy";
import type { ModelRegistry } from "../config/model-registry";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls";
import { cfgImagesBlockImages } from "../modes/settings";
import type { CostGateApi } from "../session/cost-gate";
import { journalCompletion, type ModelUsageLedger } from "../session/model-usage-journal";
import { cfgImagesDescribeForTextModels } from "../session/settings";
import describeUserPrompt from "../prompts/tools/image-attachment-describe.md" with { type: "text" };
import describeSystemPrompt from "../prompts/tools/image-attachment-describe-system.md" with { type: "text" };
import offlineNoVisionTemplate from "../prompts/tools/image-attachment-offline.md" with { type: "text" };

/** Telemetry tag for the oneshot vision-description calls. */
const ONESHOT_KIND = "image_attachment_describe";

const NO_VISION_MODEL_NOTE =
	"[No vision-capable model is configured, so this image could not be described automatically. " +
	"The image was saved; configure a vision model role (modelRoles.vision) and read the saved image with ?q=<question> to analyze it.]";

const DESCRIPTION_UNAVAILABLE_NOTE =
	"[Image description unavailable: the vision model returned no usable text. The image was saved for further analysis.]";

/** Registry surface needed to resolve a vision model and authorize requests. */
export type VisionFallbackRegistry = Pick<
	ModelRegistry,
	"getAvailable" | "getAvailableForProviders" | "getApiKey" | "resolver"
>;

/** Whether user images sent to `model` should be replaced by a vision-model description. */
export function shouldDescribeImagesForTextModel(
	model: Model<Api> | undefined,
	settings: Settings,
): model is Model<Api> {
	return (
		!!model &&
		!sendsImageInputOnWire(model) &&
		!cfgImagesBlockImages.get(settings) &&
		cfgImagesDescribeForTextModels.get(settings)
	);
}

export interface DescribeAttachedImagesDeps {
	/** Active (text-only) model the prompt is destined for. */
	activeModel: Model<Api>;
	modelRegistry: VisionFallbackRegistry;
	settings: Settings;
	/** Inputs for resolving the session-scoped `local://` root. */
	localProtocolOptions: LocalProtocolOptions;
	/** `provider/id` of the active model; a last-resort vision-model candidate (filtered to image-capable). */
	activeModelString?: string;
	telemetryConfig?: AgentTelemetryConfig;
	sessionId?: string;
	/** Test seam: overrides the underlying completeSimple call. */
	completeImpl?: typeof completeSimple;
	/** The session tree's cost gate: at the cap images are not described, and each description's cost is added. */
	costGate?: CostGateApi;
	/** The session the images were attached to; each description request is journaled there as `image-describe`. */
	usageLedger?: Partial<ModelUsageLedger>;
}

/** Map an image MIME type to a file extension for the saved artifact. */
function extensionForMime(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
	switch (subtype) {
		case "jpeg":
		case "jpg":
			return "jpg";
		case "png":
			return "png";
		case "gif":
			return "gif";
		case "webp":
			return "webp";
		default: {
			const sanitized = subtype.replace(/[^a-z0-9]/g, "");
			return sanitized || "png";
		}
	}
}

/** Content-addressed file name so re-pasting the same image reuses one artifact. */
function imageFileName(image: ImageContent): string {
	const hash = Bun.hash(image.data).toString(16);
	return `image-${hash}.${extensionForMime(image.mimeType)}`;
}

/** Persist an image under the local root; returns its `local://` URL. */
async function saveImage(image: ImageContent, localRoot: string): Promise<string> {
	const fileName = imageFileName(image);
	const filePath = path.join(localRoot, fileName);
	// Content-addressed: identical bytes overwrite themselves harmlessly. Bun.write creates parent dirs.
	await Bun.write(filePath, Buffer.from(image.data, "base64"));
	return `local://${fileName}`;
}

function formatImageBlock(localUrl: string, description: string): string {
	return `<image path="${localUrl}">\n${description}\n</image>`;
}

/**
 * Resolve a vision-capable model, honoring explicit roles and the active model
 * before choosing the least expensive priced vision model as a last resort.
 * Offline mode (`models.offline`) keeps every candidate on the active model's provider.
 */
function resolveVisionModel(deps: DescribeAttachedImagesDeps): Model<Api> | undefined {
	const available = withoutDisabledModels(
		cfgOffline.get(deps.settings)
			? deps.modelRegistry.getAvailableForProviders(new Set([deps.activeModel.provider]))
			: deps.modelRegistry.getAvailable(),
		deps.settings,
	);
	if (available.length === 0) return undefined;
	const preferences = getModelMatchPreferences(deps.settings);
	const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, deps.settings);
		if (disabledSelectorRule(expanded, deps.settings, available)) return undefined;
		const model = resolveModelFromString(expanded, available, preferences);
		return model && sendsImageInputOnWire(model) && disabledModelRule(model, deps.settings) === undefined
			? model
			: undefined;
	};
	const preferred = resolvePattern("@vision") ?? resolvePattern("@default") ?? resolvePattern(deps.activeModelString);
	if (preferred) return preferred;

	let cheapest: Model<Api> | undefined;
	let cheapestPrice = Number.POSITIVE_INFINITY;
	let firstImageModel: Model<Api> | undefined;
	for (const model of available) {
		if (!sendsImageInputOnWire(model)) continue;
		firstImageModel ??= model;
		// Rows without a rate card rank last; a declared free row prices at 0.
		if (getModelPricingStatus(model) === "unknown") continue;
		const cost = getEffectiveTokenCost(model.cost);
		const price = cost.input + cost.output;
		if (price < cheapestPrice) {
			cheapest = model;
			cheapestPrice = price;
		}
	}
	return cheapest ?? firstImageModel;
}

/** Run one vision-description round-trip; returns trimmed text or `null` on any failure. */
async function describeImage(
	image: ImageContent,
	visionModel: Model<Api>,
	deps: DescribeAttachedImagesDeps,
	telemetry: AgentTelemetry | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	// Usage only: the request carries a fixed instruction and the image, and the description lands in the request
	// that needed it.
	const journal = journalCompletion(deps.usageLedger, { purpose: "image-describe", usageOnly: true });
	try {
		const response = await instrumentedCompleteSimple(
			withDisabledModelFallbackPolicy(visionModel, deps.settings),
			{
				systemPrompt: [prompt.render(describeSystemPrompt)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: image.data, mimeType: image.mimeType },
							{ type: "text", text: prompt.render(describeUserPrompt) },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: deps.modelRegistry.resolver(visionModel, deps.sessionId), signal },
			{ telemetry, oneshotKind: ONESHOT_KIND, completeImpl: deps.completeImpl },
		);
		deps.costGate?.record(response.usage.cost.total);
		journal?.(response);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			logger.warn("image attachment description did not complete", {
				stopReason: response.stopReason,
				model: `${visionModel.provider}/${visionModel.id}`,
			});
			return null;
		}
		const text = extractTextContent(response).trim();
		return text.length > 0 ? text : null;
	} catch (err) {
		logger.warn("image attachment description failed", {
			error: toError(err).message,
			model: `${visionModel.provider}/${visionModel.id}`,
		});
		return null;
	}
}

/**
 * One image's `<image path>` block and how it came about: `described` (final), `unrequested` (a note made
 * without a vision request: no vision model, or the cost cap; worth redoing once a request is possible), or
 * `failed` (the vision request gave nothing usable; worth redoing later).
 */
interface ImageDescription {
	text: string;
	outcome: "described" | "unrequested" | "failed";
}

/** Describes images for one text-only model: resolves the vision model once, then each image on demand. */
interface ImageDescriber {
	/** Whether a vision request can be made now. */
	canRequest(): boolean;
	describe(image: ImageContent, signal?: AbortSignal): Promise<ImageDescription>;
}

async function createImageDescriber(deps: DescribeAttachedImagesDeps): Promise<ImageDescriber> {
	const localRoot = resolveLocalRoot(deps.localProtocolOptions);
	const visionModel = resolveVisionModel(deps);
	const apiKey = visionModel ? await deps.modelRegistry.getApiKey(visionModel, deps.sessionId) : undefined;
	const telemetry = resolveTelemetry(deps.telemetryConfig, deps.sessionId);
	const canRequest = () =>
		!!visionModel &&
		!!apiKey &&
		disabledModelRule(visionModel, deps.settings) === undefined &&
		!deps.costGate?.check();
	const describe = async (image: ImageContent, signal?: AbortSignal): Promise<ImageDescription> => {
		const localUrl = await saveImage(image, localRoot);
		// Kept beside the saved image, so a resumed session does not pay for the description again.
		const saved = path.join(localRoot, `${imageFileName(image)}.description.md`);
		try {
			const description = (await Bun.file(saved).text()).trim();
			if (description) return { text: formatImageBlock(localUrl, description), outcome: "described" };
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (!visionModel || !apiKey) {
			const note =
				!visionModel && cfgOffline.get(deps.settings)
					? prompt.render(offlineNoVisionTemplate, { provider: deps.activeModel.provider }).trim()
					: NO_VISION_MODEL_NOTE;
			return { text: formatImageBlock(localUrl, note), outcome: "unrequested" };
		}
		if (!canRequest()) {
			return { text: formatImageBlock(localUrl, DESCRIPTION_UNAVAILABLE_NOTE), outcome: "unrequested" };
		}
		const description = await describeImage(image, visionModel, deps, telemetry, signal);
		if (!description) return { text: formatImageBlock(localUrl, DESCRIPTION_UNAVAILABLE_NOTE), outcome: "failed" };
		// Losing the saved copy only costs a resumed session another request; keep the paid-for description.
		await Bun.write(saved, description).catch(err =>
			logger.warn("could not save image description", { error: toError(err).message }),
		);
		return { text: formatImageBlock(localUrl, description), outcome: "described" };
	};
	return { canRequest, describe };
}

/**
 * Save each attached image under `local://` and replace it with a descriptive
 * text block. Returns one {@link TextContent} per input image, in order. Never
 * throws for an individual image: a failed description falls back to a note while
 * the saved-path block is still emitted.
 */
export async function describeAttachedImagesForTextModel(
	images: readonly ImageContent[],
	deps: DescribeAttachedImagesDeps,
	signal?: AbortSignal,
): Promise<TextContent[]> {
	const describer = await createImageDescriber(deps);
	return Promise.all(
		images.map(async (image): Promise<TextContent> => ({
			type: "text",
			text: (await describer.describe(image, signal)).text,
		})),
	);
}

/** Bounds each vision request, and how long a request to a text-only model waits for descriptions. */
const IMAGE_DESCRIPTION_TIMEOUT_MS = 20_000;
/** Past a vision request's timeout, how long its caller still waits for the outcome to be recorded. */
const IMAGE_DESCRIPTION_SETTLE_GRACE_MS = 1_000;
/** Vision requests in flight at once: a switch to a text-only model may need one per image in history. */
const IMAGE_DESCRIPTION_CONCURRENCY = 4;
/** How long a failed vision request stands before the next use asks again. */
const FAILED_DESCRIPTION_RETRY_MS = 60_000;
const IMAGE_DESCRIPTION_CACHE_MAX_ENTRIES = 512;

/** What {@link ImageDescriptions} reads per use; the model the images go to is given each time. */
export type ImageDescriptionDeps = Omit<DescribeAttachedImagesDeps, "activeModel" | "activeModelString"> & {
	/** Test seam: overrides {@link IMAGE_DESCRIPTION_TIMEOUT_MS}. */
	timeoutMs?: number;
};

/** Roles whose image blocks are the user's input images; summary archive frames excluded. */
const DESCRIBABLE_ROLES: Record<string, true> = { user: true, developer: true, custom: true, hookMessage: true };

/** The content blocks of a message whose images a description stands in for, or undefined. */
function describableContent(message: Message | AgentMessage): (TextContent | ImageContent)[] | undefined {
	if (!DESCRIBABLE_ROLES[message.role] || !("content" in message) || !Array.isArray(message.content)) return;
	if ("historyRewriteAt" in message && message.historyRewriteAt !== undefined) return;
	return message.content as (TextContent | ImageContent)[];
}

function describableImages(messages: readonly (Message | AgentMessage)[]): ImageContent[] {
	const images: ImageContent[] = [];
	for (const message of messages) {
		for (const block of describableContent(message) ?? []) {
			if (block.type === "image" && block.data) images.push(block);
		}
	}
	return images;
}

interface DescriptionEntry {
	/** The `<image path>` block of the latest settled attempt; kept while a retry is in flight. */
	text?: string;
	outcome?: ImageDescription["outcome"];
	/** For a `failed` outcome: when the next use may ask again. */
	retryAt?: number;
	/** The attempt in flight, if any. */
	pending?: Promise<void>;
}

/**
 * Vision-model descriptions of input images for models that cannot see them, decided per use from the
 * model the images go to: a text-only model gets each image replaced by its description, a vision model
 * the image itself, so every model switch is followed, history included. Each image is described once per
 * session; a resumed session reads the description from beside the saved image.
 */
export class ImageDescriptions {
	readonly #getDeps: () => ImageDescriptionDeps;
	readonly #entries = new LRUCache<string, DescriptionEntry>({ max: IMAGE_DESCRIPTION_CACHE_MAX_ENTRIES });

	constructor(getDeps: () => ImageDescriptionDeps) {
		this.#getDeps = getDeps;
	}

	/** Whether images sent to `model` must be replaced by their descriptions. */
	describesFor(model: Model<Api> | undefined): model is Model<Api> {
		return shouldDescribeImagesForTextModel(model, this.#getDeps().settings);
	}

	/** The first of `models` that cannot see images, which a description must therefore be made for. */
	textOnlyModel(...models: (Model<Api> | undefined)[]): Model<Api> | undefined {
		return models.find(model => this.describesFor(model));
	}

	/** Provider-context transform: describes a text-only request's input images. */
	readonly transform = async (context: Context, model: Model<Api>, signal?: AbortSignal): Promise<Context> => {
		if (!this.describesFor(model)) return context;
		const images = describableImages(context.messages);
		if (images.length === 0) return context;
		await this.#prepareImages(images, model, signal);
		return { ...context, messages: context.messages.map(message => this.withDescriptions(message)) };
	};

	/**
	 * Describe the input images of `messages` for `model` when it cannot see them, so
	 * {@link withDescriptions} can apply the results synchronously. The vision requests are not tied to
	 * `signal`: an aborted caller leaves them to finish for the next use.
	 */
	async prepare(
		messages: readonly (Message | AgentMessage)[],
		model: Model<Api> | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.describesFor(model)) await this.#prepareImages(describableImages(messages), model, signal);
	}

	async #prepareImages(images: readonly ImageContent[], model: Model<Api>, signal?: AbortSignal): Promise<void> {
		if (images.length === 0) return;
		const { timeoutMs = IMAGE_DESCRIPTION_TIMEOUT_MS, ...baseDeps } = this.#getDeps();
		const deps: DescribeAttachedImagesDeps = {
			...baseDeps,
			activeModel: model,
			activeModelString: formatModelString(model),
		};
		const localRoot = resolveLocalRoot(deps.localProtocolOptions);
		const waits: Promise<void>[] = [];
		const due: { key: string; image: ImageContent; entry: DescriptionEntry }[] = [];
		const now = Date.now();
		for (const image of images) {
			const key = `${localRoot}\0${imageFileName(image)}`;
			let entry = this.#entries.get(key);
			if (entry?.pending) {
				waits.push(entry.pending);
				continue;
			}
			if (entry?.outcome === "described") continue;
			if (entry?.outcome === "failed" && now < (entry.retryAt ?? 0)) continue;
			if (due.some(item => item.key === key)) continue;
			if (!entry) {
				entry = {};
				this.#entries.set(key, entry);
			}
			due.push({ key, image, entry });
		}
		if (due.length > 0) {
			// Claimed before any await, so a concurrent use waits on this run instead of starting its own.
			// Not tied to `signal`: an aborted caller leaves the descriptions to finish for the next use.
			const run = this.#describeDue(due, deps, timeoutMs);
			for (const item of due) item.entry.pending = run;
			waits.push(run);
		}
		if (waits.length === 0) return;
		// Wait about one request's timeout (plus room to save what it returned): with many images queued behind
		// the concurrency cap, the rest finish detached, and this request sends those not yet described as they are.
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(deadline.resolve, timeoutMs + IMAGE_DESCRIPTION_SETTLE_GRACE_MS);
		timer.unref?.();
		try {
			await untilAborted(signal, Promise.race([Promise.all(waits), deadline.promise]));
		} finally {
			clearTimeout(timer);
		}
	}

	async #describeDue(
		due: readonly { key: string; image: ImageContent; entry: DescriptionEntry }[],
		deps: DescribeAttachedImagesDeps,
		timeoutMs: number,
	): Promise<void> {
		let describer: Promise<ImageDescriber> | undefined;
		const getDescriber = () => (describer ??= createImageDescriber(deps));
		try {
			// A note made without a request stays until a request is possible: redoing it would only rewrite the
			// saved image and give the same note.
			let work = due;
			if (due.some(item => item.entry.outcome === "unrequested")) {
				const canRequest = await getDescriber().then(
					found => found.canRequest(),
					() => false,
				);
				if (!canRequest) work = due.filter(item => item.entry.outcome !== "unrequested");
			}
			// Newest first: the image the current prompt asks about must not wait behind a history backlog that
			// the caller's wait cannot cover.
			let next = work.length;
			// A failed request means the vision model is failing now: the rest of this run waits for the retry
			// delay instead of queueing more requests against it.
			let failing = false;
			const worker = async (): Promise<void> => {
				for (let item = work[--next]; item; item = work[--next]) {
					if (failing) {
						item.entry.outcome ??= "failed";
						if (item.entry.outcome === "failed") item.entry.retryAt = Date.now() + FAILED_DESCRIPTION_RETRY_MS;
						continue;
					}
					await this.#describe(item.key, item.entry, item.image, getDescriber, timeoutMs);
					if (item.entry.outcome === "failed") failing = true;
				}
			};
			await Promise.all(Array.from({ length: Math.min(IMAGE_DESCRIPTION_CONCURRENCY, work.length) }, worker));
		} finally {
			for (const item of due) item.entry.pending = undefined;
		}
	}

	async #describe(
		key: string,
		entry: DescriptionEntry,
		image: ImageContent,
		getDescriber: () => Promise<ImageDescriber>,
		timeoutMs: number,
	): Promise<void> {
		try {
			const describer = await getDescriber();
			const result = await describer.describe(image, AbortSignal.timeout(timeoutMs));
			entry.text = result.text;
			entry.outcome = result.outcome;
			entry.retryAt = result.outcome === "failed" ? Date.now() + FAILED_DESCRIPTION_RETRY_MS : undefined;
		} catch (err) {
			// Nothing was made (saving the image failed): forget the entry so the next use starts over.
			if (entry.text === undefined && this.#entries.get(key) === entry) this.#entries.delete(key);
			logger.warn("image description for a text-only model failed; image left undescribed", {
				error: toError(err).message,
			});
		}
	}

	/** `message` with each image that has a description replaced by it; other images stay. */
	withDescriptions<M extends Message | AgentMessage>(message: M): M {
		const content = describableContent(message);
		if (!content?.some(block => block.type === "image")) return message;
		const localRoot = resolveLocalRoot(this.#getDeps().localProtocolOptions);
		let replaced = false;
		const described = content.map(block => {
			if (block.type !== "image" || !block.data) return block;
			const text = this.#entries.get(`${localRoot}\0${imageFileName(block)}`)?.text;
			if (text === undefined) return block;
			replaced = true;
			return { type: "text", text } satisfies TextContent;
		});
		return replaced ? { ...message, content: described } : message;
	}
}

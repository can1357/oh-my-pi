import { countTokens } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent, Message, Model } from "@pk-nerdsaver-ai/pi-ai";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";
import banner from "./background-pack-banner.md" with { type: "text" };
import type { ResolvedBackgroundPack } from "./manifest";
import {
	type BackgroundPackModelProfile,
	type BackgroundPackModelQualification,
	backgroundPackModelFingerprint,
	backgroundPackShapeFingerprint,
	VALIDATED_BACKGROUND_PACK_MODELS,
} from "./model-qualification";

const MIN_SAVINGS_TOKENS = 128;
const MIN_SAVINGS_RATIO = 0.1;
const DEFAULT_CACHE_MAX_ENTRIES = 16;

export type BackgroundPackRuntimeWarningCode =
	| "model-not-qualified"
	| "model-not-vision"
	| "pack-unprofitable"
	| "provider-image-budget"
	| "pack-render-failed";

export interface BackgroundPackRuntimeWarning {
	code: BackgroundPackRuntimeWarningCode;
	message: string;
}

export interface PreparedBackgroundPacks {
	messages: Message[];
	warnings: BackgroundPackRuntimeWarning[];
}

export interface BackgroundPackRendererDependencies {
	qualifications?: Readonly<Record<string, BackgroundPackModelQualification>>;
	renderMany?: typeof snapcompact.renderMany;
	cacheMaxEntries?: number;
}

export interface BackgroundPackPrepareOptions {
	/** Images already present in the outgoing request context. */
	reservedImageCount?: number;
}

function modelProfile(model: Model): BackgroundPackModelProfile {
	return {
		provider: model.provider,
		api: model.api,
		id: model.id,
		requestModelId: model.requestModelId ?? model.id,
		baseUrl: model.baseUrl,
		input: model.input,
	};
}

function qualificationFor(
	model: Model,
	shape: snapcompact.Shape,
	qualifications: Readonly<Record<string, BackgroundPackModelQualification>>,
): BackgroundPackModelQualification | undefined {
	const profile = modelProfile(model);
	const modelFingerprint = backgroundPackModelFingerprint(profile);
	const qualification = qualifications[modelFingerprint];
	if (!qualification) return undefined;
	if (qualification.modelFingerprint !== modelFingerprint) return undefined;
	if (qualification.shapeFingerprint !== backgroundPackShapeFingerprint(shape)) return undefined;
	return qualification;
}

export class BackgroundPackRenderer {
	#cache = new Map<string, ImageContent[]>();
	#cacheMaxEntries: number;
	#qualifications: Readonly<Record<string, BackgroundPackModelQualification>>;
	#renderMany: typeof snapcompact.renderMany;

	constructor(dependencies: BackgroundPackRendererDependencies = {}) {
		const requestedCacheMax = dependencies.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
		this.#cacheMaxEntries =
			Number.isSafeInteger(requestedCacheMax) && requestedCacheMax >= 0
				? requestedCacheMax
				: DEFAULT_CACHE_MAX_ENTRIES;
		this.#qualifications = dependencies.qualifications ?? VALIDATED_BACKGROUND_PACK_MODELS;
		this.#renderMany = dependencies.renderMany ?? snapcompact.renderMany;
	}

	#getCached(cacheKey: string): ImageContent[] | undefined {
		const images = this.#cache.get(cacheKey);
		if (!images) return undefined;
		this.#cache.delete(cacheKey);
		this.#cache.set(cacheKey, images);
		return images;
	}

	#cacheImages(cacheKey: string, images: ImageContent[]): void {
		if (this.#cacheMaxEntries === 0) return;
		this.#cache.delete(cacheKey);
		this.#cache.set(cacheKey, images);
		while (this.#cache.size > this.#cacheMaxEntries) {
			const oldest = this.#cache.keys().next();
			if (oldest.done) break;
			this.#cache.delete(oldest.value);
		}
	}

	async prepare(
		packs: readonly ResolvedBackgroundPack[],
		model: Model,
		options: BackgroundPackPrepareOptions = {},
	): Promise<PreparedBackgroundPacks> {
		if (packs.length === 0) return { messages: [], warnings: [] };
		if (!model.input.includes("image")) {
			return {
				messages: [],
				warnings: [
					{ code: "model-not-vision", message: "Background packs skipped: the active model cannot read images." },
				],
			};
		}

		let shape: snapcompact.Shape;
		let qualification: BackgroundPackModelQualification | undefined;
		let providerImageBudget: number;
		try {
			shape = snapcompact.resolveShape(model);
			qualification = qualificationFor(model, shape, this.#qualifications);
			providerImageBudget = snapcompact.providerImageBudget(model.provider);
		} catch {
			return {
				messages: [],
				warnings: [
					{
						code: "pack-render-failed",
						message: "Background packs skipped: optional image preparation failed.",
					},
				],
			};
		}
		if (!qualification) {
			return {
				messages: [],
				warnings: [
					{
						code: "model-not-qualified",
						message:
							"Background packs skipped: the exact active model profile has not passed image-context qualification.",
					},
				],
			};
		}

		const reservedImageCount = options.reservedImageCount ?? 0;
		const normalizedReservedImageCount =
			Number.isSafeInteger(reservedImageCount) && reservedImageCount >= 0 ? reservedImageCount : providerImageBudget;
		let remainingImages = Math.max(0, providerImageBudget - normalizedReservedImageCount);
		const messages: Message[] = [];
		const warnings: BackgroundPackRuntimeWarning[] = [];
		for (const [packIndex, pack] of packs.entries()) {
			try {
				const frameCount = snapcompact.frames(pack.text, { shape });
				const textTokens = countTokens(pack.text);
				if (!Number.isSafeInteger(frameCount) || frameCount < 0 || !Number.isFinite(textTokens)) {
					throw new Error("invalid background-pack sizing result");
				}
				const imageTokens = frameCount * shape.frameTokenEstimate + countTokens(banner);
				const savings = textTokens - imageTokens;
				if (
					frameCount === 0 ||
					savings < MIN_SAVINGS_TOKENS ||
					savings / Math.max(1, textTokens) < MIN_SAVINGS_RATIO
				) {
					warnings.push({
						code: "pack-unprofitable",
						message: `Background pack ${packIndex + 1} skipped: image encoding would not save enough uncached input tokens.`,
					});
					continue;
				}
				if (frameCount > remainingImages) {
					warnings.push({
						code: "provider-image-budget",
						message: `Background pack ${packIndex + 1} skipped: it exceeds the provider image budget.`,
					});
					continue;
				}

				const cacheKey = new Bun.CryptoHasher("sha256")
					.update(
						JSON.stringify([
							pack.contentHash,
							qualification.modelFingerprint,
							qualification.shapeFingerprint,
							qualification.artifact,
						]),
					)
					.digest("hex");
				let images = this.#getCached(cacheKey);
				if (!images) {
					const rendered: unknown = await this.#renderMany(pack.text, { shape, maxFrames: frameCount });
					if (!isRenderedImageArray(rendered)) throw new Error("invalid background-pack render result");
					images = rendered;
					this.#cacheImages(cacheKey, images);
				}
				if (images.length > remainingImages) {
					warnings.push({
						code: "provider-image-budget",
						message: `Background pack ${packIndex + 1} skipped: rendered images exceed the remaining provider budget.`,
					});
					continue;
				}
				remainingImages -= images.length;
				messages.push({
					role: "user",
					synthetic: true,
					content: [{ type: "text", text: banner }, ...images],
					timestamp: Date.now(),
				});
			} catch {
				warnings.push({
					code: "pack-render-failed",
					message: `Background pack ${packIndex + 1} skipped: optional image rendering failed.`,
				});
			}
		}
		return { messages, warnings };
	}
}

function isRenderedImageArray(value: unknown): value is ImageContent[] {
	if (!Array.isArray(value) || value.length === 0) return false;
	return value.every(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as Record<string, unknown>;
		return (
			candidate.type === "image" &&
			typeof candidate.data === "string" &&
			candidate.data.length > 0 &&
			typeof candidate.mimeType === "string" &&
			candidate.mimeType.startsWith("image/")
		);
	});
}

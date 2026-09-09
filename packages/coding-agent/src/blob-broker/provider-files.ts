import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { contextHasImages, decorateContextProviderFiles } from "./context-images";
import {
	hashProviderFileContent,
	hashProviderFileCredential,
	type ProviderFileCache,
	type ProviderFileCacheEntry,
	type ProviderFileCacheStatus,
	type ProviderFileClient,
	type ProviderFileHandle,
	toProviderFileReference,
} from "./provider-file-types";
import { createAnthropicFileClient } from "./provider-files-anthropic";
import { createGeminiProviderFileClient } from "./provider-files-gemini";
import { createOpenAIFileClient } from "./provider-files-openai";

/** Resolve the current account credential for a model without retaining it. */
export type ProviderFileCredentialResolver = (model: Model) => Promise<string | undefined>;

/** Select a provider-native file client for a model and resolved credential. */
export type ProviderFileClientFactory = (model: Model, credential: string) => ProviderFileClient | null;

const DEFAULT_CLIENT_FACTORIES: readonly ProviderFileClientFactory[] = [
	createGeminiProviderFileClient,
	createAnthropicFileClient,
	createOpenAIFileClient,
];

function imageBlocks(context: Context): ImageContent[] {
	const blocks: ImageContent[] = [];
	for (const message of context.messages) {
		if (
			(message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "image") blocks.push(block);
		}
	}
	return blocks;
}

function decodeImage(block: ImageContent): Uint8Array | undefined {
	if (block.data.length === 0) return undefined;
	try {
		return new Uint8Array(Buffer.from(block.data, "base64"));
	} catch {
		return undefined;
	}
}

/**
 * Account-scoped provider-file orchestration for outbound contexts.
 *
 * Session messages are never mutated: references are attached only to the
 * structural copy handed to a provider request, while inline data remains the
 * required source of truth for later URL and base64 recovery.
 */
export class ProviderFileManager {
	readonly #cache: ProviderFileCache;
	readonly #resolveCredential: ProviderFileCredentialResolver;
	readonly #factories: readonly ProviderFileClientFactory[];
	readonly #uploads = new Map<string, Promise<ProviderFileHandle>>();

	constructor(
		cache: ProviderFileCache,
		resolveCredential: ProviderFileCredentialResolver,
		factories: readonly ProviderFileClientFactory[] = DEFAULT_CLIENT_FACTORIES,
	) {
		this.#cache = cache;
		this.#resolveCredential = resolveCredential;
		this.#factories = factories;
	}

	async decorateContext(context: Context, model: Model): Promise<Context> {
		if (!model.input.includes("image") || !contextHasImages(context)) return context;
		const images = imageBlocks(context);
		if (!images.some(block => !block.url && block.data.length > 0)) return context;

		let credential: string | undefined;
		try {
			credential = await this.#resolveCredential(model);
		} catch (error) {
			logger.warn("blob-broker: provider-file credential resolution failed; trying next image backend", {
				provider: model.provider,
				error: error instanceof Error ? error.message : String(error),
			});
			return context;
		}
		if (!credential) return context;
		let client: ProviderFileClient | null;
		try {
			client = this.#clientFor(model, credential);
		} catch (error) {
			logger.warn("blob-broker: provider-file client unavailable; trying next image backend", {
				provider: model.provider,
				error: error instanceof Error ? error.message : String(error),
			});
			return context;
		}
		if (!client) return context;
		const candidates = images.filter(
			block => !block.url && block.data.length > 0 && block.providerFile?.provider !== client.provider,
		);
		if (candidates.length === 0) return context;

		const referenceByBlock = new Map<ImageContent, ImageContent["providerFile"]>();
		const groups = new Map<string, { bytes: Uint8Array; blocks: ImageContent[] }>();
		for (const block of candidates) {
			const bytes = decodeImage(block);
			if (!bytes) continue;
			const hash = hashProviderFileContent(bytes);
			const group = groups.get(hash);
			if (group) group.blocks.push(block);
			else groups.set(hash, { bytes, blocks: [block] });
		}

		await Promise.all(
			[...groups].map(async ([hash, group]) => {
				try {
					const handle = await this.#ensureHandle(client, credential, hash, group.bytes, group.blocks[0].mimeType);
					const reference = toProviderFileReference(handle);
					for (const block of group.blocks) referenceByBlock.set(block, reference);
				} catch (error) {
					logger.warn("blob-broker: provider-file upload failed; trying next image backend", {
						provider: model.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		return referenceByBlock.size === 0
			? context
			: decorateContextProviderFiles(context, block => referenceByBlock.get(block));
	}

	/** Remove cached handles carried by a provider-rejected request. */
	async invalidateContext(context: Context, model: Model): Promise<void> {
		const blocks = imageBlocks(context).filter(block => block.providerFile !== undefined && block.data.length > 0);
		if (blocks.length === 0) return;
		let credential: string | undefined;
		try {
			credential = await this.#resolveCredential(model);
		} catch {
			return;
		}
		if (!credential) return;
		for (const block of blocks) {
			const bytes = decodeImage(block);
			if (!bytes || !block.providerFile) continue;
			this.#cache.delete(block.providerFile.provider, credential, hashProviderFileContent(bytes));
		}
	}

	status(): ProviderFileCacheStatus {
		return this.#cache.status();
	}

	deleteAll(): readonly ProviderFileCacheEntry[] {
		return this.#cache.deleteAll();
	}

	save(): void {
		this.#cache.save();
	}

	#clientFor(model: Model, credential: string): ProviderFileClient | null {
		for (const factory of this.#factories) {
			const client = factory(model, credential);
			if (client) return client;
		}
		return null;
	}

	#ensureHandle(
		client: ProviderFileClient,
		credential: string,
		contentHash: string,
		bytes: Uint8Array,
		mimeType: string,
	): Promise<ProviderFileHandle> {
		const cached = this.#cache.get(client.provider, credential, contentHash);
		if (cached) return Promise.resolve(cached);
		const key = JSON.stringify([client.provider, hashProviderFileCredential(credential), contentHash]);
		let pending = this.#uploads.get(key);
		if (!pending) {
			pending = client.upload({ bytes, mimeType }).then(handle => {
				this.#cache.set(client.provider, credential, contentHash, handle);
				return handle;
			});
			this.#uploads.set(key, pending);
			void pending.finally(() => this.#uploads.delete(key)).catch(() => undefined);
		}
		return pending;
	}
}

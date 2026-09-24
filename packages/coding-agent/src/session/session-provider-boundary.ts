/** Provider-facing message, image, secret, and stream normalization for a session. */

import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { AssistantMessage, ImageContent, Message, Model, SimpleStreamOptions, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { InternalUrlRouter, type LocalProtocolOptions } from "../internal-urls";
import { deobfuscateSessionContext, obfuscateMessages } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { stripPendingSecretPlaceholderSuffix } from "../secrets/placeholder";
import { normalizeModelContextImages } from "../utils/image-loading";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { type CustomMessage, convertToLlm } from "./messages";
import { IMAGE_ATTACHMENT_DESCRIPTION_TYPE } from "./queued-messages";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import type { SessionManager } from "./session-manager";

import { cfgImagesBlockImages } from "../modes/settings";
import {
	cfgImagesDescribeForTextModels,
	cfgModelLoopGuardCheckAssistantContent,
	cfgModelLoopGuardEnabled,
	cfgProvidersAntigravityEndpoint,
	cfgProvidersMaxInFlightRequests,
	cfgProvidersOpenrouterVariant,
	validateProviderMaxInFlightRequests,
} from "./settings";

type NormalizableContentBlock = AssistantMessage["content"][number] | TextContent | ImageContent;

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionProviderBoundaryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
	sessionId(): string;
	localProtocolOptions(): LocalProtocolOptions;
	transformContext(messages: AgentMessage[], signal?: AbortSignal): AgentMessage[] | Promise<AgentMessage[]>;
	convertToLlm(messages: AgentMessage[]): Message[] | Promise<Message[]>;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	/** Current secret obfuscator; swapped when `secrets.enabled` turns on mid-session. */
	obfuscator(): SecretObfuscator | undefined;
}

/** Owns the transformations at the session/provider boundary. */
export class SessionProviderBoundary {
	readonly #host: SessionProviderBoundaryHost;

	constructor(host: SessionProviderBoundaryHost) {
		this.#host = host;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): { label: string; uri: string; image: ImageContent; sourcePath: string }[] {
		for (let i = this.#host.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.#host.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.flatMap((image, index) => {
				const label = `Image #${index + 1}`;
				const uri = `attachment://${index + 1}`;
				// File-backed attachments resolve to their file so tools and clickable links
				// open it. Clipboard images committed to the session carry an internal URL,
				// located against the session's current root so `/move` keeps them readable.
				// Payloads without a file materialize a blob copy instead.
				const source = imageAttachmentSource(image)?.path;
				try {
					if (source) {
						const router = InternalUrlRouter.instance();
						if (!router.canHandle(source)) return [{ label, uri, image, sourcePath: source }];
						const sourcePath = router.locateSync(source, {
							localProtocolOptions: this.#host.localProtocolOptions(),
						});
						if (sourcePath === undefined) throw new Error(`No local file backs ${source}`);
						return [{ label, uri, image, sourcePath }];
					}
					const sourcePath = this.#host.sessionManager.putBlobSync(Buffer.from(image.data, "base64"), {
						extension: blobExtensionForImageMimeType(image.mimeType),
					}).displayPath;
					return [{ label, uri, image, sourcePath }];
				} catch (error) {
					logger.warn("failed to materialize image attachment; attachment omitted", {
						label,
						error: error instanceof Error ? error.message : String(error),
					});
					return [];
				}
			});
		}
		return [];
	}

	/** Builds the current deobfuscated context for agent display and replay. */
	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.#host.sessionManager.buildSessionContext(), this.#host.obfuscator());
	}

	/** Builds the full display-only transcript context. */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return deobfuscateSessionContext(
			this.#host.sessionManager.buildSessionContext({
				transcript: true,
				collapseCompactedHistory: options?.collapseCompactedHistory,
				keepDanglingToolCalls: options?.keepDanglingToolCalls,
			}),
			this.#host.obfuscator(),
		);
	}

	/** Obfuscates optional plaintext before a provider request. */
	obfuscateText(text: string | undefined): string | undefined {
		const obfuscator = this.#host.obfuscator();
		if (!text || !obfuscator?.obfuscates()) return text;
		return obfuscator.obfuscate(text);
	}

	/** Obfuscates summaries and snapcompact plaintext carried into compaction. */
	obfuscateCompactionPreparation(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#host.obfuscator()?.obfuscates()) return preparation;
		const previousSummary = this.obfuscateText(preparation.previousSummary);
		const previousPreserveData = this.#obfuscatePreservedArchiveText(preparation.previousPreserveData);
		if (
			previousSummary === preparation.previousSummary &&
			previousPreserveData === preparation.previousPreserveData
		) {
			return preparation;
		}
		return { ...preparation, previousSummary, previousPreserveData };
	}

	/** Deobfuscates provider text before exposing it to the session. */
	deobfuscateText(text: string): string {
		const obfuscator = this.#host.obfuscator();
		if (!obfuscator?.hasSecrets()) return text;
		return obfuscator.deobfuscate(text);
	}

	/** Deobfuscates a streamed delta and removes an incomplete secret placeholder suffix. */
	deobfuscateDelta(text: string): string {
		const deobfuscated = this.deobfuscateText(text);
		if (!this.#host.obfuscator()?.hasSecrets()) return deobfuscated;
		return stripPendingSecretPlaceholderSuffix(deobfuscated);
	}

	/** Converts side-request messages through the session's secret boundary. */
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		const obfuscator = this.#host.obfuscator();
		return obfuscator ? obfuscateMessages(obfuscator, converted) : converted;
	}

	/** Converts session messages using the configured pre-LLM pipeline. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#host.transformContext(messages, signal);
		return await this.#host.convertToLlm(transformedMessages);
	}

	/** Applies session-level stream hooks and provider defaults to a side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		const sessionOnPayload = this.#host.onPayload;
		const sessionOnResponse = this.#host.onResponse;
		const sessionMetadata = this.#host.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#host.onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? cfgProvidersOpenrouterVariant.get(this.#host.settings) : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? cfgProvidersAntigravityEndpoint.get(this.#host.settings) : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? cfgProvidersMaxInFlightRequests.get(this.#host.settings),
			),
			loopGuard: {
				enabled: cfgModelLoopGuardEnabled.get(this.#host.settings),
				checkAssistantContent: cfgModelLoopGuardCheckAssistantContent.get(this.#host.settings),
				...options.loopGuard,
			},
		};

		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			const requestOnPayload = options.onPayload;
			preparedOptions.onPayload = async (payload, model) => {
				const sessionPayload = options.signal
					? await sessionOnPayload(payload, model, options.signal)
					: await sessionOnPayload(payload, model);
				options.signal?.throwIfAborted();
				const sessionResolvedPayload = sessionPayload ?? payload;
				if (!requestOnPayload) return sessionResolvedPayload;
				const requestPayload = options.signal
					? await requestOnPayload(sessionResolvedPayload, model, options.signal)
					: await requestOnPayload(sessionResolvedPayload, model);
				options.signal?.throwIfAborted();
				return requestPayload ?? sessionResolvedPayload;
			};
		}

		if (sessionOnResponse) {
			const requestOnResponse = options.onResponse;
			preparedOptions.onResponse = async (response, model) => {
				if (options.signal) await sessionOnResponse(response, model, options.signal);
				else await sessionOnResponse(response, model);
				if (requestOnResponse) {
					if (options.signal) await requestOnResponse(response, model, options.signal);
					else await requestOnResponse(response, model);
				}
			};
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Normalizes image payloads for the active model. */
	normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.#host.model() });
	}

	/** Builds a hidden vision-model description for attachments sent to a text-only model. */
	async buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.#host.model();
		const shouldDescribe =
			!!model &&
			!sendsImageInputOnWire(model) &&
			!cfgImagesBlockImages.get(this.#host.settings) &&
			cfgImagesDescribeForTextModels.get(this.#host.settings);
		if (!shouldDescribe || !model) return undefined;

		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#host.modelRegistry,
					settings: this.#host.settings,
					localProtocolOptions: this.#host.localProtocolOptions(),
					activeModelString: formatModelString(model),
					telemetryConfig: this.#host.agent.telemetry,
					sessionId: this.#host.sessionId(),
				},
				signal,
			);
		} catch (error) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (blocks.length === 0) return undefined;
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	/** Normalizes every image embedded in an agent message. */
	async normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) return message;
		const normalized = await this.#normalizeMessageContentImages(content);
		if (normalized === content) return message;
		return Object.assign({}, message, { content: normalized });
	}

	async #normalizeMessageContentImages(
		content: string | NormalizableContentBlock[],
	): Promise<string | NormalizableContentBlock[]> {
		if (typeof content === "string") return content;
		const images = content.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return content;
		const normalizedImages = await this.normalizeImagesForModel(images);
		if (!normalizedImages) return content;
		let imageIndex = 0;
		return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
	}

	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		const obfuscator = this.#host.obfuscator();
		const slot = preserveData?.[snapcompact.PRESERVE_KEY];
		if (
			!obfuscator?.obfuscates() ||
			!preserveData ||
			!isRecord(slot) ||
			!snapcompact.getPreservedArchive(preserveData)
		) {
			return preserveData;
		}
		const obfuscated: Record<string, unknown> = { ...slot };
		let changed = false;
		for (const key of ["text", "textHead", "textTail"] as const) {
			const value = slot[key];
			if (typeof value !== "string" || value.length === 0) continue;
			const next = obfuscator.obfuscate(value);
			if (next === value) continue;
			obfuscated[key] = next;
			changed = true;
		}
		return changed ? { ...preserveData, [snapcompact.PRESERVE_KEY]: obfuscated } : preserveData;
	}
}

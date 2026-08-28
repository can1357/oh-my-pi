/** Provider-facing message, image, secret, and stream normalization for a session. */

import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, SimpleStreamOptions, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { validateProviderMaxInFlightRequests } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import { deobfuscateSessionContext, obfuscateMessages } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { stripPendingSecretPlaceholderSuffix } from "../secrets/placeholder";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { blobExtensionForImageMimeType } from "./blob-store";
import { type CustomMessage, convertToLlm } from "./messages";
import { IMAGE_ATTACHMENT_DESCRIPTION_TYPE } from "./queued-messages";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import type { SessionManager } from "./session-manager";

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
	obfuscator: SecretObfuscator | undefined;
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
				try {
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
		return deobfuscateSessionContext(this.#host.sessionManager.buildSessionContext(), this.#host.obfuscator);
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
			this.#host.obfuscator,
		);
	}

	/** Obfuscates optional plaintext before a provider request. */
	obfuscateText(text: string | undefined): string | undefined {
		if (!text || !this.#host.obfuscator?.hasSecrets()) return text;
		return this.#host.obfuscator.obfuscate(text);
	}

	/** Obfuscates summaries and snapcompact plaintext carried into compaction. */
	obfuscateCompactionPreparation(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#host.obfuscator?.hasSecrets()) return preparation;
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
		if (!this.#host.obfuscator?.hasSecrets()) return text;
		return this.#host.obfuscator.deobfuscate(text);
	}

	/** Deobfuscates a streamed delta and removes an incomplete secret placeholder suffix. */
	deobfuscateDelta(text: string): string {
		const deobfuscated = this.deobfuscateText(text);
		if (!this.#host.obfuscator?.hasSecrets()) return deobfuscated;
		return stripPendingSecretPlaceholderSuffix(deobfuscated);
	}

	/** Converts side-request messages through the session's secret boundary. */
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		return this.#host.obfuscator?.hasSecrets() ? obfuscateMessages(this.#host.obfuscator, converted) : converted;
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
			provider === "openrouter" ? this.#host.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.#host.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? this.#host.settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: this.#host.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.#host.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
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
			!model.input.includes("image") &&
			!this.#host.settings.get("images.blockImages") &&
			this.#host.settings.get("images.describeForTextModels");
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
		const obfuscator = this.#host.obfuscator;
		const slot = preserveData?.[snapcompact.PRESERVE_KEY];
		if (
			!obfuscator?.hasSecrets() ||
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

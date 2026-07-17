import type { ChatAdapter, ChatDraft, ChatMessage, ChatTargetIdentity, IxTransport, PreparedDispatch } from "./types";

const MAX_READ_MESSAGES = 50;

export class MessagingIxError extends Error {
	readonly phase: "read" | "prepare_dispatch" | "dispatch" | "verify";
	constructor(phase: MessagingIxError["phase"], message: string) {
		super(message);
		this.name = "MessagingIxError";
		this.phase = phase;
	}
}
export function validateAdapterTarget(
	target: ChatTargetIdentity,
	provider: ChatTargetIdentity["provider"],
	supportedHosts: readonly string[],
): void {
	if (target.provider !== provider || target.identityFingerprint.length !== 64 || !target.canonicalUrl) {
		throw new MessagingIxError("prepare_dispatch", "target lacks a provider-stable identity");
	}
	let host: string;
	try {
		host = new URL(target.canonicalUrl).hostname.toLowerCase();
	} catch (error) {
		if (error instanceof TypeError) {
			throw new MessagingIxError("prepare_dispatch", "target canonical URL is invalid");
		}
		throw error;
	}
	if (!supportedHosts.includes(host)) {
		throw new MessagingIxError("prepare_dispatch", "target host is unsupported for this provider");
	}
}

function parseMessage(value: unknown): ChatMessage {
	if (
		typeof value !== "object" ||
		value === null ||
		!("providerMessageId" in value) ||
		typeof value.providerMessageId !== "string" ||
		value.providerMessageId.length === 0 ||
		!("targetFingerprint" in value) ||
		typeof value.targetFingerprint !== "string" ||
		!("body" in value) ||
		typeof value.body !== "string" ||
		value.body.length > 16_384 ||
		!("deliveryState" in value) ||
		(value.deliveryState !== "delivered" &&
			value.deliveryState !== "pending" &&
			value.deliveryState !== "failed" &&
			value.deliveryState !== "unknown") ||
		!("author" in value) ||
		typeof value.author !== "object" ||
		value.author === null ||
		!("displayName" in value.author) ||
		typeof value.author.displayName !== "string" ||
		!("isSelf" in value.author) ||
		typeof value.author.isSelf !== "boolean"
	) {
		throw new MessagingIxError("verify", "IX returned malformed or unbounded message evidence");
	}
	const stableId =
		"stableId" in value.author && typeof value.author.stableId === "string" ? value.author.stableId : undefined;
	const sentAt = "sentAt" in value && typeof value.sentAt === "number" ? value.sentAt : undefined;
	return {
		providerMessageId: value.providerMessageId,
		targetFingerprint: value.targetFingerprint,
		author: { displayName: value.author.displayName, isSelf: value.author.isSelf, ...(stableId ? { stableId } : {}) },
		body: value.body,
		deliveryState: value.deliveryState,
		...(sentAt === undefined ? {} : { sentAt }),
	};
}

export function parseMessageEvidence(value: unknown): readonly ChatMessage[] {
	if (!Array.isArray(value) || value.length > MAX_READ_MESSAGES) {
		throw new MessagingIxError("verify", "IX returned an invalid message evidence list");
	}
	return value.map(parseMessage);
}

export function parsePreparedDispatch(value: unknown): PreparedDispatch {
	if (
		typeof value !== "object" ||
		value === null ||
		!("targetFingerprint" in value) ||
		typeof value.targetFingerprint !== "string" ||
		!("postFillTargetFingerprint" in value) ||
		typeof value.postFillTargetFingerprint !== "string" ||
		!("composerHandle" in value) ||
		typeof value.composerHandle !== "string" ||
		value.composerHandle.length === 0 ||
		!("baselineMessageIds" in value) ||
		!Array.isArray(value.baselineMessageIds) ||
		value.baselineMessageIds.length > MAX_READ_MESSAGES ||
		!value.baselineMessageIds.every(item => typeof item === "string" && item.length > 0) ||
		!("tab" in value) ||
		typeof value.tab !== "object" ||
		value.tab === null ||
		!("tabId" in value.tab) ||
		typeof value.tab.tabId !== "string" ||
		!("epoch" in value.tab) ||
		typeof value.tab.epoch !== "string"
	) {
		throw new MessagingIxError("prepare_dispatch", "IX could not prove one stable target and composer");
	}
	return {
		targetFingerprint: value.targetFingerprint,
		postFillTargetFingerprint: value.postFillTargetFingerprint,
		composerHandle: value.composerHandle,
		baselineMessageIds: value.baselineMessageIds,
		tab: { tabId: value.tab.tabId, epoch: value.tab.epoch },
	};
}
export class MessagingIxClient {
	readonly #transport: IxTransport;
	constructor(transport: IxTransport) {
		this.#transport = transport;
	}

	async read(
		adapter: ChatAdapter,
		target: ChatTargetIdentity,
		limit: number,
		signal?: AbortSignal,
	): Promise<readonly ChatMessage[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_MESSAGES) {
			throw new MessagingIxError("read", `message limit must be between 1 and ${MAX_READ_MESSAGES}`);
		}
		const raw = await this.#transport.evaluate(adapter.readOperation(target, limit), signal);
		return adapter.parseRead(raw).slice(0, limit);
	}

	async prepareDispatch(adapter: ChatAdapter, draft: ChatDraft, signal?: AbortSignal): Promise<PreparedDispatch> {
		const raw = await this.#transport.evaluate(adapter.prepareDispatchOperation(draft), signal);
		return adapter.parsePrepared(raw);
	}

	async dispatch(prepared: PreparedDispatch, signal?: AbortSignal): Promise<void> {
		await this.#transport.pressEnter(prepared.tab, prepared.composerHandle, signal);
	}

	async verify(
		adapter: ChatAdapter,
		draft: ChatDraft,
		baselineMessageIds: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly ChatMessage[]> {
		const raw = await this.#transport.evaluate(adapter.verificationOperation(draft, baselineMessageIds), signal);
		return adapter.parseVerification(raw);
	}
}

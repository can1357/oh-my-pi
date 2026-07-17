import { draftDigest, freezeDraft, sameTab, targetFingerprint } from "./identity";
import { MessagingIxClient } from "./ix-client";
import type {
	ChatAdapter,
	ChatDraft,
	ChatMessage,
	ChatProvider,
	ChatTargetIdentity,
	MessagingServiceOptions,
	PrepareDraftInput,
	PreparedDispatch,
	SendApproval,
	SendApprovalRequest,
	SendOutcome,
} from "./types";

const DEFAULT_DRAFT_TTL_MS = 120_000;
const MAX_DRAFT_TTL_MS = 300_000;
const MAX_BODY_CHARS = 16_384;

export class MessagingServiceError extends Error {
	readonly code: "invalid_target" | "invalid_body" | "unsupported_provider";
	constructor(code: MessagingServiceError["code"], message: string) {
		super(message);
		this.name = "MessagingServiceError";
		this.code = code;
	}
}

function approvalMatches(approval: SendApproval, request: SendApprovalRequest, now: number): boolean {
	switch (approval.decision) {
		case "deny":
			return false;
		case "send_as_is":
			return (
				approval.actionId === request.actionId &&
				approval.draftId === request.draft.draftId &&
				approval.bodyDigest === request.draft.bodyDigest &&
				approval.nonce === request.draft.nonce &&
				approval.expiresAt >= now &&
				approval.expiresAt <= request.draft.expiresAt
			);
	}
}

function normalizeRenderedBody(body: string): string {
	return body.replaceAll("\r\n", "\n");
}

function verifiedMessage(
	messages: readonly ChatMessage[],
	draft: ChatDraft,
	baseline: ReadonlySet<string>,
): ChatMessage | undefined {
	const matches = messages.filter(
		message =>
			!baseline.has(message.providerMessageId) &&
			message.targetFingerprint === draft.target.identityFingerprint &&
			message.author.isSelf &&
			message.deliveryState === "delivered" &&
			normalizeRenderedBody(message.body) === normalizeRenderedBody(draft.body),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export class MessagingService {
	readonly #adapters: Readonly<Partial<Record<ChatProvider, ChatAdapter>>>;
	readonly #ix: MessagingIxClient;
	readonly #broker: MessagingServiceOptions["broker"];
	readonly #clock: MessagingServiceOptions["clock"];
	readonly #id: () => string;
	/** Mutable by design: atomic get-and-delete enforces one-shot draft consumption. */
	readonly #drafts = new Map<string, ChatDraft>();

	constructor(options: MessagingServiceOptions) {
		this.#adapters = Object.fromEntries(options.adapters.map(adapter => [adapter.provider, adapter]));
		this.#ix = new MessagingIxClient(options.transport);
		this.#broker = options.broker;
		this.#clock = options.clock;
		this.#id = options.id ?? (() => crypto.randomUUID());
	}

	async prepare(input: PrepareDraftInput): Promise<ChatDraft> {
		const adapter = this.#adapters[input.target.provider];
		if (!adapter) {
			throw new MessagingServiceError("unsupported_provider", `unsupported chat provider: ${input.target.provider}`);
		}
		if (input.body.length === 0 || input.body.length > MAX_BODY_CHARS) {
			throw new MessagingServiceError("invalid_body", `message body must contain 1-${MAX_BODY_CHARS} characters`);
		}
		const expectedFingerprint = await targetFingerprint(input.target);
		if (expectedFingerprint !== input.target.identityFingerprint) {
			throw new MessagingServiceError("invalid_target", "target fingerprint does not match its stable identity");
		}
		adapter.validateTarget(input.target);
		const ttlMs = input.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_DRAFT_TTL_MS) {
			throw new MessagingServiceError("invalid_body", `draft lifetime must be 1-${MAX_DRAFT_TTL_MS}ms`);
		}
		const createdAt = this.#clock.now();
		const draftId = this.#id();
		const nonce = this.#id();
		const bodyDigest = await draftDigest(input);
		const draft = freezeDraft({
			draftId,
			provider: input.target.provider,
			target: input.target,
			body: input.body,
			...(input.replyTo ? { replyTo: input.replyTo } : {}),
			targetRevision: input.target.tab.epoch,
			bodyDigest,
			nonce,
			createdAt,
			expiresAt: createdAt + ttlMs,
		});
		this.#drafts.set(draftId, draft);
		return draft;
	}

	async read(target: ChatTargetIdentity, limit = 20, signal?: AbortSignal): Promise<readonly ChatMessage[]> {
		const adapter = this.#adapters[target.provider];
		if (!adapter)
			throw new MessagingServiceError("unsupported_provider", `unsupported chat provider: ${target.provider}`);
		return this.#ix.read(adapter, target, limit, signal);
	}

	async send(draftId: string, signal?: AbortSignal): Promise<SendOutcome> {
		const draft = this.#drafts.get(draftId);
		if (!draft) return { status: "not_sent", reason: "draft_unavailable" };
		this.#drafts.delete(draftId);
		if (this.#clock.now() > draft.expiresAt) return { status: "not_sent", reason: "draft_expired" };
		const adapter = this.#adapters[draft.provider];
		if (!adapter) return { status: "not_sent", reason: "unsupported_provider" };

		const approvalRequest = Object.freeze({ actionId: this.#id(), draft });
		let approval: SendApproval;
		try {
			approval = await this.#broker.request(approvalRequest, signal);
		} catch (error) {
			if (error instanceof Error) return { status: "not_sent", reason: "approval_unavailable" };
			throw error;
		}
		if (approval.decision === "deny") return { status: "not_sent", reason: "approval_denied" };
		if (!approvalMatches(approval, approvalRequest, this.#clock.now()))
			return { status: "not_sent", reason: "approval_mismatch" };

		let prepared: PreparedDispatch;
		try {
			prepared = await this.#ix.prepareDispatch(adapter, draft, signal);
		} catch (error) {
			if (error instanceof Error) return { status: "not_sent", reason: "target_or_composer_unavailable" };
			throw error;
		}
		if (
			prepared.targetFingerprint !== draft.target.identityFingerprint ||
			prepared.postFillTargetFingerprint !== draft.target.identityFingerprint ||
			!sameTab(prepared.tab, draft.target.tab)
		) {
			return { status: "not_sent", reason: "target_mismatch" };
		}

		try {
			await this.#ix.dispatch(prepared, signal);
		} catch (error) {
			if (error instanceof Error) return { status: "unknown_not_retryable", reason: "dispatch_uncertain" };
			throw error;
		}
		try {
			const messages = await this.#ix.verify(adapter, draft, prepared.baselineMessageIds, signal);
			const verified = verifiedMessage(messages, draft, new Set(prepared.baselineMessageIds));
			return verified
				? { status: "verified", providerMessageId: verified.providerMessageId }
				: { status: "unknown_not_retryable", reason: "verification_ambiguous" };
		} catch (error) {
			if (error instanceof Error) return { status: "unknown_not_retryable", reason: "verification_unavailable" };
			throw error;
		}
	}
}

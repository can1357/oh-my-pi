import type { ChatDraft, ChatTargetIdentity, ReplyIdentity, TargetIdentityInput } from "./types";

export class MessagingIdentityError extends Error {
	readonly field: string;
	constructor(field: string, message: string) {
		super(message);
		this.name = "MessagingIdentityError";
		this.field = field;
	}
}

function requireStable(field: string, value: string): string {
	if (value.length === 0 || value !== value.trim() || /[\u0000-\u001f]/u.test(value)) {
		throw new MessagingIdentityError(field, `${field} is not a stable identifier`);
	}
	return value;
}

function encode(parts: readonly string[]): string {
	return parts.map(part => `${new TextEncoder().encode(part).byteLength}:${part}`).join("|");
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function replyKey(reply: ReplyIdentity | undefined): string {
	if (!reply) return "";
	return encode([requireStable("replyTo.providerMessageId", reply.providerMessageId), reply.threadId ?? ""]);
}

export async function targetFingerprint(target: TargetIdentityInput | ChatTargetIdentity): Promise<string> {
	const canonical = encode([
		target.provider,
		requireStable("accountScopeId", target.accountScopeId),
		requireStable("conversationId", target.conversationId),
		target.threadId ? requireStable("threadId", target.threadId) : "",
		target.kind,
	]);
	return sha256(canonical);
}

export async function createTargetIdentity(input: TargetIdentityInput): Promise<ChatTargetIdentity> {
	requireStable("tab.tabId", input.tab.tabId);
	requireStable("tab.epoch", input.tab.epoch);
	const identityFingerprint = await targetFingerprint(input);
	return Object.freeze({
		...input,
		tab: Object.freeze({ ...input.tab }),
		identityFingerprint,
	});
}

export async function draftDigest(input: {
	readonly target: ChatTargetIdentity;
	readonly body: string;
	readonly replyTo?: ReplyIdentity;
}): Promise<string> {
	const canonical = encode([
		input.target.provider,
		input.target.identityFingerprint,
		input.target.tab.tabId,
		input.target.tab.epoch,
		replyKey(input.replyTo),
		input.body,
	]);
	return sha256(canonical);
}

export function freezeDraft(draft: ChatDraft): ChatDraft {
	const replyTo = draft.replyTo ? Object.freeze({ ...draft.replyTo }) : undefined;
	return Object.freeze({
		...draft,
		target: Object.freeze({ ...draft.target, tab: Object.freeze({ ...draft.target.tab }) }),
		...(replyTo ? { replyTo } : {}),
	});
}

export function sameTab(first: ChatTargetIdentity["tab"], second: ChatTargetIdentity["tab"]): boolean {
	return first.tabId === second.tabId && first.epoch === second.epoch;
}

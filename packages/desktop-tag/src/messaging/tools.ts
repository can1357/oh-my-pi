import { type } from "@pk-nerdsaver-ai/pi-ai";
import type { CustomTool } from "@pk-nerdsaver-ai/pi-coding-agent";
import type { MessagingService } from "./service";
import type { ChatTargetIdentity, SendOutcome } from "./types";

const chatReadSchema = type({
	"limit?": type("number.integer").describe("most recent messages to read (1-50, default 20)"),
});
const chatPrepareSchema = type({
	body: type("string").describe("exact message body; whitespace is preserved"),
	"replyToMessageId?": type("string").describe("stable provider message id to reply to"),
	"threadId?": type("string").describe("stable provider thread id, when replying in a thread"),
});
const chatSendSchema = type({
	draftId: type("string").describe("opaque one-shot draft id returned by chat_prepare"),
});

export interface MessagingToolContext {
	readonly service: MessagingService;
	/** Host-owned frozen capture; the model cannot provide or replace this identity. */
	readonly target: () => ChatTargetIdentity | undefined;
}

interface ReadDetails {
	readonly provider: string;
	readonly targetFingerprint: string;
	readonly count: number;
}

interface PrepareDetails {
	readonly draftId: string;
	readonly provider: string;
	readonly targetFingerprint: string;
	readonly expiresAt: number;
}

interface SendDetails {
	readonly draftId: string;
	readonly outcome: SendOutcome["status"];
}

export class MessagingToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MessagingToolError";
	}
}

function requireTarget(context: MessagingToolContext): ChatTargetIdentity {
	const target = context.target();
	if (!target) throw new MessagingToolError("No frozen, provider-stable chat target is available");
	return target;
}

export function createChatReadTool(context: MessagingToolContext): CustomTool<typeof chatReadSchema, ReadDetails> {
	return {
		name: "chat_read",
		label: "Chat Read",
		description: "Read a bounded recent tail from the frozen Slack, Teams, or Discord conversation.",
		parameters: chatReadSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params, _onUpdate, _toolContext, signal) {
			const target = requireTarget(context);
			const messages = await context.service.read(target, params.limit ?? 20, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(messages) }],
				details: {
					provider: target.provider,
					targetFingerprint: target.identityFingerprint,
					count: messages.length,
				},
			};
		},
	};
}

export function createChatPrepareTool(
	context: MessagingToolContext,
): CustomTool<typeof chatPrepareSchema, PrepareDetails> {
	return {
		name: "chat_prepare",
		label: "Chat Prepare",
		description:
			"Create a private immutable one-shot draft for the frozen chat target. This does not touch the site composer.",
		parameters: chatPrepareSchema,
		strict: true,
		approval: "read",
		async execute(_toolCallId, params) {
			const target = requireTarget(context);
			const replyTo = params.replyToMessageId
				? { providerMessageId: params.replyToMessageId, ...(params.threadId ? { threadId: params.threadId } : {}) }
				: undefined;
			const draft = await context.service.prepare({ target, body: params.body, ...(replyTo ? { replyTo } : {}) });
			return {
				content: [{ type: "text", text: JSON.stringify({ draftId: draft.draftId, expiresAt: draft.expiresAt }) }],
				details: {
					draftId: draft.draftId,
					provider: draft.provider,
					targetFingerprint: draft.target.identityFingerprint,
					expiresAt: draft.expiresAt,
				},
			};
		},
	};
}

export function createChatSendTool(context: MessagingToolContext): CustomTool<typeof chatSendSchema, SendDetails> {
	return {
		name: "chat_send",
		label: "Chat Send",
		description:
			"Request exact one-shot operator approval, dispatch once to the frozen target, and post-verify delivery. Never retry an unknown outcome.",
		parameters: chatSendSchema,
		strict: true,
		approval: { tier: "write", reason: "Outbound chat message", override: true },
		formatApprovalDetails: () =>
			"A separate internal approval still requires Send as-is for the exact immutable draft.",
		async execute(_toolCallId, params, _onUpdate, _toolContext, signal) {
			const outcome = await context.service.send(params.draftId, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(outcome) }],
				details: { draftId: params.draftId, outcome: outcome.status },
				isError: outcome.status !== "verified",
			};
		},
	};
}

export function createMessagingTools(context: MessagingToolContext): readonly CustomTool[] {
	return [createChatReadTool(context), createChatPrepareTool(context), createChatSendTool(context)];
}

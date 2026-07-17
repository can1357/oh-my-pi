import { describe, expect, test } from "bun:test";
import { createTargetIdentity } from "../src/messaging/identity";
import { parseMessageEvidence, parsePreparedDispatch, validateAdapterTarget } from "../src/messaging/ix-client";
import { MessagingService } from "../src/messaging/service";
import type {
	ApprovalBroker,
	ChatAdapter,
	Clock,
	IxOperation,
	IxTransport,
	SendApproval,
	SendApprovalRequest,
} from "../src/messaging/types";

const clock: Clock = { now: () => 1_000 };

class RecordingTransport implements IxTransport {
	readonly operations: IxOperation[] = [];
	readonly enters: string[] = [];
	constructor(readonly responses: readonly unknown[]) {}
	async evaluate(operation: IxOperation): Promise<unknown> {
		this.operations.push(operation);
		return this.responses[this.operations.length - 1];
	}
	async pressEnter(_tab: { readonly tabId: string; readonly epoch: string }, composerHandle: string): Promise<void> {
		this.enters.push(composerHandle);
	}
}

function approvalFor(request: SendApprovalRequest): SendApproval {
	return {
		decision: "send_as_is",
		actionId: request.actionId,
		draftId: request.draft.draftId,
		bodyDigest: request.draft.bodyDigest,
		nonce: request.draft.nonce,
		expiresAt: 2_000,
	};
}

async function fixture() {
	const target = await createTargetIdentity({
		provider: "slack",
		accountScopeId: "T1",
		conversationId: "C1",
		kind: "channel",
		displayName: "ops",
		canonicalUrl: "https://app.slack.com/client/T1/C1",
		tab: { tabId: "tab-1", epoch: "epoch-1" },
		capturedAt: 1_000,
	});
	return target;
}

const adapter: ChatAdapter = {
	provider: "slack",
	validateTarget: target => validateAdapterTarget(target, "slack", ["app.slack.com"]),
	readOperation: (target, limit) => ({ kind: "read", provider: "slack", target, limit }),
	prepareDispatchOperation: draft => ({ kind: "prepare_dispatch", provider: "slack", draft }),
	verificationOperation: (draft, baselineMessageIds) => ({
		kind: "verify",
		provider: "slack",
		draft,
		baselineMessageIds,
	}),
	parseRead: parseMessageEvidence,
	parsePrepared: parsePreparedDispatch,
	parseVerification: parseMessageEvidence,
};

describe("MessagingService", () => {
	test("sends exactly once only after exact approval and verifies the new self message", async () => {
		// Given
		const target = await fixture();
		const transport = new RecordingTransport([
			{
				targetFingerprint: target.identityFingerprint,
				postFillTargetFingerprint: target.identityFingerprint,
				composerHandle: "composer-1",
				baselineMessageIds: ["old"],
				tab: target.tab,
			},
			[
				{
					providerMessageId: "new",
					targetFingerprint: target.identityFingerprint,
					author: { displayName: "Me", isSelf: true },
					body: "hello",
					deliveryState: "delivered",
				},
			],
		]);
		const broker: ApprovalBroker = { request: async draft => approvalFor(draft) };
		const service = new MessagingService({
			adapters: [adapter],
			transport,
			broker,
			clock,
			id: (() => {
				let n = 0;
				return () => `id-${++n}`;
			})(),
		});
		const draft = await service.prepare({ target, body: "hello" });

		// When
		const outcome = await service.send(draft.draftId);

		// Then
		expect(outcome.status).toBe("verified");
		expect(transport.enters).toEqual(["composer-1"]);
		expect(await service.send(draft.draftId)).toEqual({ status: "not_sent", reason: "draft_unavailable" });
	});

	test("performs no IX operation when approval does not bind the exact body digest", async () => {
		// Given
		const target = await fixture();
		const transport = new RecordingTransport([]);
		const broker: ApprovalBroker = {
			request: async draft => ({ ...approvalFor(draft), bodyDigest: "wrong" }),
		};
		const service = new MessagingService({ adapters: [adapter], transport, broker, clock, id: () => "id" });
		const draft = await service.prepare({ target, body: "hello" });

		// When
		const outcome = await service.send(draft.draftId);

		// Then
		expect(outcome).toEqual({ status: "not_sent", reason: "approval_mismatch" });
		expect(transport.operations).toHaveLength(0);
		expect(transport.enters).toHaveLength(0);
	});

	test("returns unknown without retry when verification is ambiguous after Enter", async () => {
		// Given
		const target = await fixture();
		const prepared = {
			targetFingerprint: target.identityFingerprint,
			postFillTargetFingerprint: target.identityFingerprint,
			composerHandle: "composer-1",
			baselineMessageIds: ["old"],
			tab: target.tab,
		};
		const transport = new RecordingTransport([prepared, []]);
		const broker: ApprovalBroker = { request: async draft => approvalFor(draft) };
		const service = new MessagingService({
			adapters: [adapter],
			transport,
			broker,
			clock,
			id: () => crypto.randomUUID(),
		});
		const draft = await service.prepare({ target, body: "hello" });

		// When
		const outcome = await service.send(draft.draftId);

		// Then
		expect(outcome.status).toBe("unknown_not_retryable");
		expect(transport.enters).toEqual(["composer-1"]);
		expect(transport.operations).toHaveLength(2);
	});
});

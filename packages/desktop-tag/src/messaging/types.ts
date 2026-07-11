export type ChatProvider = "slack" | "teams" | "discord";
export type ChatTargetKind = "dm" | "group_dm" | "channel" | "thread";
export type DeliveryState = "delivered" | "pending" | "failed" | "unknown";

export interface Clock {
	readonly now: () => number;
}

export interface TabIdentity {
	readonly tabId: string;
	/** Changes whenever the controlled tab navigates or is rebound. */
	readonly epoch: string;
}

export interface ChatTargetIdentity {
	readonly provider: ChatProvider;
	readonly accountScopeId: string;
	readonly conversationId: string;
	readonly threadId?: string;
	readonly kind: ChatTargetKind;
	readonly displayName: string;
	readonly canonicalUrl?: string;
	readonly tab: TabIdentity;
	readonly capturedAt: number;
	readonly identityFingerprint: string;
}

export interface TargetIdentityInput {
	readonly provider: ChatProvider;
	readonly accountScopeId: string;
	readonly conversationId: string;
	readonly threadId?: string;
	readonly kind: ChatTargetKind;
	readonly displayName: string;
	readonly canonicalUrl?: string;
	readonly tab: TabIdentity;
	readonly capturedAt: number;
}

export interface ReplyIdentity {
	readonly providerMessageId: string;
	readonly threadId?: string;
}

export interface ChatDraft {
	readonly draftId: string;
	readonly provider: ChatProvider;
	readonly target: ChatTargetIdentity;
	readonly body: string;
	readonly replyTo?: ReplyIdentity;
	readonly targetRevision: string;
	readonly bodyDigest: string;
	readonly nonce: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface ChatAuthor {
	readonly stableId?: string;
	readonly displayName: string;
	readonly isSelf: boolean;
}

export interface ChatMessage {
	readonly providerMessageId: string;
	readonly targetFingerprint: string;
	readonly author: ChatAuthor;
	readonly sentAt?: number;
	readonly body: string;
	readonly deliveryState: DeliveryState;
}

export interface SendApprovalRequest {
	readonly actionId: string;
	readonly draft: ChatDraft;
}

export type SendApproval =
	| { readonly decision: "deny"; readonly actionId: string }
	| {
			readonly decision: "send_as_is";
			readonly actionId: string;
			readonly draftId: string;
			readonly bodyDigest: string;
			readonly nonce: string;
			readonly expiresAt: number;
	  };

/** Dedicated broker; implementations must never derive this decision from generic tool approval mode. */
export interface ApprovalBroker {
	readonly request: (request: SendApprovalRequest, signal?: AbortSignal) => Promise<SendApproval>;
}

export interface AdapterSelectors {
	readonly version: string;
	readonly supportedHosts: readonly string[];
	readonly account: readonly string[];
	readonly conversation: readonly string[];
	readonly thread: readonly string[];
	readonly composer: readonly string[];
	readonly message: readonly string[];
	readonly selfAuthor: readonly string[];
	readonly delivered: readonly string[];
	readonly failed: readonly string[];
}

export type IxOperation =
	| {
			readonly kind: "read";
			readonly provider: ChatProvider;
			readonly target: ChatTargetIdentity;
			readonly selectors?: AdapterSelectors;
			readonly limit: number;
	  }
	| {
			/** One browser_execute: prove target, capture baseline, locate one composer, fill exact body, prove target again. */
			readonly kind: "prepare_dispatch";
			readonly provider: ChatProvider;
			readonly draft: ChatDraft;
			readonly selectors?: AdapterSelectors;
	  }
	| {
			readonly kind: "verify";
			readonly provider: ChatProvider;
			readonly draft: ChatDraft;
			readonly selectors?: AdapterSelectors;
			readonly baselineMessageIds: readonly string[];
	  };

/** Narrow transport boundary implemented by IX Bridge; arbitrary model-authored scripts are not accepted. */
export interface IxTransport {
	readonly evaluate: (operation: IxOperation, signal?: AbortSignal) => Promise<unknown>;
	readonly pressEnter: (tab: TabIdentity, composerHandle: string, signal?: AbortSignal) => Promise<void>;
}

export interface PreparedDispatch {
	readonly targetFingerprint: string;
	readonly postFillTargetFingerprint: string;
	readonly tab: TabIdentity;
	readonly composerHandle: string;
	readonly baselineMessageIds: readonly string[];
}

export interface ChatAdapter {
	readonly provider: ChatProvider;
	readonly validateTarget: (target: ChatTargetIdentity) => void;
	readonly readOperation: (target: ChatTargetIdentity, limit: number) => IxOperation;
	readonly prepareDispatchOperation: (draft: ChatDraft) => IxOperation;
	readonly verificationOperation: (draft: ChatDraft, baselineMessageIds: readonly string[]) => IxOperation;
	readonly parseRead: (value: unknown) => readonly ChatMessage[];
	readonly parsePrepared: (value: unknown) => PreparedDispatch;
	readonly parseVerification: (value: unknown) => readonly ChatMessage[];
}

export type SendOutcome =
	| { readonly status: "verified"; readonly providerMessageId: string }
	| { readonly status: "not_sent"; readonly reason: string }
	| { readonly status: "unknown_not_retryable"; readonly reason: string };

export interface PrepareDraftInput {
	readonly target: ChatTargetIdentity;
	readonly body: string;
	readonly replyTo?: ReplyIdentity;
	readonly ttlMs?: number;
}

export interface MessagingServiceOptions {
	readonly adapters: readonly ChatAdapter[];
	readonly transport: IxTransport;
	readonly broker: ApprovalBroker;
	readonly clock: Clock;
	readonly id?: () => string;
}

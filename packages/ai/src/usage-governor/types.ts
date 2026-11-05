/** Where a governed request came from; used for display and the interactive-reserve rule. */
export type UsageRequestSource = "turn" | "side" | "advisor" | "background" | "subagent" | "unattributed";

/** Caller attribution for one request. Never sent on the wire. */
export interface UsageRequestContext {
	/** Assigned model role (`default`, `task`, ...); undefined when unknown. */
	role?: string;
	source: UsageRequestSource;
	/** A person is waiting on this request in the foreground. */
	interactive?: boolean;
	/** Issuing session; display and notice routing only. */
	sessionId?: string;
}

/** Live configuration from `usageGovernor.*`. */
export interface UsageGovernorConfig {
	enabled: boolean;
	/** 0..1 share of a window's allowance usable ahead of linear pacing at the window start. */
	lead: number;
	/** `hold`: interactive requests keep the reserve. `spend`: they may use it. */
	interactiveReserve: "hold" | "spend";
}

/** One send about to be made. */
export interface UsageAdmissionRequest {
	/** Stored credential row id, when known. */
	credentialId?: number;
	/** SHA-256 base64url fingerprint of the bearer, only when `credentialId` is absent. */
	bearerFingerprint?: string;
	/** Provider id; resolved from the row when absent. */
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	context?: UsageRequestContext;
}

/** Admission of one send. Settle exactly once. */
export interface UsageAdmissionGrant {
	readonly id: string;
	/** Milliseconds spent waiting for pacing. */
	readonly waitedMs: number;
}

/** `sent`: reached the transport. `not-sent`: refused, aborted or failed before dispatch. */
export type UsageAdmissionOutcome = "sent" | "not-sent";

/** Per-thread seam consulted by pi-ai before every send. */
export interface UsageAdmission {
	/** Synchronous. `false` keeps every send on the pre-governor path. */
	readonly active: boolean;
	/**
	 * Resolves when the send may go out and rejects only when `signal` aborts.
	 * Resolves `undefined` when the request is not governed or the ledger is degraded.
	 */
	admit(request: UsageAdmissionRequest, signal?: AbortSignal): Promise<UsageAdmissionGrant | undefined>;
	settle(grantId: string, outcome: UsageAdmissionOutcome): void;
}

export type UsageWindowState = "open" | "paced" | "closed" | "stale" | "unknown";

export interface UsageGovernorBankedResets {
	available: number;
	redeemable?: number;
	eligible?: boolean;
	reason?: string;
	soonestExpiresAtMs?: number;
}

export interface UsageGovernorWindowStatus {
	provider: string;
	/** A stored row for the account; callers resolve labels. */
	credentialId?: number;
	quotaKey: string;
	/** Window label, e.g. `5h`, `7d`, `7d opus`. */
	label: string;
	state: UsageWindowState;
	usedFraction?: number;
	allowedFraction?: number;
	reserveFraction: number;
	resetsAtMs?: number;
	observedAtMs?: number;
	pendingRequests: number;
	inFlightRequests: number;
	/** Undefined until calibrated. */
	costPerRequest?: number;
	admissibleAtMs?: number;
	/** Shown, never counted. */
	bankedResets?: UsageGovernorBankedResets;
}

export type UsageGovernorWaitReason = "over-allowance" | "reserve-held" | "exhausted";

export interface UsageGovernorWaitRecord {
	startedAtMs: number;
	endedAtMs?: number;
	outcome?: "admitted" | "aborted";
	provider: string;
	credentialId?: number;
	modelId?: string;
	role?: string;
	source: UsageRequestSource;
	sessionId?: string;
	pid: number;
	reason: UsageGovernorWaitReason;
	bindingLabel?: string;
	usedFraction?: number;
	allowedFraction?: number;
	untilMs?: number;
	resetsAtMs?: number;
}

export interface UsageGovernorStatus {
	atMs: number;
	config: UsageGovernorConfig;
	ledger: "ok" | "degraded" | "closed";
	degradedReason?: string;
	windows: UsageGovernorWindowStatus[];
	waits: UsageGovernorWaitRecord[];
}

export type UsageGovernorEvent =
	| { kind: "config"; config: UsageGovernorConfig }
	| { kind: "wait-start"; wait: UsageGovernorWaitRecord }
	| { kind: "wait-end"; wait: UsageGovernorWaitRecord };

/** `AuthStorage.governor`. */
export interface GovernorApi extends UsageAdmission {
	readonly config: UsageGovernorConfig;
	configure(config: UsageGovernorConfig): void;
	/** Read-only: no network, no credential mutation, no pool reload. */
	status(options?: { provider?: string; waitLimit?: number }): UsageGovernorStatus;
	onEvent(listener: (event: UsageGovernorEvent) => void): () => void;
}

export const DISABLED_USAGE_GOVERNOR_CONFIG: UsageGovernorConfig = {
	enabled: false,
	lead: 0.25,
	interactiveReserve: "hold",
};

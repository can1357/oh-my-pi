/**
 * ArkType schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `Type` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `"+": "reject"` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (standard type keeps extra keys): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 */
import { type FluentType, type } from "@oh-my-pi/omptype";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type DisabledCredentialSummary,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type RemoteOAuthCredential,
	type SnapshotCredential,
} from "../auth-storage";
import type {
	ClientUsageReportRequest,
	ClientUsageReportResponse,
	ClientUsageSummaryResponse,
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
	UsageHistoryResponse,
	UsageResponse,
	UsageStaleResponse,
} from "./types";

// ─── Credential payloads ─────────────────────────────────────────────────────

/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
export const oauthCredentialSchema: FluentType<OAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type("string").narrow(
		(value, ctx) =>
			value !== REMOTE_REFRESH_SENTINEL ||
			ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
	),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
export const remoteOauthCredentialSchema: FluentType<RemoteOAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

export const apiKeyCredentialSchema: FluentType<ApiKeyCredential> = type({
	"+": "reject",
	type: "'api_key'",
	key: type("string").atLeastLength(1),
	"source?": "'login'",
});

/** Discriminated union accepted on POST /v1/credential (writes). */
export const writableAuthCredentialSchema: FluentType<AuthCredential> =
	oauthCredentialSchema.or(apiKeyCredentialSchema);

/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
export const snapshotCredentialSchema: FluentType<SnapshotCredential> =
	remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

// ─── Snapshot ────────────────────────────────────────────────────────────────

export const credentialSnapshotEntrySchema: FluentType<AuthCredentialSnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
});

export const credentialBlockSnapshotSchema: FluentType<CredentialBlockSnapshot> = type({
	"+": "reject",
	providerKey: type("string").atLeastLength(1),
	blockScope: "string",
	blockedUntilMs: "number",
	"updatedAtMs?": "number",
});

export const snapshotEntrySchema: FluentType<SnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
	rotatesInMs: "number | null",
	"blocks?": credentialBlockSnapshotSchema.array(),
});

export const refresherScheduleSchema: FluentType<RefresherSchedule> = type({
	"+": "reject",
	enabled: "boolean",
	intervalMs: "number",
	skewMs: "number",
	nextSweepInMs: "number",
});

export const snapshotResponseSchema: FluentType<SnapshotResponse> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
});

// ─── Snapshot stream (SSE) ───────────────────────────────────────────────────

/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
export const snapshotStreamSnapshotEventSchema: FluentType<SnapshotStreamSnapshotEvent> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
	kind: "'snapshot'",
});

/** Per-credential upsert/refresh delta. */
export const snapshotStreamEntryEventSchema: FluentType<SnapshotStreamEntryEvent> = type({
	"+": "reject",
	kind: "'entry'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	entry: snapshotEntrySchema,
});

/** Per-credential delete delta. */
export const snapshotStreamRemovedEventSchema: FluentType<SnapshotStreamRemovedEvent> = type({
	"+": "reject",
	kind: "'removed'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	id: "number.integer",
});

/** Discriminated union over every event frame the snapshot stream emits. */
export const snapshotStreamEventSchema: FluentType<SnapshotStreamEvent> = snapshotStreamSnapshotEventSchema
	.or(snapshotStreamEntryEventSchema)
	.or(snapshotStreamRemovedEventSchema);

// ─── Healthz ─────────────────────────────────────────────────────────────────

export const healthzResponseSchema: FluentType<HealthzResponse> = type({
	"+": "reject",
	ok: "boolean",
	"version?": "string",
});

// ─── Usage ───────────────────────────────────────────────────────────────────

const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
});

const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: "'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
});

const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
});

const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"notes?": "string[]",
});

const usageResetCreditsSchema = type({
	availableCount: "number",
	"credits?": type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	}).array(),
});

const arkUsageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },
	"raw?": "unknown",
});

/**
 * Broker `/v1/usage` response. Reports are full {@link UsageReport}s minus the
 * heavy provider-specific `raw` field (the server strips it before send) — we
 * keep `raw` optional in the underlying schema so a misconfigured broker that
 * forgot to strip still validates.
 */
export const usageResponseSchema: FluentType<UsageResponse> = type({
	"+": "reject",
	generatedAt: "number",
	reports: arkUsageReportSchema.array(),
});

const usageHistoryEntrySchema = type({
	recordedAt: "number",
	provider: "string",
	accountKey: "string",
	"email?": "string",
	"accountId?": "string",
	limitId: "string",
	label: "string",
	"windowLabel?": "string",
	"usedFraction?": "number",
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"resetsAt?": "number",
});

/** Broker `/v1/usage/history` response — recorded usage-limit snapshots, oldest first. */
export const usageHistoryResponseSchema: FluentType<UsageHistoryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	entries: usageHistoryEntrySchema.array(),
});

const observedUsageEntrySchema = type({
	at: "number",
	provider: "string",
	model: "string",
	requests: "number",
	inputTokens: "number",
	outputTokens: "number",
	cacheReadTokens: "number",
	cacheWriteTokens: "number",
	costUsd: "number",
});

/** Broker `POST /v1/usage/observed` request — one client's batched observed usage. */
export const clientUsageReportRequestSchema: FluentType<ClientUsageReportRequest> = type({
	"+": "reject",
	installId: "string",
	"hostname?": "string",
	"app?": "string",
	entries: observedUsageEntrySchema.array(),
});

export const clientUsageReportResponseSchema: FluentType<ClientUsageReportResponse> = type({
	"+": "reject",
	ok: "boolean",
});

const clientUsageClientSummarySchema = type({
	installId: "string",
	"hostname?": "string",
	firstSeen: "number",
	lastSeen: "number",
	providers: type({
		"app?": "string",
		provider: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	}).array(),
});

/** Broker `GET /v1/usage/clients` response — per-client token burn aggregates. */
export const clientUsageSummaryResponseSchema: FluentType<ClientUsageSummaryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	clients: clientUsageClientSummarySchema.array(),
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

export const credentialRefreshResponseSchema: FluentType<CredentialRefreshResponse> = type({
	"+": "reject",
	entry: credentialSnapshotEntrySchema,
});

// ─── Disable ─────────────────────────────────────────────────────────────────

export const credentialDisableRequestSchema: FluentType<{ cause?: string }> = type({
	"+": "reject",
	"cause?": "string",
});

export const credentialDisableResponseSchema: FluentType<CredentialDisableResponse> = type({
	"+": "reject",
	ok: "boolean",
});

/** One disabled-credential tombstone — identity + cause, never token material. */
export const disabledCredentialSummarySchema: FluentType<DisabledCredentialSummary> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	type: "'oauth' | 'api_key'",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	cause: "string",
	"disabledAtMs?": "number",
});

/** Broker `GET /v1/credentials/disabled` response. */
export const disabledCredentialsResponseSchema: FluentType<DisabledCredentialsResponse> = type({
	"+": "reject",
	generatedAt: "number",
	disabled: disabledCredentialSummarySchema.array(),
});

// ─── Credential blocks ───────────────────────────────────────────────────────

export const credentialBlockRequestSchema: FluentType<CredentialBlockRequest> = credentialBlockSnapshotSchema;

export const credentialBlockResponseSchema: FluentType<CredentialBlockResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const credentialBlocksDeleteResponseSchema: FluentType<CredentialBlocksDeleteResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const usageStaleResponseSchema: FluentType<UsageStaleResponse> = type({
	"+": "reject",
	ok: "boolean",
});

// ─── Upload ──────────────────────────────────────────────────────────────────

export const credentialUploadRequestSchema: FluentType<CredentialUploadRequest> = type({
	"+": "reject",
	provider: type("string").atLeastLength(1),
	credential: writableAuthCredentialSchema,
});

export const credentialUploadResponseSchema: FluentType<CredentialUploadResponse> = type({
	"+": "reject",
	entries: credentialSnapshotEntrySchema.array(),
});

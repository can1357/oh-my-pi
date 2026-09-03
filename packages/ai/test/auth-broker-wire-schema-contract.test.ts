import { describe, expect, test } from "bun:test";
import { Type, type } from "@oh-my-pi/omptype";
import * as wireSchemas from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";

const REFRESHER = {
	enabled: false,
	intervalMs: 60_000,
	skewMs: 300_000,
	nextSweepInMs: Number.MAX_SAFE_INTEGER,
};
const BLOCK = {
	providerKey: "anthropic:oauth",
	blockScope: "tier:fable",
	blockedUntilMs: 4_000,
	updatedAtMs: 3_000,
};
const REMOTE_OAUTH = {
	type: "oauth",
	access: "access",
	refresh: "__remote__",
	expires: 5_000,
	tokenUrl: "https://example.test/token",
	clientId: "provider-client",
};
const REAL_OAUTH = { ...REMOTE_OAUTH, refresh: "real-refresh" };
const API_KEY = { type: "api_key", key: "secret", source: "login" };
const CREDENTIAL_ENTRY = {
	id: 7,
	provider: "anthropic",
	credential: REMOTE_OAUTH,
	identityKey: "account:test",
};
const SNAPSHOT_ENTRY = {
	...CREDENTIAL_ENTRY,
	rotatesInMs: null,
	blocks: [BLOCK],
};
const SNAPSHOT = {
	generation: 2,
	generatedAt: 1_000,
	serverNowMs: 2_000,
	refresher: REFRESHER,
	credentials: [SNAPSHOT_ENTRY],
};
const STREAM_SNAPSHOT = { kind: "snapshot", ...SNAPSHOT };
const STREAM_ENTRY = {
	kind: "entry",
	generation: 3,
	serverNowMs: 2_500,
	refresher: REFRESHER,
	entry: SNAPSHOT_ENTRY,
};
const STREAM_REMOVED = {
	kind: "removed",
	generation: 4,
	serverNowMs: 3_000,
	refresher: REFRESHER,
	id: 7,
};
const USAGE_REPORT = {
	provider: "anthropic",
	fetchedAt: 2_000,
	limits: [
		{
			id: "rolling",
			label: "Rolling window",
			scope: { provider: "anthropic", windowId: "rolling", providerExtension: true },
			window: { id: "rolling", label: "5 hour", durationMs: 18_000_000 },
			amount: { used: 1, limit: 10, remaining: 9, unit: "tokens", providerExtension: "kept" },
			status: "ok",
			notes: ["limit note"],
			providerExtension: 1,
		},
	],
	notes: ["report note"],
	metadata: { plan: "max" },
	raw: { providerPayload: true },
	providerExtension: "kept",
};
const OBSERVED_USAGE = {
	at: 1_000,
	provider: "anthropic",
	model: "claude",
	requests: 1,
	inputTokens: 2,
	outputTokens: 3,
	cacheReadTokens: 4,
	cacheWriteTokens: 5,
	costUsd: 0.01,
};

const schemaNames = [
	"oauthCredentialSchema",
	"remoteOauthCredentialSchema",
	"apiKeyCredentialSchema",
	"writableAuthCredentialSchema",
	"snapshotCredentialSchema",
	"credentialSnapshotEntrySchema",
	"credentialBlockSnapshotSchema",
	"snapshotEntrySchema",
	"refresherScheduleSchema",
	"snapshotResponseSchema",
	"snapshotStreamSnapshotEventSchema",
	"snapshotStreamEntryEventSchema",
	"snapshotStreamRemovedEventSchema",
	"snapshotStreamEventSchema",
	"healthzResponseSchema",
	"usageResponseSchema",
	"usageHistoryResponseSchema",
	"clientUsageReportRequestSchema",
	"clientUsageReportResponseSchema",
	"clientUsageSummaryResponseSchema",
	"credentialRefreshResponseSchema",
	"credentialDisableRequestSchema",
	"credentialDisableResponseSchema",
	"disabledCredentialSummarySchema",
	"disabledCredentialsResponseSchema",
	"credentialBlockRequestSchema",
	"credentialBlockResponseSchema",
	"credentialBlocksDeleteResponseSchema",
	"usageStaleResponseSchema",
	"credentialUploadRequestSchema",
	"credentialUploadResponseSchema",
] as const;

type SchemaName = (typeof schemaNames)[number];
type CallableSchema = (input: unknown) => unknown;

const validSamples: Record<SchemaName, unknown> = {
	oauthCredentialSchema: REAL_OAUTH,
	remoteOauthCredentialSchema: REMOTE_OAUTH,
	apiKeyCredentialSchema: API_KEY,
	writableAuthCredentialSchema: REAL_OAUTH,
	snapshotCredentialSchema: REMOTE_OAUTH,
	credentialSnapshotEntrySchema: CREDENTIAL_ENTRY,
	credentialBlockSnapshotSchema: BLOCK,
	snapshotEntrySchema: SNAPSHOT_ENTRY,
	refresherScheduleSchema: REFRESHER,
	snapshotResponseSchema: SNAPSHOT,
	snapshotStreamSnapshotEventSchema: STREAM_SNAPSHOT,
	snapshotStreamEntryEventSchema: STREAM_ENTRY,
	snapshotStreamRemovedEventSchema: STREAM_REMOVED,
	snapshotStreamEventSchema: STREAM_ENTRY,
	healthzResponseSchema: { ok: true, version: "contract" },
	usageResponseSchema: { generatedAt: 2_000, reports: [USAGE_REPORT] },
	usageHistoryResponseSchema: {
		generatedAt: 2_000,
		entries: [
			{
				recordedAt: 1_000,
				provider: "anthropic",
				accountKey: "account:test",
				limitId: "rolling",
				label: "Rolling window",
				usedFraction: 0.1,
				status: "ok",
			},
		],
	},
	clientUsageReportRequestSchema: { installId: "install", hostname: "host", app: "robomp", entries: [OBSERVED_USAGE] },
	clientUsageReportResponseSchema: { ok: true },
	clientUsageSummaryResponseSchema: {
		generatedAt: 2_000,
		clients: [
			{
				installId: "install",
				hostname: "host",
				firstSeen: 1_000,
				lastSeen: 2_000,
				providers: [{ ...OBSERVED_USAGE, app: "robomp", firstSeen: undefined, at: undefined, model: undefined }],
			},
		],
	},
	credentialRefreshResponseSchema: { entry: CREDENTIAL_ENTRY },
	credentialDisableRequestSchema: {},
	credentialDisableResponseSchema: { ok: true },
	disabledCredentialSummarySchema: {
		id: 7,
		provider: "anthropic",
		type: "oauth",
		email: "user@example.test",
		cause: "revoked",
		disabledAtMs: 2_000,
	},
	disabledCredentialsResponseSchema: {
		generatedAt: 2_000,
		disabled: [{ id: 7, provider: "anthropic", type: "oauth", cause: "revoked" }],
	},
	credentialBlockRequestSchema: BLOCK,
	credentialBlockResponseSchema: { ok: true },
	credentialBlocksDeleteResponseSchema: { ok: true },
	usageStaleResponseSchema: { ok: true },
	credentialUploadRequestSchema: { provider: "anthropic", credential: REAL_OAUTH },
	credentialUploadResponseSchema: { entries: [CREDENTIAL_ENTRY] },
};

function run(schema: unknown, input: unknown): unknown {
	return (schema as CallableSchema)(input);
}

function accept(schema: unknown, input: unknown): unknown {
	const result = run(schema, input);
	expect(result).not.toBeInstanceOf(type.errors);
	if (result instanceof type.errors) throw new Error(`Expected schema acceptance: ${result.summary}`);
	return result;
}

function reject(schema: unknown, input: unknown): void {
	expect(run(schema, input)).toBeInstanceOf(type.errors);
}

describe("auth-broker public wire schemas", () => {
	test("exports all 31 real callable ArkType values with canonical behavior", () => {
		expect(Object.keys(wireSchemas).sort()).toEqual([...schemaNames].sort());
		for (const name of schemaNames) {
			const schema = wireSchemas[name];
			expect(typeof schema).toBe("function");
			expect(schema).toBeInstanceOf(Type);
			accept(schema, validSamples[name]);
		}
	});

	test("preserves credential extension and sentinel boundaries", () => {
		expect(accept(wireSchemas.oauthCredentialSchema, REAL_OAUTH)).toEqual(REAL_OAUTH);
		expect(accept(wireSchemas.remoteOauthCredentialSchema, REMOTE_OAUTH)).toEqual(REMOTE_OAUTH);
		reject(wireSchemas.oauthCredentialSchema, REMOTE_OAUTH);
		reject(wireSchemas.remoteOauthCredentialSchema, REAL_OAUTH);
		reject(wireSchemas.oauthCredentialSchema, { ...REAL_OAUTH, access: "" });
		reject(wireSchemas.apiKeyCredentialSchema, { ...API_KEY, extra: true });
		reject(wireSchemas.apiKeyCredentialSchema, { ...API_KEY, source: "environment" });
		reject(wireSchemas.credentialUploadRequestSchema, { provider: "", credential: REAL_OAUTH });
	});

	test("preserves fixed envelopes, integer fields, discriminators, and block alias identity", () => {
		expect(wireSchemas.credentialBlockRequestSchema).toBe(wireSchemas.credentialBlockSnapshotSchema);
		accept(wireSchemas.credentialBlockRequestSchema, {
			providerKey: BLOCK.providerKey,
			blockScope: "",
			blockedUntilMs: BLOCK.blockedUntilMs,
		});
		accept(wireSchemas.credentialDisableRequestSchema, {});
		reject(wireSchemas.credentialDisableRequestSchema, { cause: 1 });
		reject(wireSchemas.credentialDisableRequestSchema, { extra: true });
		reject(wireSchemas.healthzResponseSchema, { ok: true, extra: true });
		reject(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, generation: 1.5 });
		reject(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, extra: true });
		reject(wireSchemas.snapshotEntrySchema, { ...SNAPSHOT_ENTRY, id: 1.5 });
		reject(wireSchemas.snapshotStreamEventSchema, { ...STREAM_ENTRY, kind: "snapshot" });
		reject(wireSchemas.snapshotStreamEventSchema, { ...STREAM_REMOVED, extra: true });
		reject(wireSchemas.snapshotStreamEventSchema, { kind: "unknown" });
	});

	test("preserves usage extensions while rejecting envelope and enum violations", () => {
		const response = { generatedAt: 2_000, reports: [USAGE_REPORT] };
		expect(accept(wireSchemas.usageResponseSchema, response)).toEqual(response);
		reject(wireSchemas.usageResponseSchema, { ...response, extra: true });
		reject(wireSchemas.usageResponseSchema, {
			...response,
			reports: [{ ...USAGE_REPORT, limits: [{ ...USAGE_REPORT.limits[0], amount: { unit: "seconds" } }] }],
		});
		reject(wireSchemas.usageResponseSchema, {
			...response,
			reports: [{ ...USAGE_REPORT, limits: [{ ...USAGE_REPORT.limits[0], status: "critical" }] }],
		});
	});
});

import { type } from "@oh-my-pi/omptype";
import type {
	DisabledCredentialSummary,
	ModelUsageHealth,
	OAuthSignOutResult,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
} from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProvider, providerPauseReason } from "@oh-my-pi/pi-ai/registry/oauth";
import {
	type UsageReport,
	type UsageResetCreditDetail,
	type UsageResetCredits,
	usageReportSchema,
} from "@oh-my-pi/pi-ai/usage";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AuthDaemonRequestHandler } from "../daemon/modules/auth";
import { isAuthDaemonCredentialId, isAuthDaemonHttpStatus } from "./auth-daemon-contract";
import type { AuthDaemonLease } from "./auth-daemon-owner";

const NonEmpty = type("string > 0");
const Provider = NonEmpty.narrow(value => !value.includes(":"));
const CredentialId = type("number").narrow(isAuthDaemonCredentialId);
const NonNegativeInteger = type("number").narrow(value => Number.isSafeInteger(value) && value >= 0);
const NonNegativeNumber = type("number").narrow(value => Number.isFinite(value) && value >= 0);
const ReserveFraction = NonNegativeNumber.narrow(value => value <= 1);

const CredentialsReload = type({ "revalidate?": "boolean", "+": "reject" });
const CredentialsRemove = type({ provider: NonEmpty, "id?": CredentialId, "+": "reject" });
const DisabledCredentials = type({ "provider?": NonEmpty, "+": "reject" });
const OAuthSignOut = type({ provider: Provider, credentialId: CredentialId, "sessionId?": NonEmpty, "+": "reject" });
const UsageScope = type({ "provider?": Provider, "+": "reject" });
const UsageIngestHeaders = type({
	provider: Provider,
	sessionId: NonEmpty,
	headers: "unknown",
	"responseStatus?": type("number").narrow(isAuthDaemonHttpStatus),
	"+": "reject",
});
const UsageObserve = type({
	provider: Provider,
	model: NonEmpty,
	usage: {
		input: NonNegativeInteger,
		output: NonNegativeInteger,
		cacheRead: NonNegativeInteger,
		cacheWrite: NonNegativeInteger,
		"+": "reject",
	},
	"costUsd?": NonNegativeNumber,
	"at?": NonNegativeInteger,
	"client?": { installId: NonEmpty, "hostname?": NonEmpty, "app?": NonEmpty, "+": "reject" },
	"+": "reject",
});
const HealthModel = type({
	provider: Provider,
	"modelId?": NonEmpty,
	"sessionId?": NonEmpty,
	reserveFraction: ReserveFraction,
	"+": "reject",
});
const ResetsList = type({ "provider?": Provider, "sessionId?": NonEmpty, "+": "reject" });
const ResetsRedeem = type({
	target: {
		provider: Provider,
		credentialId: CredentialId,
		"creditId?": NonEmpty,
		"accountId?": NonEmpty,
		"email?": NonEmpty,
		"orgId?": NonEmpty,
		"+": "reject",
	},
	"sessionId?": NonEmpty,
	"+": "reject",
});

function parse<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
	const params = schema(value);
	if (params instanceof type.errors) throw new Error("auth: invalid management params");
	return params;
}

async function credentialsReload(lease: AuthDaemonLease, value: unknown): Promise<null> {
	const { revalidate } = parse(CredentialsReload, value);
	if (revalidate) await lease.storage.credentials.revalidate();
	else await lease.storage.credentials.reload();
	return null;
}

const CredentialDestination = type({ provider: NonEmpty, "+": "reject" });

async function credentialDestination(lease: AuthDaemonLease, value: unknown): Promise<boolean> {
	const { provider } = parse(CredentialDestination, value);
	await lease.storage.credentials.poll();
	return lease.routesToBroker(provider);
}

async function credentialsRemove(lease: AuthDaemonLease, value: unknown): Promise<boolean> {
	const { provider, id } = parse(CredentialsRemove, value);
	if (id !== undefined) return lease.storage.credentials.removeById(provider, id);
	await lease.storage.credentials.remove(provider);
	return true;
}

function disabledCause(value: string): string {
	if (/^replaced by\b/i.test(value)) return "Replaced by another credential";
	if (/^deleted by user\b/i.test(value)) return "Deleted by user";
	if (/^oauth refresh failed\b/i.test(value)) return "OAuth refresh failed";
	return "Credential disabled";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

async function credentialsListDisabled(lease: AuthDaemonLease, value: unknown): Promise<DisabledCredentialSummary[]> {
	const { provider } = parse(DisabledCredentials, value);
	return (await lease.storage.credentials.listDisabled(provider)).map(row => ({
		id: row.id,
		provider: row.provider,
		type: row.type,
		email: stringValue(row.email),
		accountId: stringValue(row.accountId),
		orgId: stringValue(row.orgId),
		orgName: stringValue(row.orgName),
		cause: disabledCause(row.cause),
		disabledAtMs: row.disabledAtMs,
	}));
}

async function oauthSignOut(lease: AuthDaemonLease, value: unknown): Promise<OAuthSignOutResult> {
	const { provider, credentialId, sessionId: original } = parse(OAuthSignOut, value);
	const sessionId = lease.sessionId(original, provider);
	await lease.storage.credentials.poll();
	if (sessionId !== undefined && lease.storage.sessions.permits(provider, sessionId, credentialId) !== true) {
		return { removed: false };
	}
	const { removed, signOutError } = await lease.storage.oauth.signOut(provider, credentialId);
	return signOutError === undefined ? { removed } : { removed, signOutError: "Provider revocation failed" };
}

const USAGE_IDENTITY_FIELDS = [
	"accountId",
	"account_id",
	"account",
	"email",
	"user",
	"username",
	"projectId",
	"orgId",
	"orgName",
	"planType",
] as const;

function usageIdentity(metadata: UsageReport["metadata"]): UsageReport["metadata"] {
	if (!metadata) return undefined;
	let result: Record<string, string | number | boolean> | undefined;
	for (const key of USAGE_IDENTITY_FIELDS) {
		const value = stringValue(metadata[key]);
		if (value !== undefined) (result ??= {})[key] = value;
	}
	for (const key of ["credentialId", "resetCreditCredentialId"] as const) {
		const id = metadata[key];
		if (isAuthDaemonCredentialId(id)) (result ??= {})[key] = id;
	}
	for (const key of ["limitReached", "resetCreditActive"] as const) {
		const value = metadata[key];
		if (typeof value === "boolean") (result ??= {})[key] = value;
	}
	return result;
}

function usageResetCredit(credit: UsageResetCreditDetail): Omit<UsageResetCreditDetail, "id"> {
	return {
		title: credit.title,
		program: credit.program,
		remainingCount: credit.remainingCount,
		usable: credit.usable,
		requiresLimit: credit.requiresLimit,
		clears: credit.clears,
		blocking: credit.blocking,
		usedFractions: credit.usedFractions,
		grantedAt: credit.grantedAt,
		expiresAt: credit.expiresAt,
		status: credit.status,
	};
}

function resetStatus(status: UsageResetCredits): Omit<UsageResetCredits, "credits"> {
	return {
		availableCount: status.availableCount,
		redeemableCount: status.redeemableCount,
		nextCreditId: status.nextCreditId,
		eligible: status.eligible,
		reason: status.reason === undefined ? undefined : "Provider did not offer a usable reset",
		cooldownUntil: status.cooldownUntil,
	};
}

/** Return normalized quota fields with identity metadata only, never raw provider or broker data. */
function projectUsageReport(source: UsageReport): UsageReport {
	const report = parse(usageReportSchema, source);
	return {
		provider: report.provider,
		fetchedAt: report.fetchedAt,
		limits: report.limits.map(({ id, label, scope, window, amount, status, notes }) => ({
			id,
			label,
			scope: {
				provider: scope.provider,
				accountId: scope.accountId,
				projectId: scope.projectId,
				orgId: scope.orgId,
				modelId: scope.modelId,
				tier: scope.tier,
				windowId: scope.windowId,
				shared: scope.shared,
				sharedGroup: scope.sharedGroup,
			},
			window: window && {
				id: window.id,
				label: window.label,
				durationMs: window.durationMs,
				resetsAt: window.resetsAt,
				resetLabel: window.resetLabel,
			},
			amount: {
				unit: amount.unit,
				used: amount.used,
				limit: amount.limit,
				remaining: amount.remaining,
				usedFraction: amount.usedFraction,
				remainingFraction: amount.remainingFraction,
			},
			status,
			notes,
		})),
		resetCredits: report.resetCredits && {
			...resetStatus(report.resetCredits),
			credits: report.resetCredits.credits?.map(credit => ({ id: credit.id, ...usageResetCredit(credit) })),
		},
		notes: report.notes,
		metadata: usageIdentity(report.metadata),
	};
}

async function usageReports(lease: AuthDaemonLease, value: unknown): Promise<UsageReport[] | null> {
	const { provider } = parse(UsageScope, value);
	const reports = await lease.storage.usage.reports({ provider });
	return reports?.map(projectUsageReport) ?? null;
}

function usageAuthRejections(
	lease: AuthDaemonLease,
	value: unknown,
): { provider: string; credentialId: number; status: 401 | 403 }[] {
	const { provider } = parse(UsageScope, value);
	const { credentials, usage } = lease.storage;
	const rejected: { provider: string; credentialId: number; status: 401 | 403 }[] = [];
	for (const row of credentials.summaries(provider)) {
		if (row.disabled) continue;
		const status = usage.authRejection(row.provider, row.id);
		if (status === 401 || status === 403) {
			rejected.push({ provider: row.provider, credentialId: row.id, status });
		}
	}
	return rejected;
}

async function usageInvalidate(lease: AuthDaemonLease, value: unknown): Promise<null> {
	const { provider } = parse(UsageScope, value);
	await lease.storage.usage.invalidate(provider);
	return null;
}

const CLAUDE_USAGE_HEADER = /^anthropic-ratelimit-unified-(?:5h|7d|7d_oi)-(?:utilization|reset)$/;
const CODEX_USAGE_HEADER = /^x-codex-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/;
const NUMERIC_HEADER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** The daemon never receives arbitrary response headers or credential material. */
export function pickAuthDaemonUsageHeaders(
	provider: string,
	headers: Readonly<Record<string, unknown>>,
): Record<string, string> {
	const accepted: Record<string, string> = {};
	const pattern =
		provider === "anthropic" ? CLAUDE_USAGE_HEADER : provider === "openai-codex" ? CODEX_USAGE_HEADER : null;
	if (!pattern) return accepted;
	for (const key in headers) {
		const value = headers[key];
		const name = key.toLowerCase();
		if (!pattern.test(name) || typeof value !== "string" || value.length > 64) continue;
		const numeric = value.trim();
		if (NUMERIC_HEADER.test(numeric) && Number.isFinite(Number(numeric))) accepted[name] = numeric;
	}
	return accepted;
}

function usageIngestHeaders(lease: AuthDaemonLease, value: unknown): boolean | Promise<boolean> {
	const { provider, sessionId: original, headers, responseStatus } = parse(UsageIngestHeaders, value);
	if (!isRecord(headers)) throw new Error("auth: invalid usage headers");
	const accepted = pickAuthDaemonUsageHeaders(provider, headers);
	for (const name in headers) {
		if (!Object.hasOwn(accepted, name)) throw new Error("auth: invalid usage headers");
	}
	const sessionId = lease.sessionId(original, provider);
	const { sessions, usage } = lease.storage;
	const sticky = sessions.sticky?.(provider, sessionId);
	// Without a routed row, UsageService may fall back to the first OAuth
	// account. A response must never alter another account's cached limits.
	if (
		sticky?.type !== "oauth" ||
		sticky.credentialId === undefined ||
		sessions.permits(provider, sessionId, sticky.credentialId) !== true
	) {
		return false;
	}
	return usage.ingestHeaders(provider, accepted, { sessionId, responseStatus });
}

function usageObserve(lease: AuthDaemonLease, value: unknown): null {
	lease.storage.usage.observe(parse(UsageObserve, value));
	return null;
}

async function healthModel(lease: AuthDaemonLease, value: unknown): Promise<ModelUsageHealth> {
	const { provider, modelId, sessionId: original, reserveFraction } = parse(HealthModel, value);
	if (
		getProviderDefinition(provider)?.id !== provider ||
		getOAuthProvider(provider) !== undefined ||
		providerPauseReason(provider) !== undefined
	) {
		throw new Error("auth: provider is not supported by daemon health");
	}
	const sessionId = lease.sessionId(original, provider);
	const { state, accounts } = await lease.storage.health.model(provider, { modelId, sessionId, reserveFraction });
	return {
		state,
		accounts: accounts.map(({ credentialId, credentialType, selected, state, remainingFraction, resetsAt }) => ({
			credentialId,
			credentialType,
			selected,
			state,
			remainingFraction,
			resetsAt,
		})),
	};
}

async function resetsList(lease: AuthDaemonLease, value: unknown): Promise<ResetCreditAccountStatus[]> {
	const { provider, sessionId: original } = parse(ResetsList, value);
	const sessionId = lease.sessionId(original, provider ?? "openai-codex");
	const statuses = await lease.storage.resets.list({ provider, sessionId });
	return statuses.map(status => ({
		...resetStatus(status),
		provider: status.provider,
		credentialId: status.credentialId,
		accountId: stringValue(status.accountId),
		email: stringValue(status.email),
		orgId: stringValue(status.orgId),
		orgName: stringValue(status.orgName),
		report: status.report && projectUsageReport(status.report),
		retryAfterMs: status.retryAfterMs,
		credits: status.credits.map(credit => ({ id: credit.id, ...usageResetCredit(credit) })),
		active: status.active,
		error: status.error === undefined ? undefined : "Saved reset discovery failed",
	}));
}

const RESET_OUTCOME_CODES = {
	reset: true,
	already_redeemed: true,
	no_credit: true,
	nothing_to_reset: true,
	no_account: true,
	account_unavailable: true,
	credit_list_failed: true,
	unsupported_provider: true,
	reset_in_progress: true,
	offer_changed: true,
	ineligible: true,
	reset_unconfirmed: true,
	cooldown: true,
	unknown_program: true,
	unavailable: true,
	invalid_credit: true,
	invalid_request: true,
	invalid_base_url: true,
	organization_unavailable: true,
	network_error: true,
	auth_error: true,
	rate_limited: true,
	malformed_response: true,
};

async function resetsRedeem(lease: AuthDaemonLease, value: unknown): Promise<ResetCreditRedeemOutcome> {
	const { target, sessionId: original } = parse(ResetsRedeem, value);
	const { provider, credentialId } = target;
	const sessionId = lease.sessionId(original, provider);
	await lease.storage.credentials.poll();
	if (sessionId !== undefined && lease.storage.sessions.permits(provider, sessionId, credentialId) !== true) {
		return { ok: false, code: "no_account", provider };
	}
	const result = await lease.storage.resets.redeem({ target });
	return {
		ok: result.ok,
		code:
			Object.hasOwn(RESET_OUTCOME_CODES, result.code) || /^http_[1-5]\d\d$/.test(result.code)
				? result.code
				: "reset_unconfirmed",
		provider: result.provider,
		accountId: stringValue(result.accountId),
		email: stringValue(result.email),
		orgId: stringValue(result.orgId),
		cleared: result.cleared,
		creditId: result.creditId,
	};
}

export const authDaemonManagementHandlers: ReadonlyMap<string, AuthDaemonRequestHandler> = new Map<
	string,
	AuthDaemonRequestHandler
>([
	["credentials-reload", credentialsReload],
	["credential-destination", credentialDestination],
	["credentials-remove", credentialsRemove],
	["credentials-list-disabled", credentialsListDisabled],
	["oauth-sign-out", oauthSignOut],
	["usage-reports", usageReports],
	["usage-auth-rejections", usageAuthRejections],
	["usage-invalidate", usageInvalidate],
	["usage-ingest-headers", usageIngestHeaders],
	["usage-observe", usageObserve],
	["health-model", healthModel],
	["resets-list", resetsList],
	["resets-redeem", resetsRedeem],
]);

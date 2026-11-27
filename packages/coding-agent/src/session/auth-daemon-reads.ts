import {
	type AuthApiKeyOptions,
	getOAuthProvider,
	getProviderDefinition,
	type OAuthAccess,
	providerPauseReason,
	type ResolvedApiKey,
	type StoredAuthLocalSources,
	type StoredAuthResolution,
	type StoredCredentialSummary,
	summarizeStoredCredential,
} from "@oh-my-pi/pi-ai";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AuthDaemonRequestHandler } from "../daemon/modules/auth";
import { AUTH_DAEMON_PROVIDERS, isAuthDaemonCredentialId } from "./auth-daemon-contract";
import type { AuthDaemonLease } from "./auth-daemon-owner";

const OPTION_FIELDS = [
	"modelId",
	"accountIds",
	"serviceTier",
	"serviceTierAccounts",
	"forceRefresh",
	"refreshReason",
	"recordAffinity",
];

function fields(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`auth: invalid ${label}`);
	for (const key in value) {
		if (!allowed.includes(key)) throw new Error(`auth: invalid ${label}`);
	}
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || (typeof value === "string" && value.length > 0)) return value;
	throw new Error(`auth: invalid ${label}`);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	throw new Error(`auth: invalid ${label}`);
}

function strings(value: unknown, label: string): string[] {
	if (Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0)) return value;
	throw new Error(`auth: invalid ${label}`);
}

export function parseAuthDaemonSelectionOptions(value: unknown): AuthApiKeyOptions | undefined {
	if (value === undefined) return undefined;
	const options = fields(value, OPTION_FIELDS, "options");
	const { serviceTier, refreshReason } = options;
	if (
		serviceTier !== undefined &&
		serviceTier !== "auto" &&
		serviceTier !== "default" &&
		serviceTier !== "flex" &&
		serviceTier !== "scale" &&
		serviceTier !== "priority" &&
		serviceTier !== "ultrafast"
	) {
		throw new Error("auth: invalid serviceTier");
	}
	if (refreshReason !== undefined && refreshReason !== "auth-recovery") {
		throw new Error("auth: invalid refreshReason");
	}
	let serviceTierAccounts: Record<string, boolean> | undefined;
	if (options.serviceTierAccounts !== undefined) {
		if (!isRecord(options.serviceTierAccounts)) throw new Error("auth: invalid serviceTierAccounts");
		const accounts: Record<string, boolean> = Object.create(null);
		for (const account in options.serviceTierAccounts) {
			const offered = options.serviceTierAccounts[account];
			if (!account || typeof offered !== "boolean") throw new Error("auth: invalid serviceTierAccounts");
			accounts[account] = offered;
		}
		serviceTierAccounts = accounts;
	}
	return {
		modelId: optionalString(options.modelId, "modelId"),
		accountIds: options.accountIds === undefined ? undefined : strings(options.accountIds, "accountIds"),
		serviceTier,
		serviceTierAccounts,
		forceRefresh: optionalBoolean(options.forceRefresh, "forceRefresh"),
		refreshReason,
		recordAffinity: optionalBoolean(options.recordAffinity, "recordAffinity"),
	};
}

function parseLocal(value: unknown): StoredAuthLocalSources | undefined {
	if (value === undefined) return undefined;
	const { runtime, configOverride, configFallback, env, serviceTierRefused, skipTierApiKey } = fields(
		value,
		["runtime", "configOverride", "configFallback", "env", "serviceTierRefused", "skipTierApiKey"],
		"local sources",
	);
	if (env !== undefined && env !== "bearer" && env !== "ambient") throw new Error("auth: invalid local env source");
	return {
		runtime: optionalBoolean(runtime, "runtime"),
		configOverride: optionalBoolean(configOverride, "configOverride"),
		configFallback: optionalBoolean(configFallback, "configFallback"),
		serviceTierRefused: optionalBoolean(serviceTierRefused, "serviceTierRefused"),
		skipTierApiKey: optionalBoolean(skipTierApiKey, "skipTierApiKey"),
		env,
	};
}

export function supportedAuthDaemonProvider(value: unknown): value is string {
	return (
		typeof value === "string" &&
		AUTH_DAEMON_PROVIDERS.has(value) &&
		getOAuthProvider(value) === undefined &&
		providerPauseReason(value) === undefined
	);
}

function requireProvider(value: unknown): string {
	if (!supportedAuthDaemonProvider(value)) throw new Error("auth: provider is not supported by daemon auth");
	return value;
}

function requirePermitted(
	lease: AuthDaemonLease,
	provider: string,
	sessionId: string | undefined,
	id: number | undefined,
): void {
	if (
		sessionId !== undefined &&
		(id === undefined || lease.storage.sessions.permits(provider, sessionId, id) !== true)
	) {
		throw new Error("auth: credential is outside the session's account pool");
	}
}

/** An async refresh must not return an older row's bearer under a rebound row id. */
function requireCurrentOAuth(
	lease: AuthDaemonLease,
	provider: string,
	sessionId: string | undefined,
	credentialId: number | undefined,
	token: string,
): void {
	requirePermitted(lease, provider, sessionId, credentialId);
	const credential = lease.storage.credentials.list(provider).find(row => row.id === credentialId)?.credential;
	if (credential?.type !== "oauth" || credential.access !== token) {
		throw new Error("auth: OAuth row changed");
	}
}

interface ProviderAvailability {
	has: boolean;
	hasOAuth: boolean;
	hasSubscription: boolean;
	keyless: boolean;
	credentials: StoredCredentialSummary[];
	keylessCredentialIds: number[];
}

async function availability(
	lease: AuthDaemonLease,
	value: unknown,
): Promise<{ providers: Record<string, ProviderAvailability> }> {
	const params = value === undefined ? {} : fields(value, ["providers", "sessionId"], "availability params");
	const session = optionalString(params.sessionId, "sessionId");
	const providers =
		params.providers === undefined
			? [...AUTH_DAEMON_PROVIDERS].filter(supportedAuthDaemonProvider)
			: strings(params.providers, "providers").map(requireProvider);
	const storage = lease.storage;
	await storage.credentials.poll();
	const table: Record<string, ProviderAvailability> = Object.create(null);
	for (const provider of providers) {
		const sessionId = lease.sessionId(session, provider);
		const credentials: StoredCredentialSummary[] = [];
		const keylessCredentialIds: number[] = [];
		const policy = authPolicyFor(provider);
		const emptyFallback = policy?.login?.kind === "api-key" ? policy.login.emptyFallback : undefined;
		let hasOAuth = false;
		let hasSubscription = false;
		for (const row of storage.credentials.list(provider)) {
			if (sessionId !== undefined && storage.sessions.permits(provider, sessionId, row.id) !== true) continue;
			const { credential } = row;
			credentials.push(summarizeStoredCredential(row));
			if (credential.type === "oauth") {
				hasOAuth = true;
				hasSubscription = true;
			} else {
				if (credential.source === "login" && policy?.loginSubscription === true) hasSubscription = true;
				if (emptyFallback && credential.key === emptyFallback) keylessCredentialIds.push(row.id);
			}
		}
		const has = credentials.length > 0;
		table[provider] = {
			has,
			hasOAuth,
			hasSubscription,
			keyless: has && credentials.length === keylessCredentialIds.length,
			keylessCredentialIds,
			credentials,
		};
	}
	return { providers: table };
}

function metadataString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function inferenceRegion(value: unknown): OAuthAccess["inferenceRegion"] {
	return value === "global" || value === "eu" || value === "us" ? value : undefined;
}

/** Request encodings, not storage encodings. Structured OAuth keys may contain refresh grants internally. */
function oauthRequestKey(provider: string, apiKey: string, oauthAccess: string | undefined): string {
	const codec = getProviderDefinition(provider)?.getApiKey;
	const structured = authPolicyFor(provider)?.apiKeyFormat === "structured";
	if (!structured && !codec) {
		if (typeof oauthAccess === "string" && oauthAccess === apiKey) return oauthAccess;
		throw new Error("auth: invalid stored request key");
	}
	let body: unknown;
	try {
		body = JSON.parse(apiKey);
	} catch {
		throw new Error("auth: invalid structured request key");
	}
	if (!isRecord(body) || typeof oauthAccess !== "string" || body.token !== oauthAccess) {
		throw new Error("auth: invalid structured request key");
	}
	switch (provider) {
		case "github-copilot":
			return JSON.stringify({
				token: oauthAccess,
				enterpriseUrl: metadataString(body.enterpriseUrl),
				apiEndpoint: metadataString(body.apiEndpoint),
			});
		case "snowflake":
		case "alibaba-coding-plan":
			return JSON.stringify({ token: oauthAccess, enterpriseUrl: metadataString(body.enterpriseUrl) });
		case "kiro":
			return JSON.stringify({
				kind: "oauth",
				token: oauthAccess,
				region: metadataString(body.region),
				loginId: metadataString(body.loginId),
				profileArn: metadataString(body.profileArn),
			});
		default:
			throw new Error("auth: provider request key format is not supported by daemon auth");
	}
}

type ReadError = {
	kind: "error";
	category:
		| "refresh-unavailable"
		| "missing-api-key"
		| "selection-failed"
		| "unsupported-provider"
		| "invalid-recovery";
};

type KeyReadResult =
	| (Extract<StoredAuthResolution, { kind: "stored" }> & { recoveryHandle?: string })
	| Exclude<StoredAuthResolution, { kind: "stored" }>
	| ReadError;

function resolutionCategory(error: unknown): "refresh-unavailable" | "missing-api-key" | "selection-failed" {
	// Provider responses and nested causes may contain secrets; expose only known classifications.
	if (error instanceof Error) {
		if (error.name === "OAuthRefreshUnavailableError") return "refresh-unavailable";
		if (error.name === "MissingApiKeyError") return "missing-api-key";
	}
	return "selection-failed";
}

interface Recovery {
	provider: string;
	sessionId: string | undefined;
	credentialId: number;
	rejectedAccessToken: string;
	usedForRecovery?: true;
}

const MAX_RECOVERY_HANDLES = 256;
const kRecoveryHandles = Symbol("auth-daemon.recoveryHandles");
type ReadLease = AuthDaemonLease & { [kRecoveryHandles]?: Map<string, Recovery> };

function issueRecovery(lease: AuthDaemonLease, recovery: Recovery): string {
	const issued = ((lease as ReadLease)[kRecoveryHandles] ??= new Map());
	if (issued.size >= MAX_RECOVERY_HANDLES) {
		const oldest = issued.keys().next().value;
		if (oldest !== undefined) issued.delete(oldest);
	}
	const handle = crypto.randomUUID();
	issued.set(handle, recovery);
	return handle;
}

/** Look up a server-issued selection without consuming its recovery right. */
export function lookupAuthDaemonOAuthResolution(
	lease: AuthDaemonLease,
	handle: string,
	provider: string,
	rawSessionId: string | undefined,
): Pick<Recovery, "credentialId" | "rejectedAccessToken"> | undefined {
	const selected = (lease as ReadLease)[kRecoveryHandles]?.get(handle);
	if (!selected || selected.provider !== provider || selected.sessionId !== lease.sessionId(rawSessionId, provider)) {
		return undefined;
	}
	return selected;
}

/** Consume a single mint right, while leaving the rejected bearer available to the limiter. */
function takeRecovery(
	lease: AuthDaemonLease,
	provider: string,
	sessionId: string | undefined,
	handle: string | undefined,
	recovering: boolean,
): Recovery | undefined | false {
	if (handle === undefined && !recovering) return undefined;
	const recovery = handle === undefined ? undefined : (lease as ReadLease)[kRecoveryHandles]?.get(handle);
	if (
		!recovering ||
		!recovery ||
		recovery.usedForRecovery ||
		recovery.provider !== provider ||
		recovery.sessionId !== sessionId ||
		(sessionId !== undefined && lease.storage.sessions.permits(provider, sessionId, recovery.credentialId) !== true)
	) {
		return false;
	}
	recovery.usedForRecovery = true;
	return recovery;
}

async function resolve(lease: AuthDaemonLease, value: unknown): Promise<KeyReadResult> {
	const params = fields(value, ["provider", "sessionId", "options", "local", "recoveryHandle"], "resolve params");
	const { provider } = params;
	if (!supportedAuthDaemonProvider(provider)) return { kind: "error", category: "unsupported-provider" };
	const sessionId = lease.sessionId(optionalString(params.sessionId, "sessionId"), provider);
	const options = parseAuthDaemonSelectionOptions(params.options);
	const local = parseLocal(params.local);
	const handle = optionalString(params.recoveryHandle, "recoveryHandle");
	const recovering = options?.forceRefresh === true && options.refreshReason === "auth-recovery";
	const recovery = takeRecovery(lease, provider, sessionId, handle, recovering);
	if (recovery === false) return { kind: "error", category: "invalid-recovery" };
	try {
		const result = await lease.storage.resolveStoredAuth(provider, sessionId, {
			...options,
			local,
			forceRefreshCredentialId: recovery?.credentialId,
			rejectedAccessToken: recovery?.rejectedAccessToken,
		});
		if (result.kind !== "stored") return projectKeyResult(provider, result);
		const { credentialId, oauthAccess } = result.resolved;
		if (oauthAccess !== undefined) {
			requireCurrentOAuth(lease, provider, sessionId, credentialId, oauthAccess);
		} else {
			requirePermitted(lease, provider, sessionId, credentialId);
		}
		const projected = projectStoredKey(provider, result);
		if (credentialId !== undefined && oauthAccess) {
			projected.recoveryHandle = issueRecovery(lease, {
				provider,
				sessionId,
				credentialId,
				rejectedAccessToken: oauthAccess,
			});
		}
		return projected;
	} catch (error) {
		return { kind: "error", category: resolutionCategory(error) };
	}
}

function projectKeyResult(provider: string, result: StoredAuthResolution): KeyReadResult {
	if (result.kind === "missing") return { kind: "missing" };
	if (result.kind === "local") {
		return { kind: "local", source: result.source, serviceTierUnavailable: result.serviceTierUnavailable };
	}
	return projectStoredKey(provider, result);
}

function projectStoredKey(
	provider: string,
	result: Extract<StoredAuthResolution, { kind: "stored" }>,
): Extract<KeyReadResult, { kind: "stored" }> {
	const { credentialId, oauthIdentity, serviceTierUnavailable } = result.resolved;
	const resolved: ResolvedApiKey = {
		apiKey: result.needsResolution
			? result.resolved.apiKey
			: oauthRequestKey(provider, result.resolved.apiKey, result.resolved.oauthAccess),
		credentialId,
		serviceTierUnavailable,
		oauthIdentity: oauthIdentity && {
			accountId: metadataString(oauthIdentity.accountId),
			orgId: metadataString(oauthIdentity.orgId),
			region: metadataString(oauthIdentity.region),
			inferenceRegion: inferenceRegion(oauthIdentity.inferenceRegion),
		},
	};
	return {
		kind: "stored",
		resolved,
		needsResolution: result.needsResolution,
		fallbackToOAuth: result.fallbackToOAuth,
	};
}

async function peek(lease: AuthDaemonLease, value: unknown): Promise<KeyReadResult> {
	const params = fields(value, ["provider", "options", "local"], "peek params");
	const { provider } = params;
	if (!supportedAuthDaemonProvider(provider)) return { kind: "error", category: "unsupported-provider" };
	const options = params.options === undefined ? {} : fields(params.options, ["includeExpired"], "peek options");
	const includeExpired = optionalBoolean(options.includeExpired, "includeExpired");
	const local = parseLocal(params.local);
	try {
		const result = await lease.storage.peekStoredAuth(provider, { includeExpired, local });
		if (result.kind !== "stored") return projectKeyResult(provider, result);
		const projected = projectStoredKey(provider, result);
		const { credentialId, oauthAccess } = result.resolved;
		if (!includeExpired && credentialId !== undefined && oauthAccess) {
			requireCurrentOAuth(lease, provider, undefined, credentialId, oauthAccess);
			projected.recoveryHandle = issueRecovery(lease, {
				provider,
				sessionId: undefined,
				credentialId,
				rejectedAccessToken: oauthAccess,
			});
		}
		return projected;
	} catch (error) {
		return { kind: "error", category: resolutionCategory(error) };
	}
}

async function oauthAccess(
	lease: AuthDaemonLease,
	value: unknown,
): Promise<AccessReply | ({ ok: true; apiKey: string } & AccessReply) | ReadError | null> {
	const params = fields(
		value,
		["provider", "sessionId", "options", "credentialId", "recoveryHandle"],
		"oauth-access params",
	);
	const { provider } = params;
	if (!supportedAuthDaemonProvider(provider)) return { kind: "error", category: "unsupported-provider" };
	const sessionId = lease.sessionId(optionalString(params.sessionId, "sessionId"), provider);
	const options = parseAuthDaemonSelectionOptions(params.options);
	const requestedId = params.credentialId;
	if (requestedId !== undefined && !isAuthDaemonCredentialId(requestedId)) {
		throw new Error("auth: invalid credentialId");
	}
	const handle = optionalString(params.recoveryHandle, "recoveryHandle");
	const recovering = options?.forceRefresh === true && options.refreshReason === "auth-recovery";
	const recovery = takeRecovery(lease, provider, sessionId, handle, recovering);
	if (recovery === false || (recovery && requestedId !== undefined && recovery.credentialId !== requestedId)) {
		return { kind: "error", category: "invalid-recovery" };
	}
	const credentialId = recovery?.credentialId ?? requestedId;
	if (credentialId !== undefined) {
		await lease.storage.credentials.poll();
		requirePermitted(lease, provider, sessionId, credentialId);
	}
	try {
		if (credentialId === undefined) {
			const access = await lease.storage.oauth.access(provider, sessionId, options);
			return access ? projectOAuthAccess(lease, provider, sessionId, access) : null;
		}
		const result = await lease.storage.oauth.accessById(provider, credentialId, {
			...options,
			rejectedAccessToken: recovery?.rejectedAccessToken,
		});
		if (!result) return null;
		if (!result.ok) {
			return { kind: "error", category: result.category ?? "selection-failed" };
		}
		if (result.credentialId !== credentialId) throw new Error("auth: OAuth row changed");
		const access = projectOAuthAccess(lease, provider, sessionId, result);
		return { ...access, ok: true, apiKey: oauthRequestKey(provider, result.apiKey, access.accessToken) };
	} catch (error) {
		return { kind: "error", category: resolutionCategory(error) };
	}
}

type AccessReply = OAuthAccess & { recoveryHandle?: string };

function projectOAuthAccess(
	lease: AuthDaemonLease,
	provider: string,
	sessionId: string | undefined,
	access: OAuthAccess,
): AccessReply {
	if (typeof access.accessToken !== "string" || !access.accessToken) throw new Error("auth: OAuth access unavailable");
	requireCurrentOAuth(lease, provider, sessionId, access.credentialId, access.accessToken);
	return {
		accessToken: access.accessToken,
		credentialId: access.credentialId,
		recoveryHandle:
			access.credentialId === undefined
				? undefined
				: issueRecovery(lease, {
						provider,
						sessionId,
						credentialId: access.credentialId,
						rejectedAccessToken: access.accessToken,
					}),
		accountId: metadataString(access.accountId),
		email: metadataString(access.email),
		projectId: metadataString(access.projectId),
		enterpriseUrl: metadataString(access.enterpriseUrl),
		apiEndpoint: metadataString(access.apiEndpoint),
		orgId: metadataString(access.orgId),
		orgName: metadataString(access.orgName),
		region: metadataString(access.region),
		inferenceRegion: inferenceRegion(access.inferenceRegion),
	};
}

async function prefetchUsage(lease: AuthDaemonLease, value: unknown): Promise<null | ReadError> {
	const params = fields(value, ["provider", "sessionId", "options", "local"], "prefetchUsage params");
	const { provider } = params;
	if (!supportedAuthDaemonProvider(provider)) return { kind: "error", category: "unsupported-provider" };
	const sessionId = lease.sessionId(optionalString(params.sessionId, "sessionId"), provider);
	const options = parseAuthDaemonSelectionOptions(params.options);
	const local = parseLocal(params.local);
	try {
		await lease.storage.prefetchStoredAuthUsage(provider, sessionId, { ...options, local });
		return null;
	} catch (error) {
		return { kind: "error", category: resolutionCategory(error) };
	}
}

export const authDaemonReadHandlers: ReadonlyMap<string, AuthDaemonRequestHandler> = new Map<
	string,
	AuthDaemonRequestHandler
>([
	["availability", availability],
	["resolve", resolve],
	["peek", peek],
	["prefetchUsage", prefetchUsage],
	["oauth-access", oauthAccess],
]);

/**
 * SQLite-backed credential persistence for AuthStorage.
 *
 * The AuthCredentialStore contract lives in ./store so local and remote stores
 * share the same interface.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { parseAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { parseOtariCredential } from "@oh-my-pi/pi-catalog/wire/otari";
import {
	getAgentDbPath,
	getDbBusyTimeoutMs,
	isSqliteBusyError,
	isSqliteCorruptionError,
	logger,
	openQuarantinedStoreForSalvage,
	openSqliteDatabase,
	readSalvageableRows,
} from "@oh-my-pi/pi-utils";
import {
	CredentialCipher,
	credentialVaultAvailable,
	loadCredentialCipher,
	storeCredentialMasterKey,
} from "./credential-cipher";
import type { AuthCredentialStore, CredentialRefreshLeaseFence, CredentialRefreshLeaseHolder } from "./store";
import type {
	AuthCredential,
	DisabledCredentialSummary,
	OAuthCredential,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "./types";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	ClientProviderUsage,
	ClientUsageReport,
	ClientUsageSummary,
	UsageHistoryEntry,
	UsageHistoryQuery,
} from "../usage";

// 5 min stale tolerance. Anthropic / OpenAI rate-limit /usage hard at the IP
// level so we can't fetch all N credentials every cycle; with a long cache
// each credential's last-known value sticks visible while peers retry. UI
// data (5h / 7d / monthly limits) is fine being a few minutes stale.
export const USAGE_REPORT_TTL_MS = 5 * 60_000;

/**
 * Downsample usage history to at most one row per hour per account window: a
 * snapshot landing in the same hour bucket as the series' latest row
 * overwrites it in place. That bound makes further retention pruning
 * unnecessary — 1 row/hour is ~9k rows per account window per year.
 */
const USAGE_HISTORY_BUCKET_MS = 60 * 60_000;

/**
 * Merge client observed-usage flushes into at most one row per 5 minutes per
 * (install, provider, model): ~300 rows/day per active model per client
 * instead of one row per 10s flush.
 */
const CLIENT_USAGE_BUCKET_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// SqliteAuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row shape for auth_credentials table queries. `data` is the credential JSON;
 * a non-NULL `salt` marks it sealed (see {@link CredentialCipher}) until
 * `SqliteAuthCredentialStore.#reveal` opens it.
 */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	salt: string | null;
	disabled_cause: string | null;
	identity_key: string | null;
};

/** {@link AuthRow} plus `updated_at` — disabled-tombstone queries surface when the row was torn down. */
type DisabledAuthRow = AuthRow & { updated_at: number | null };

type CredentialBlockRow = {
	credential_id: number;
	provider_key: string;
	block_scope: string;
	blocked_until_ms: number;
	updated_at: number;
};

type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

/** Persisted columns compared to skip rewriting a credential row with identical bytes. */
type CredentialStateRow = {
	provider: string;
	credential_type: string;
	data: string;
	salt: string | null;
	identity_key: string | null;
	disabled_cause: string | null;
};

function storesSerializedCredential(row: CredentialStateRow, serialized: SerializedCredentialRecord): boolean {
	return (
		row.data === serialized.data &&
		row.credential_type === serialized.credentialType &&
		(row.identity_key ?? null) === serialized.identityKey
	);
}

const AUTH_SCHEMA_VERSION = 9;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";
const LEGACY_CODEX_BLOCK_PROVIDER_KEY = "openai-codex:oauth";
const LEGACY_CODEX_BLOCK_SCOPE = "shared";
const CODEX_METER_BLOCK_SCOPES = ["chat", "spark"] as const;
/**
 * Minimum spacing between read-path sweeps of expired block rows. Reads already
 * filter `blocked_until_ms > now`; the sweep only bounds table growth, so it
 * must not take the SQLite write lock on every selection.
 */
const CREDENTIAL_BLOCK_SWEEP_INTERVAL_MS = 60_000;

// SQLite error classifiers live in pi-utils so the credential store and the
// model cache share one implementation; re-exported here to preserve the
// pre-existing `@oh-my-pi/pi-ai/auth-storage` surface.
export { isSqliteBusyError, isSqliteCorruptionError };

function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

export function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		const data = credential.source === "login" ? { key: credential.key, source: "login" } : { key: credential.key };
		return {
			credentialType: "api_key",
			data: JSON.stringify(data),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			const source = data.source === "login" ? "login" : undefined;
			return source ? { type: "api_key", key: data.key, source } : { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause.trim();
	return normalized.length > 0 ? normalized : "disabled";
}

function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

function resolveProviderCredentialIdentityKey(orgScoped: boolean, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if (orgScoped) {
		// One account email can hold several organizations/workspaces (e.g. a
		// Team seat plus a personal plan), each with its own org-scoped token
		// and limit pools. Scope identity by org so both subscriptions can be
		// stored side by side. The qualifier rides on whichever base identity
		// is available, so an unqualified account/project fallback would
		// still collapse two subscriptions whenever the email could not be
		// recovered. Org-less credentials (rows written before org capture
		// existed) keep their bare key.
		const base =
			emailIdentifier ??
			identifiers.find(identifier => identifier.startsWith("account:")) ??
			identifiers.find(identifier => identifier.startsWith("project:"));
		const orgIdentifier = identifiers.find(identifier => identifier.startsWith("org:"));
		if (base) return orgIdentifier ? `${base}|${orgIdentifier}` : base;
		// No base identity at all: the org alone still distinguishes the row.
		return orgIdentifier ?? null;
	}
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier) return accountIdentifier;
	if (emailIdentifier) return emailIdentifier;
	const projectIdentifier = identifiers.find(identifier => identifier.startsWith("project:"));
	if (projectIdentifier) return projectIdentifier;
	return null;
}

/**
 * Identity key of a credential: the `identityKey` that broker snapshots carry
 * and that broker account pools and `sessions.restrict` match, such as
 * `email:<address>|org:<id>` for org-scoped providers. `null` for an API key or
 * an OAuth credential without any account, email, project, or org identity.
 */
export function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	// Explicit fields precede token claims of the same kind. When the policy's
	// preferred field is present no JWT claim can change the resulting key.
	const orgScoped = authPolicyFor(provider)?.orgScopedIdentity === true;
	if (orgScoped) {
		const email = normalizeStoredEmail(credential.email);
		if (email) {
			const org = normalizeStoredAccountId(credential.orgId);
			return org ? `email:${email}|org:${org}` : `email:${email}`;
		}
	} else {
		const account = normalizeStoredAccountId(credential.accountId);
		if (account) return `account:${account}`;
	}
	return resolveProviderCredentialIdentityKey(orgScoped, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

/**
 * Whether upserting `incoming` replaces the active row holding `existing` (stored
 * under `existingIdentityKey`) instead of inserting a new row beside it.
 */
export function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		if (existing.type !== "api_key") return false;
		if (existing.key === incoming.key) return true;
		if (provider === "alibaba-token-plan") {
			const existingToken = parseAlibabaTokenPlanCredential(existing.key)?.token;
			const incomingToken = parseAlibabaTokenPlanCredential(incoming.key)?.token;
			return existingToken !== undefined && existingToken === incomingToken;
		}
		if (provider === "otari") {
			const existingToken = parseOtariCredential(existing.key)?.token;
			const incomingToken = parseOtariCredential(incoming.key)?.token;
			return existingToken !== undefined && existingToken === incomingToken;
		}
		if (provider === "cloudflare-ai-gateway" || provider === "cloudflare-workers-ai") {
			const existingToken = parseCloudflareCredential(existing.key)?.token;
			const incomingToken = parseCloudflareCredential(incoming.key)?.token;
			return existingToken !== undefined && existingToken === incomingToken;
		}
		return false;
	}
	const incomingIdentifiers = extractOAuthCredentialIdentifiers(incoming);
	const incomingIdentityKey = resolveProviderCredentialIdentityKey(
		authPolicyFor(provider)?.orgScopedIdentity === true,
		incomingIdentifiers,
	);
	if (incomingIdentityKey === null) return false;
	if (incomingIdentityKey === existingIdentityKey) return true;
	if (existingIdentityKey === null) return false;
	// One-way upgrade, applied only when the INCOMING identity key carries the
	// org qualifier (only providers with org-scoped identity create such keys,
	// so other providers never reach the checks below). An org-scoped login `org:<o>`
	// claims (and re-keys) any existing row that denotes the same subscription:
	//   - `org:<o>` — org-only row stored when identity recovery failed, claimed
	//     once a later same-org login recovers a base identity;
	//   - `<b>` for any base identity `<b>` (email/account/project) the incoming
	//     credential carries — a pre-org legacy row, mirroring the pre-org
	//     replace behavior;
	//   - `<b>|org:<o>` for any such base — the same subscription keyed by a
	//     different base, e.g. an account-keyed row stored while the email could
	//     not be recovered, claimed once a later login recovers the email;
	//   - any same-org row whose STORED credential shares a base identity with
	//     the incoming one — a stored credential can retain identifiers its key
	//     does not use (an email-keyed row also carries the account UUID), so a
	//     later login that loses the email but keeps the account still updates
	//     its row instead of duplicating the subscription.
	// The reverse stays a non-match: an org-less credential only ever replaces
	// via exact key equality above and must never clobber an org-scoped row.
	const orgIdentifier = incomingIdentifiers.find(identifier => identifier.startsWith("org:"));
	if (orgIdentifier === undefined) return false;
	if (incomingIdentityKey !== orgIdentifier && !incomingIdentityKey.endsWith(`|${orgIdentifier}`)) return false;
	if (existingIdentityKey === orgIdentifier) return true;
	const existingIdentifiers =
		existing.type === "oauth" && existingIdentityKey.endsWith(`|${orgIdentifier}`)
			? extractOAuthCredentialIdentifiers(existing)
			: null;
	// A base identifier that merely repeats the org qualifier's id carries no
	// per-user identity (openai-codex stores the ChatGPT workspace id as both
	// accountId and orgId, shared by every member) — letting it act as a
	// claimable base would re-key another member's same-org row.
	const orgQualifierId = orgIdentifier.slice("org:".length);
	for (const identifier of incomingIdentifiers) {
		const isBase =
			identifier.startsWith("email:") || identifier.startsWith("account:") || identifier.startsWith("project:");
		if (!isBase) continue;
		if (identifier.slice(identifier.indexOf(":") + 1) === orgQualifierId) continue;
		if (existingIdentityKey === identifier) return true;
		if (existingIdentityKey === `${identifier}|${orgIdentifier}`) return true;
		if (existingIdentifiers?.includes(identifier)) return true;
	}
	return false;
}

/**
 * Whether two OAuth credentials belong to the same account of the same organization,
 * whichever identity key each is stored under. The email decides when both carry one;
 * otherwise a matching account id does, unless it is the organization's own id (a
 * ChatGPT workspace id shared by every member). Project ids are shared between users
 * and never count.
 */
export function isSameOAuthAccount(a: OAuthCredential, b: OAuthCredential): boolean {
	const orgId = normalizeStoredAccountId(a.orgId);
	if (orgId !== normalizeStoredAccountId(b.orgId)) return false;
	const emailA = normalizeStoredEmail(a.email);
	const emailB = normalizeStoredEmail(b.email);
	if (emailA !== null && emailB !== null) return emailA === emailB;
	const accountId = normalizeStoredAccountId(a.accountId);
	return accountId !== null && accountId !== orgId && accountId === normalizeStoredAccountId(b.accountId);
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email) identifiers.add(`email:${email}`);
	const projectId = normalizeStoredAccountId(credential.projectId);
	if (projectId) identifiers.add(`project:${projectId}`);
	const orgId = normalizeStoredAccountId(credential.orgId);
	if (orgId) identifiers.add(`org:${orgId}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return [...identifiers];
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
		const identifiers = new Set<string>();
		const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
		if (directEmail) identifiers.add(`email:${directEmail}`);
		const openAiProfile = payload["https://api.openai.com/profile"];
		if (typeof openAiProfile === "object" && openAiProfile !== null && !Array.isArray(openAiProfile)) {
			const claimEmail = normalizeStoredEmail(
				(openAiProfile as Record<string, unknown>).email as string | undefined,
			);
			if (claimEmail) identifiers.add(`email:${claimEmail}`);
		}
		const openAiAuth = payload["https://api.openai.com/auth"];
		const authClaims =
			typeof openAiAuth === "object" && openAiAuth !== null && !Array.isArray(openAiAuth)
				? (openAiAuth as Record<string, unknown>)
				: undefined;
		const accountId = normalizeStoredAccountId(
			typeof payload.account_id === "string"
				? payload.account_id
				: typeof payload.accountId === "string"
					? payload.accountId
					: typeof payload.user_id === "string"
						? payload.user_id
						: typeof payload.sub === "string"
							? payload.sub
							: typeof authClaims?.chatgpt_account_id === "string"
								? authClaims.chatgpt_account_id
								: undefined,
		);
		if (accountId) identifiers.add(`account:${accountId}`);
		return identifiers.size > 0 ? [...identifiers] : undefined;
	} catch {
		return undefined;
	}
}
/**
 * Whether a store seals new writes: `true` always (generating the master key on
 * first use), `false` never and unseals rows sealed earlier, `"auto"` per
 * {@link SqliteAuthCredentialStore.unlock}.
 */
export type CredentialEncryption = boolean | "auto";

/** A credential row's id with its sealed `data` column and salt. */
interface SealedRow {
	id: number;
	data: string;
	salt: string;
}

/** How a {@link SqliteAuthCredentialStore} treats sealed credential rows. */
export interface SqliteAuthCredentialStoreOptions {
	/** Opens sealed rows; without it they read as unparsable and are skipped. */
	cipher?: CredentialCipher;
	/** Seal new writes with `cipher`; otherwise they are stored in plaintext. */
	encrypt?: boolean;
	/** Finalize this store's statements on close without closing the caller's database. */
	borrowConnection?: boolean;
}

/**
 * Default SQLite-backed implementation of {@link AuthCredentialStore}.
 *
 * Used by the pi-ai CLI and as the default store for `AuthStorage.create()`.
 * Also exposes convenience methods (`saveOAuth`, `getOAuth`, `saveApiKey`,
 * `getApiKey`, `listProviders`, `deleteProvider`) that callers can use directly
 * without going through `AuthStorage`.
 *
 * Credential rows may be sealed under the OS-vault master key
 * ({@link CredentialCipher}): {@link unlock} loads the key, `encrypt` seals new
 * writes, and rows written in plaintext stay readable.
 */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	readonly #borrowConnection: boolean;
	readonly #statements: Statement[] = [];
	#cipher: CredentialCipher | undefined;
	#encrypt: boolean;
	/** One warning per store for rows sealed under a key this machine does not hold. */
	#warnedUnopenable = false;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#getCacheIncludingExpiredStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteCachePrefixStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#getCredentialBlockStmt: Statement;
	#listCredentialBlockScopesStmt: Statement;
	#listCredentialBlocksStmt: Statement;
	#upsertCredentialBlockStmt: Statement;
	#deleteCredentialBlocksStmt: Statement;
	#deleteCredentialBlockStmt: Statement;
	#deleteExpiredCredentialBlocksStmt: Statement;
	/** Wall-clock time of the last expired-block sweep; throttles read-path sweeps. */
	#lastCredentialBlockSweepMs = Number.NEGATIVE_INFINITY;
	#acquireCredentialRefreshLeaseStmt: Statement;
	#getCredentialRefreshLeaseStmt: Statement;
	#getCredentialRefreshLeaseHolderStmt: Statement;
	#handBackCredentialRefreshLeaseStmt: Statement;
	#renewCredentialRefreshLeaseStmt: Statement;
	#releaseCredentialRefreshLeaseStmt: Statement;
	#getCredentialStateStmt: Statement;
	#holdsCredentialRefreshLeaseStmt: Statement;
	#credentialBlockReconcileAfter: Map<string, number> = new Map();
	#insertUsageHistoryStmt: Statement;
	#lastUsageHistoryStmt: Statement;
	#listUsageHistoryStmt: Statement;
	#updateUsageHistoryStmt: Statement;
	#dataVersion: number;
	#authRevision: number;
	#localAuthRevision: number;
	#closed = false;

	constructor(db: Database, options: SqliteAuthCredentialStoreOptions = {}) {
		this.#db = db;
		this.#borrowConnection = options.borrowConnection === true;
		this.#cipher = options.cipher;
		this.#encrypt = options.encrypt === true && options.cipher !== undefined;
		this.#initializeSchema();
		this.#dataVersion = this.#readDataVersion();
		this.#authRevision = this.#readAuthRevision();
		this.#localAuthRevision = this.#readLocalAuthRevision();

		const prepare = (sql: string) => {
			const stmt = db.prepare(sql);
			this.#statements.push(stmt);
			return stmt;
		};
		try {
			this.#listActiveStmt = prepare(
				"SELECT id, provider, credential_type, data, salt, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
			);
			this.#listActiveByProviderStmt = prepare(
				"SELECT id, provider, credential_type, data, salt, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
			);
			this.#listDisabledStmt = prepare(
				"SELECT id, provider, credential_type, data, salt, disabled_cause, identity_key, updated_at FROM auth_credentials WHERE disabled_cause IS NOT NULL ORDER BY id ASC",
			);
			this.#listDisabledByProviderStmt = prepare(
				"SELECT id, provider, credential_type, data, salt, disabled_cause, identity_key, updated_at FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
			);
			this.#insertStmt = prepare(
				`INSERT INTO auth_credentials (provider, credential_type, data, salt, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
			);
			this.#updateStmt = prepare(
				`UPDATE auth_credentials SET credential_type = ?, data = ?, salt = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
			);
			this.#deleteStmt = prepare(
				`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND disabled_cause IS NULL`,
			);
			this.#deleteByProviderStmt = prepare(
				`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
			);
			this.#hardDeleteStmt = prepare("DELETE FROM auth_credentials WHERE id = ?");
			this.#getCacheStmt = prepare(`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`);
			this.#getCacheIncludingExpiredStmt = prepare("SELECT value FROM cache WHERE key = ?");
			this.#upsertCacheStmt = prepare(
				"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
			);
			this.#deleteCachePrefixStmt = prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?");
			this.#deleteExpiredCacheStmt = prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
			this.#getCredentialBlockStmt = prepare(
				"SELECT blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ? AND blocked_until_ms > ?",
			);
			this.#listCredentialBlockScopesStmt = prepare(
				"SELECT block_scope, blocked_until_ms FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND blocked_until_ms > ?",
			);
			// One statement for any number of ids: `json_each` keeps the caller's id
			// order (`ids.key`) and the per-credential provider/scope order.
			this.#listCredentialBlocksStmt = prepare(
				`SELECT b.credential_id, b.provider_key, b.block_scope, b.blocked_until_ms, b.updated_at
			FROM json_each(?) AS ids
			JOIN auth_credential_blocks AS b ON b.credential_id = ids.value
			WHERE b.blocked_until_ms > ?
				AND NOT (b.provider_key = ? AND b.block_scope = ?)
			ORDER BY ids.key ASC, b.provider_key ASC, b.block_scope ASC`,
			);
			this.#upsertCredentialBlockStmt = prepare(
				`INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at)
			VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH})
			ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
				blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
				updated_at = excluded.updated_at`,
			);
			this.#deleteCredentialBlocksStmt = prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?");
			this.#deleteCredentialBlockStmt = prepare(
				"DELETE FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ?",
			);
			this.#deleteExpiredCredentialBlocksStmt = prepare(
				"DELETE FROM auth_credential_blocks WHERE blocked_until_ms <= ?",
			);
			this.#acquireCredentialRefreshLeaseStmt = prepare(
				`INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at)
			VALUES (?, ?, ?, ${SQLITE_NOW_EPOCH})
			ON CONFLICT(credential_id) DO UPDATE SET
				owner = excluded.owner,
				expires_at_ms = excluded.expires_at_ms,
				updated_at = excluded.updated_at
			WHERE auth_credential_refresh_leases.expires_at_ms <= ?`,
			);
			this.#getCredentialRefreshLeaseStmt = prepare(
				"SELECT expires_at_ms FROM auth_credential_refresh_leases WHERE credential_id = ?",
			);
			this.#getCredentialRefreshLeaseHolderStmt = prepare(
				"SELECT owner, expires_at_ms FROM auth_credential_refresh_leases WHERE credential_id = ?",
			);
			this.#handBackCredentialRefreshLeaseStmt = prepare(
				`UPDATE auth_credential_refresh_leases SET owner = ?, expires_at_ms = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE credential_id = ? AND owner = ?`,
			);
			this.#renewCredentialRefreshLeaseStmt = prepare(
				`UPDATE auth_credential_refresh_leases SET expires_at_ms = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE credential_id = ? AND owner = ?`,
			);
			this.#releaseCredentialRefreshLeaseStmt = prepare(
				"DELETE FROM auth_credential_refresh_leases WHERE credential_id = ? AND owner = ?",
			);
			this.#getCredentialStateStmt = prepare(
				"SELECT provider, credential_type, data, salt, identity_key, disabled_cause FROM auth_credentials WHERE id = ?",
			);
			this.#holdsCredentialRefreshLeaseStmt = prepare(
				"SELECT 1 FROM auth_credential_refresh_leases WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?",
			);
			this.#insertUsageHistoryStmt = prepare(
				"INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			this.#lastUsageHistoryStmt = prepare(
				"SELECT id, recorded_at FROM usage_history WHERE provider = ? AND account_key = ? AND limit_id = ? ORDER BY recorded_at DESC LIMIT 1",
			);
			this.#updateUsageHistoryStmt = prepare(
				"UPDATE usage_history SET recorded_at = ?, email = ?, account_id = ?, label = ?, window_label = ?, used_fraction = ?, status = ?, resets_at = ? WHERE id = ?",
			);
			this.#listUsageHistoryStmt = prepare(
				"SELECT recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at FROM usage_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) ORDER BY recorded_at ASC",
			);
		} catch (error) {
			for (const stmt of this.#statements) stmt.finalize();
			throw error;
		}
	}

	/**
	 * Opens credential storage with bounded busy retries and one-shot corruption recovery,
	 * then {@link unlock}s it: `encrypt` decides whether new writes are sealed.
	 */
	static async open(
		dbPath: string = getAgentDbPath(),
		options: { encrypt?: CredentialEncryption } = {},
	): Promise<SqliteAuthCredentialStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		let preservedPath: string | undefined;
		const store = await openSqliteDatabase(
			dbPath,
			async db => {
				try {
					await fs.chmod(dbPath, 0o600);
				} catch {
					// Ignore chmod failures (e.g., Windows)
				}
				SqliteAuthCredentialStore.#ensureAuthCredentialRefreshLeasesTable(db);
				return new SqliteAuthCredentialStore(db);
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: backupPath => {
					preservedPath = backupPath;
				},
			},
		);
		if (preservedPath) store.salvageQuarantinedCredentials(preservedPath);
		await store.unlock(options);
		return store;
	}

	/**
	 * Load the OS-vault master key: needed to read sealed rows and to seal new
	 * writes. Sealing follows `encrypt`; `"auto"` keeps a store as it is: one
	 * holding sealed rows keeps sealing, one holding only plaintext rows stays
	 * plaintext, and an empty store seals only when the vault answers without
	 * prompting ({@link credentialVaultAvailable}; never on headless hosts).
	 * Without sealing the vault is touched only to read sealed rows; `false`
	 * rewrites those it opens in plaintext, so later opens never read the vault.
	 * A host without a vault keeps writing plaintext.
	 */
	async unlock(options: { encrypt?: CredentialEncryption } = {}): Promise<void> {
		const sealedRows = this.#db.query("SELECT 1 FROM auth_credentials WHERE salt IS NOT NULL LIMIT 1").get() !== null;
		let encrypt = options.encrypt === true;
		if (options.encrypt === "auto") {
			encrypt =
				sealedRows ||
				(this.#db.query("SELECT 1 FROM auth_credentials LIMIT 1").get() === null &&
					(await credentialVaultAvailable()));
		}
		if (!this.#cipher && (encrypt || sealedRows)) {
			this.#cipher = await loadCredentialCipher();
			if (!this.#cipher && encrypt) {
				// Concurrent first runs would each store a key and seal rows the other cannot
				// open; the write lock lets the second find the first one's key.
				this.#db.run("BEGIN IMMEDIATE");
				try {
					this.#cipher = await loadCredentialCipher({ create: true });
				} finally {
					this.#db.run("COMMIT");
				}
			}
		}
		this.#encrypt = encrypt && this.#cipher !== undefined;
		if (options.encrypt === false && sealedRows && this.#cipher) this.#unseal(this.#cipher);
	}

	/** Rewrite every row `cipher` opens in plaintext; rows sealed under another key stay sealed. */
	#unseal(cipher: CredentialCipher): void {
		this.#db
			.transaction(() => {
				const rows = this.#db
					.query<SealedRow, []>("SELECT id, data, salt FROM auth_credentials WHERE salt IS NOT NULL")
					.all();
				for (const row of rows) {
					let data: string;
					try {
						data = cipher.open(row);
					} catch {
						continue;
					}
					this.#db.run("UPDATE auth_credentials SET data = ?, salt = NULL WHERE id = ?", [data, row.id]);
				}
			})
			.immediate();
	}

	/**
	 * Make `masterKey` this machine's credential master key: every sealed row is
	 * re-sealed under it and the OS vault stores it, together or not at all. A row
	 * already sealed under `masterKey` (a database copied with its key) is kept.
	 * @returns the number of rows re-sealed
	 * @throws {Error} when a sealed row opens under neither the current key nor
	 * `masterKey`, or the vault refuses the key; nothing changes then.
	 */
	async rekey(masterKey: Uint8Array): Promise<number> {
		const next = new CredentialCipher(masterKey);
		this.#cipher ??= await loadCredentialCipher();
		let resealed = 0;
		this.#db.run("BEGIN IMMEDIATE");
		try {
			const rows = this.#db
				.query("SELECT id, data, salt FROM auth_credentials WHERE salt IS NOT NULL")
				.all() as Array<{ id: number; data: string; salt: string }>;
			for (const row of rows) {
				let plaintext: string | undefined;
				for (const cipher of [this.#cipher, next]) {
					if (!cipher || plaintext !== undefined) continue;
					try {
						plaintext = cipher.open(row);
					} catch {}
				}
				if (plaintext === undefined) {
					throw new Error(
						`Credential ${row.id} is sealed under a key that is neither the current nor the new one`,
					);
				}
				const sealed = next.seal(plaintext);
				this.#db.run("UPDATE auth_credentials SET data = ?, salt = ? WHERE id = ?", [
					sealed.data,
					sealed.salt,
					row.id,
				]);
				resealed++;
			}
			this.#cipher = await storeCredentialMasterKey(masterKey);
			this.#db.run("COMMIT");
		} catch (error) {
			this.#db.run("ROLLBACK");
			throw error;
		}
		return resealed;
	}

	/** `row` with sealed `data` opened; a row this machine cannot open reads as unparsable, like a corrupt one. */
	#reveal<T extends { data: string; salt: string | null }>(row: T): T {
		if (row.salt === null) return row;
		try {
			if (this.#cipher) return { ...row, data: this.#cipher.open({ data: row.data, salt: row.salt }) };
		} catch {}
		if (!this.#warnedUnopenable) {
			this.#warnedUnopenable = true;
			logger.warn(
				"Stored credentials are sealed under a master key this machine's credential vault does not hold; log in again to replace them",
			);
		}
		return { ...row, data: "" };
	}

	#activeRows(provider?: string): AuthRow[] {
		const rows = (provider ? this.#listActiveByProviderStmt.all(provider) : this.#listActiveStmt.all()) as AuthRow[];
		return rows.map(row => this.#reveal(row));
	}

	#disabledRows(provider?: string): DisabledAuthRow[] {
		const rows = (
			provider ? this.#listDisabledByProviderStmt.all(provider) : this.#listDisabledStmt.all()
		) as DisabledAuthRow[];
		return rows.map(row => this.#reveal(row));
	}

	#credentialState(id: number): CredentialStateRow | null {
		const row = this.#getCredentialStateStmt.get(id) as CredentialStateRow | null;
		return row && this.#reveal(row);
	}

	/** `data` as written: sealed when this store encrypts. */
	#seal(data: string): { data: string; salt: string | null } {
		return this.#encrypt && this.#cipher ? this.#cipher.seal(data) : { data, salt: null };
	}

	#insertRow(provider: string, serialized: SerializedCredentialRecord): number | null {
		const { data, salt } = this.#seal(serialized.data);
		const row = this.#insertStmt.get(provider, serialized.credentialType, data, salt, serialized.identityKey) as
			| { id?: number }
			| undefined;
		return row?.id ?? null;
	}

	#updateRow(id: number, serialized: SerializedCredentialRecord): void {
		const { data, salt } = this.#seal(serialized.data);
		this.#updateStmt.run(serialized.credentialType, data, salt, serialized.identityKey, id);
	}

	/**
	 * Copies the credentials still readable in a quarantined store into this one, keeping
	 * their ids so block and lease rows keep pointing at them. Never throws and never stays
	 * silent: a failed salvage is logged as an error naming the quarantined path, which
	 * keeps the original bytes for `sqlite3 <path> '.recover'`.
	 * @returns the number of credentials restored
	 */
	salvageQuarantinedCredentials(backupPath: string): number {
		const columns = [
			"id",
			"provider",
			"credential_type",
			"data",
			"salt",
			"disabled_cause",
			"disabled",
			"identity_key",
			"created_at",
			"updated_at",
		];
		try {
			using source = openQuarantinedStoreForSalvage(backupPath);
			const present = new Set(
				source.db
					.query<{ name: string }, []>("PRAGMA table_info(auth_credentials)")
					.all()
					.map(column => column.name),
			);
			if (!["id", "provider", "credential_type", "data"].every(column => present.has(column))) {
				throw new Error("quarantined store has no readable auth_credentials table");
			}
			const rows = readSalvageableRows<Record<string, unknown>>(
				source.db,
				"auth_credentials",
				columns.filter(column => present.has(column)).join(", "),
			).filter(
				row =>
					Number.isSafeInteger(row.id) &&
					typeof row.provider === "string" &&
					typeof row.credential_type === "string" &&
					typeof row.data === "string",
			);
			const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
			const epoch = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);
			// Every non-NULL cause disables a row at runtime; a damaged non-text cause must not revive it.
			const disabledCause = (value: unknown): string | null =>
				value === null || value === undefined ? null : typeof value === "string" ? value : "disabled";
			let restored = 0;
			this.#db.transaction(() => {
				using insert = this.#db.prepare(
					`INSERT OR IGNORE INTO auth_credentials (id, provider, credential_type, data, salt, disabled_cause, identity_key, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQLITE_NOW_EPOCH}), COALESCE(?, ${SQLITE_NOW_EPOCH}))`,
				);
				for (const row of rows) {
					const result = insert.run(
						row.id as number,
						row.provider as string,
						row.credential_type as string,
						row.data as string,
						text(row.salt),
						present.has("disabled_cause")
							? disabledCause(row.disabled_cause)
							: row.disabled === 1
								? "disabled"
								: null,
						text(row.identity_key),
						epoch(row.created_at),
						epoch(row.updated_at),
					);
					restored += result.changes;
				}
			})();
			// Logins an auth broker does not serve stay local; without their markers the
			// hybrid store would route the restored credentials back to the broker.
			try {
				const providers = readSalvageableRows<Record<string, unknown>>(
					source.db,
					"auth_broker_local_providers",
					"provider, created_at",
				);
				for (const row of providers) {
					if (typeof row.provider !== "string") continue;
					this.#db.run(
						`INSERT OR IGNORE INTO auth_broker_local_providers (provider, created_at) VALUES (?, COALESCE(?, ${SQLITE_NOW_EPOCH}))`,
						[row.provider, epoch(row.created_at)],
					);
				}
			} catch (error) {
				logger.debug("No local-provider markers salvaged from the quarantined auth database", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// The replacement is already at the current schema, so rows from an older
			// store never pass through the migration that renamed their provider.
			if (rows.some(row => row.provider === "singularityapi")) this.#migrateAuthSchemaV7ToV8();
			const log = restored > 0 ? logger.warn : logger.error;
			log("Restored credentials from the quarantined auth database", {
				quarantinedPath: backupPath,
				restored,
				readable: rows.length,
				headerRepaired: source.headerRepaired,
			});
			return restored;
		} catch (error) {
			logger.error(
				"Could not restore credentials from the quarantined auth database; stored credentials are missing until you log in again or recover them manually",
				{
					quarantinedPath: backupPath,
					error: error instanceof Error ? error.message : String(error),
					recover: `sqlite3 '${backupPath}' '.recover'`,
				},
			);
			return 0;
		}
	}

	static #ensureAuthCredentialRefreshLeasesTable(db: Database): void {
		db.run(`
			CREATE TABLE IF NOT EXISTS auth_credential_refresh_leases (
				credential_id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_credential_refresh_leases_expires ON auth_credential_refresh_leases(expires_at_ms);
		`);
	}

	/**
	 * Install the per-connection busy handler so lock-taking statements wait for
	 * a contended writer instead of failing immediately (Bun defaults
	 * `busy_timeout` to 0). MUST run before the first lock-taking statement on
	 * the connection: concurrent omp startups race WAL recovery and the leases
	 * DDL. Uses the centralized timeout so headless hosts keep their bounded
	 * busy wait instead of the interactive 5s value. See issues #2421, #7298.
	 */
	static #installBusyTimeout(db: Database): void {
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
	}

	#initializeSchema(): void {
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which acquires an exclusive lock during WAL
		// recovery). Without this, concurrent omp startups can crash here with
		// `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY`. Re-setting when opened via
		// `open()` (which already installed it) is idempotent. See issue #2421.
		SqliteAuthCredentialStore.#installBusyTimeout(this.#db);
		this.#db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
			CREATE TABLE IF NOT EXISTS auth_broker_local_providers (
				provider TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_usage_history_series ON usage_history(provider, account_key, limit_id, recorded_at);
			CREATE INDEX IF NOT EXISTS idx_usage_history_recorded ON usage_history(recorded_at);
			CREATE TABLE IF NOT EXISTS clients (
				install_id TEXT PRIMARY KEY,
				hostname TEXT,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS client_usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				install_id TEXT NOT NULL,
				app TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				requests INTEGER NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				cost_usd REAL NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_client_usage_series ON client_usage(install_id, provider, model, recorded_at);
			CREATE INDEX IF NOT EXISTS idx_client_usage_recorded ON client_usage(recorded_at);
		`);
		this.#ensureClientUsageAppColumn();

		if (!this.#authCredentialsTableExists()) {
			this.#createAuthCredentialsTable();
			this.#createAuthCredentialBlocksTable();
			this.#createAuthCredentialRefreshLeasesTable();
			this.#createAuthCredentialBlockCompatibilityObjects();
			this.#createAuthChangeTrackingObjects();
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
			return;
		}

		const recordedVersion = this.#readAuthSchemaVersion();
		const schemaVersion = recordedVersion ?? this.#inferAuthSchemaVersion();
		if (schemaVersion > AUTH_SCHEMA_VERSION) {
			logger.warn("SqliteAuthCredentialStore schema version mismatch", {
				current: schemaVersion,
				expected: AUTH_SCHEMA_VERSION,
			});
		} else if (schemaVersion < AUTH_SCHEMA_VERSION) {
			this.#migrateAuthSchema(schemaVersion);
		}
		this.#ensureAuthCredentialSaltColumn();

		this.#createAuthCredentialIndexes();
		this.#createAuthCredentialBlocksTable();
		this.#createAuthCredentialRefreshLeasesTable();
		if (schemaVersion <= AUTH_SCHEMA_VERSION) {
			this.#createAuthCredentialBlockCompatibilityObjects();
		}
		this.#createAuthChangeTrackingObjects();
		this.#backfillCredentialIdentityKeys();
		// Rewriting an already-current version row is a no-op write transaction
		// on every boot; only persist when the recorded version actually changes.
		if (recordedVersion !== AUTH_SCHEMA_VERSION && schemaVersion <= AUTH_SCHEMA_VERSION) {
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
		}
	}

	#authCredentialsTableExists(): boolean {
		const stmt = this.#db.prepare(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'",
		);
		try {
			const row = stmt.get() as { present?: number } | undefined;
			return row?.present === 1;
		} finally {
			stmt.finalize();
		}
	}

	#readAuthSchemaVersion(): number | null {
		const stmt = this.#db.prepare("SELECT version FROM auth_schema_version WHERE id = 1");
		try {
			const row = stmt.get() as { version?: number } | undefined;
			return typeof row?.version === "number" ? row.version : null;
		} finally {
			stmt.finalize();
		}
	}

	#writeAuthSchemaVersion(version: number): void {
		const stmt = this.#db.prepare("INSERT OR REPLACE INTO auth_schema_version(id, version) VALUES (1, ?)");
		try {
			stmt.run(version);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersion(): number {
		const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
		try {
			const cols = stmt.all() as Array<{ name?: string }>;
			return this.#inferAuthSchemaVersionFromColumns(cols);
		} finally {
			stmt.finalize();
		}
	}

	#inferAuthSchemaVersionFromColumns(cols: Array<{ name?: string }>): number {
		const hasDisabledCause = cols.some(column => column.name === "disabled_cause");
		const hasIdentityKey = cols.some(column => column.name === "identity_key");
		const hasAccountId = cols.some(column => column.name === "account_id");
		const hasEmail = cols.some(column => column.name === "email");
		if (hasIdentityKey) return 3;
		if (hasAccountId || hasEmail) return 2;
		if (hasDisabledCause) return 1;
		return 0;
	}

	#createAuthCredentialsTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				salt TEXT DEFAULT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
				updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
			);
		`);
		this.#createAuthCredentialIndexes();
	}

	#createAuthCredentialIndexes(): void {
		this.#db.run(`
			CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;
		`);
	}

	#createAuthCredentialBlocksTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credential_blocks (
				credential_id INTEGER NOT NULL,
				provider_key TEXT NOT NULL,
				block_scope TEXT NOT NULL DEFAULT '',
				blocked_until_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (credential_id, provider_key, block_scope)
			);
			CREATE INDEX IF NOT EXISTS idx_auth_credential_blocks_expires ON auth_credential_blocks(blocked_until_ms);
		`);
	}

	#createAuthChangeTrackingObjects(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_change_revision (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				revision INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO auth_change_revision (id, revision) VALUES (1, 0);
			CREATE TEMP TABLE IF NOT EXISTS auth_local_change_revision (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				revision INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO auth_local_change_revision (id, revision) VALUES (1, 0);
		`);
		for (const table of ["auth_credentials", "auth_credential_blocks"] as const) {
			for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
				this.#db.run(`
					CREATE TRIGGER IF NOT EXISTS auth_change_revision_${table}_${event.toLowerCase()}
					AFTER ${event} ON ${table}
					BEGIN
						UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
					END;
				`);
				this.#db.run(`
					CREATE TEMP TRIGGER IF NOT EXISTS auth_local_change_revision_${table}_${event.toLowerCase()}
					AFTER ${event} ON main.${table}
					BEGIN
						UPDATE auth_local_change_revision SET revision = revision + 1 WHERE id = 1;
					END;
				`);
			}
		}
	}

	#createAuthCredentialBlockMirrorGuardTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credential_block_mirror_guard (
				credential_id INTEGER PRIMARY KEY
			) WITHOUT ROWID;
		`);
	}

	/**
	 * Keep a physical Codex `shared` row for pre-meter binaries that read this
	 * database directly. Meter rows are canonical for current code. The guard
	 * suppresses feedback while triggers update the compatibility projection.
	 */
	#createAuthCredentialBlockCompatibilityTriggers(): void {
		for (const event of ["INSERT", "UPDATE"] as const) {
			const eventName = event.toLowerCase();
			this.#db.run(`
				CREATE TRIGGER IF NOT EXISTS auth_codex_shared_${eventName}_to_meters
				AFTER ${event} ON auth_credential_blocks
				WHEN NEW.provider_key = 'openai-codex:oauth'
					AND NEW.block_scope = 'shared'
					AND NOT EXISTS (
						SELECT 1 FROM auth_credential_block_mirror_guard
						WHERE credential_id = NEW.credential_id
					)
				BEGIN
					INSERT OR IGNORE INTO auth_credential_block_mirror_guard (credential_id)
					VALUES (NEW.credential_id);
					INSERT INTO auth_credential_blocks (
						credential_id,
						provider_key,
						block_scope,
						blocked_until_ms,
						updated_at
					)
					VALUES (
						NEW.credential_id,
						NEW.provider_key,
						'chat',
						NEW.blocked_until_ms,
						NEW.updated_at
					)
					ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
						blocked_until_ms = MAX(auth_credential_blocks.blocked_until_ms, excluded.blocked_until_ms),
						updated_at = MAX(auth_credential_blocks.updated_at, excluded.updated_at);
					INSERT INTO auth_credential_blocks (
						credential_id,
						provider_key,
						block_scope,
						blocked_until_ms,
						updated_at
					)
					VALUES (
						NEW.credential_id,
						NEW.provider_key,
						'spark',
						NEW.blocked_until_ms,
						NEW.updated_at
					)
					ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
						blocked_until_ms = MAX(auth_credential_blocks.blocked_until_ms, excluded.blocked_until_ms),
						updated_at = MAX(auth_credential_blocks.updated_at, excluded.updated_at);
					DELETE FROM auth_credential_block_mirror_guard
					WHERE credential_id = NEW.credential_id;
				END;

				CREATE TRIGGER IF NOT EXISTS auth_codex_meter_${eventName}_to_shared
				AFTER ${event} ON auth_credential_blocks
				WHEN NEW.provider_key = 'openai-codex:oauth'
					AND NEW.block_scope IN ('chat', 'spark')
					AND NOT EXISTS (
						SELECT 1 FROM auth_credential_block_mirror_guard
						WHERE credential_id = NEW.credential_id
					)
				BEGIN
					INSERT OR IGNORE INTO auth_credential_block_mirror_guard (credential_id)
					VALUES (NEW.credential_id);
					DELETE FROM auth_credential_blocks
					WHERE credential_id = NEW.credential_id
						AND provider_key = NEW.provider_key
						AND block_scope = 'shared';
					INSERT INTO auth_credential_blocks (
						credential_id,
						provider_key,
						block_scope,
						blocked_until_ms,
						updated_at
					)
					SELECT
						NEW.credential_id,
						NEW.provider_key,
						'shared',
						MAX(blocked_until_ms),
						MAX(updated_at)
					FROM auth_credential_blocks
					WHERE credential_id = NEW.credential_id
						AND provider_key = NEW.provider_key
						AND block_scope IN ('chat', 'spark')
					GROUP BY credential_id, provider_key;
					DELETE FROM auth_credential_block_mirror_guard
					WHERE credential_id = NEW.credential_id;
				END;
			`);
		}

		this.#db.run(`
			CREATE TRIGGER IF NOT EXISTS auth_codex_shared_delete_to_meters
			AFTER DELETE ON auth_credential_blocks
			WHEN OLD.provider_key = 'openai-codex:oauth'
				AND OLD.block_scope = 'shared'
				AND NOT EXISTS (
					SELECT 1 FROM auth_credential_block_mirror_guard
					WHERE credential_id = OLD.credential_id
				)
			BEGIN
				INSERT OR IGNORE INTO auth_credential_block_mirror_guard (credential_id)
				VALUES (OLD.credential_id);
				DELETE FROM auth_credential_blocks
				WHERE credential_id = OLD.credential_id
					AND provider_key = OLD.provider_key
					AND block_scope IN ('chat', 'spark');
				DELETE FROM auth_credential_block_mirror_guard
				WHERE credential_id = OLD.credential_id;
			END;

			CREATE TRIGGER IF NOT EXISTS auth_codex_meter_delete_to_shared
			AFTER DELETE ON auth_credential_blocks
			WHEN OLD.provider_key = 'openai-codex:oauth'
				AND OLD.block_scope IN ('chat', 'spark')
				AND NOT EXISTS (
					SELECT 1 FROM auth_credential_block_mirror_guard
					WHERE credential_id = OLD.credential_id
				)
			BEGIN
				INSERT OR IGNORE INTO auth_credential_block_mirror_guard (credential_id)
				VALUES (OLD.credential_id);
				DELETE FROM auth_credential_blocks
				WHERE credential_id = OLD.credential_id
					AND provider_key = OLD.provider_key
					AND block_scope = 'shared';
				INSERT INTO auth_credential_blocks (
					credential_id,
					provider_key,
					block_scope,
					blocked_until_ms,
					updated_at
				)
				SELECT
					OLD.credential_id,
					OLD.provider_key,
					'shared',
					MAX(blocked_until_ms),
					MAX(updated_at)
				FROM auth_credential_blocks
				WHERE credential_id = OLD.credential_id
					AND provider_key = OLD.provider_key
					AND block_scope IN ('chat', 'spark')
				GROUP BY credential_id, provider_key;
				DELETE FROM auth_credential_block_mirror_guard
				WHERE credential_id = OLD.credential_id;
			END;
		`);
	}

	#createAuthCredentialBlockCompatibilityObjects(): void {
		this.#createAuthCredentialBlockMirrorGuardTable();
		this.#createAuthCredentialBlockCompatibilityTriggers();
	}

	#createAuthCredentialRefreshLeasesTable(): void {
		SqliteAuthCredentialStore.#ensureAuthCredentialRefreshLeasesTable(this.#db);
	}

	#migrateAuthSchema(fromVersion: number): void {
		if (fromVersion < 1) {
			this.#migrateAuthSchemaV0ToV1();
		}
		if (fromVersion < 3) {
			this.#migrateAuthSchemaV1OrV2ToV3();
		}
		if (fromVersion < 4) {
			this.#migrateAuthSchemaV3ToV4();
		}
		if (fromVersion < 5) {
			this.#migrateAuthSchemaV4ToV5();
		}
		if (fromVersion < 6) {
			this.#migrateAuthSchemaV5ToV6();
		}
		if (fromVersion < 7) {
			this.#migrateAuthSchemaV6ToV7();
		}
		if (fromVersion < 8) {
			this.#migrateAuthSchemaV7ToV8();
		}
		// v8 → v9 (the `salt` column) runs on every open in #initializeSchema.
	}

	#migrateAuthSchemaV0ToV1(): void {
		const migrate = this.#db.transaction(() => {
			const stmt = this.#db.prepare("PRAGMA table_info(auth_credentials)");
			let hasDisabled = false;
			try {
				const v0Cols = stmt.all() as Array<{ name?: string }>;
				hasDisabled = v0Cols.some(col => col.name === "disabled");
			} finally {
				stmt.finalize();
			}

			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v0");
			this.#db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
					updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
				);
			`);
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					${hasDisabled ? "CASE WHEN disabled = 1 THEN 'disabled' ELSE NULL END" : "NULL"},
					created_at,
					updated_at
				FROM auth_credentials_v0
			`);
			this.#db.run("DROP TABLE auth_credentials_v0");
		});
		migrate();
	}

	#migrateAuthSchemaV1OrV2ToV3(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_legacy");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					NULL,
					created_at,
					updated_at
				FROM auth_credentials_legacy
			`);
			this.#db.run("DROP TABLE auth_credentials_legacy");
		});
		migrate();
	}

	#migrateAuthSchemaV3ToV4(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v3");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					identity_key,
					created_at,
					updated_at
				FROM auth_credentials_v3
			`);
			this.#db.run("DROP TABLE auth_credentials_v3");
		});
		migrate();
	}

	#migrateAuthSchemaV4ToV5(): void {
		const migrate = this.#db.transaction(() => {
			this.#createAuthCredentialBlocksTable();
		});
		migrate();
	}

	#migrateAuthSchemaV5ToV6(): void {
		const migrate = this.#db.transaction(() => {
			this.#createAuthCredentialRefreshLeasesTable();
		});
		migrate();
	}

	#migrateAuthSchemaV6ToV7(): void {
		const migrate = this.#db.transaction(() => {
			this.#createAuthCredentialBlocksTable();
			this.#createAuthCredentialBlockMirrorGuardTable();
			this.#db.run(`
				DELETE FROM auth_credential_block_mirror_guard;
				INSERT OR IGNORE INTO auth_credential_block_mirror_guard (credential_id)
				SELECT DISTINCT credential_id
				FROM auth_credential_blocks
				WHERE provider_key = 'openai-codex:oauth'
					AND block_scope IN ('chat', 'spark', 'shared');

				INSERT INTO auth_credential_blocks (
					credential_id,
					provider_key,
					block_scope,
					blocked_until_ms,
					updated_at
				)
				SELECT credential_id, provider_key, 'chat', blocked_until_ms, updated_at
				FROM auth_credential_blocks
				WHERE provider_key = 'openai-codex:oauth'
					AND block_scope = 'shared'
				ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
					blocked_until_ms = MAX(auth_credential_blocks.blocked_until_ms, excluded.blocked_until_ms),
					updated_at = MAX(auth_credential_blocks.updated_at, excluded.updated_at);

				INSERT INTO auth_credential_blocks (
					credential_id,
					provider_key,
					block_scope,
					blocked_until_ms,
					updated_at
				)
				SELECT credential_id, provider_key, 'spark', blocked_until_ms, updated_at
				FROM auth_credential_blocks
				WHERE provider_key = 'openai-codex:oauth'
					AND block_scope = 'shared'
				ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
					blocked_until_ms = MAX(auth_credential_blocks.blocked_until_ms, excluded.blocked_until_ms),
					updated_at = MAX(auth_credential_blocks.updated_at, excluded.updated_at);

				INSERT INTO auth_credential_blocks (
					credential_id,
					provider_key,
					block_scope,
					blocked_until_ms,
					updated_at
				)
				SELECT
					credential_id,
					provider_key,
					'shared',
					MAX(blocked_until_ms),
					MAX(updated_at)
				FROM auth_credential_blocks
				WHERE provider_key = 'openai-codex:oauth'
					AND block_scope IN ('chat', 'spark')
				GROUP BY credential_id, provider_key
				ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
					blocked_until_ms = excluded.blocked_until_ms,
					updated_at = excluded.updated_at;

				DELETE FROM auth_credential_block_mirror_guard;
			`);
			this.#createAuthCredentialBlockCompatibilityTriggers();
			this.#writeAuthSchemaVersion(7);
		});
		migrate.immediate();
	}

	#migrateAuthSchemaV7ToV8(): void {
		const migrate = this.#db.transaction(() => {
			// SingularityAPI split into two providers — the pay-as-you-go universal
			// gateway and the slot-reserved lanes — and keys stored under the
			// retired shared id belong to one or the other by format: the gateway
			// issues `sk-sapi-...` while the lanes issue plain `sk-...` (both
			// observed live 2026-09-22), and neither key is accepted by the other
			// host. Route each stored credential to the product that serves it
			// instead of orphaning it under an id nothing reads anymore.
			const select = this.#db.prepare(
				"SELECT id, credential_type, data FROM auth_credentials WHERE provider = 'singularityapi'",
			);
			let rows: Array<{ id: number; credential_type: string; data: string }>;
			try {
				rows = select.all() as Array<{ id: number; credential_type: string; data: string }>;
			} finally {
				select.finalize();
			}
			for (const row of rows) {
				let provider = "singularityapi-tech";
				try {
					const parsed = JSON.parse(row.data) as { key?: unknown };
					if (typeof parsed.key === "string" && parsed.key.startsWith("sk-sapi-")) {
						provider = "singularityapi-dev";
					}
				} catch {
					// Unparsable payload takes the lane default; whichever product the
					// key really belongs to then answers 401 and the owner re-logs in.
				}
				this.#db.run("UPDATE auth_credentials SET provider = ? WHERE id = ?", [provider, row.id]);
				this.#db.run(
					"UPDATE auth_credential_blocks SET provider_key = ? WHERE credential_id = ? AND provider_key = ?",
					[`${provider}:${row.credential_type}`, row.id, `singularityapi:${row.credential_type}`],
				);
			}
			this.#writeAuthSchemaVersion(8);
		});
		migrate.immediate();
	}

	/**
	 * Add the per-row `salt` that marks a sealed `data` column (auth schema v9).
	 * Checked on every open, not gated on the recorded version: every credential
	 * read selects `salt`, and stores exist that record v9 without the column,
	 * which trusting the version row would leave unopenable. Tables rebuilt by
	 * the v1–v4 migrations already have it (they use the current DDL).
	 */
	#ensureAuthCredentialSaltColumn(): void {
		const columns = this.#db.query("PRAGMA table_info(auth_credentials)").all() as Array<{ name: string }>;
		if (!columns.some(column => column.name === "salt")) {
			this.#db.run("ALTER TABLE auth_credentials ADD COLUMN salt TEXT DEFAULT NULL");
		}
	}

	#backfillCredentialIdentityKeys(): void {
		const selectRowsStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, salt, disabled_cause, identity_key FROM auth_credentials WHERE credential_type = 'oauth' AND identity_key IS NULL ORDER BY id ASC",
		);
		let rows: AuthRow[];
		try {
			rows = (selectRowsStmt.all() as AuthRow[]).map(row => this.#reveal(row));
		} finally {
			selectRowsStmt.finalize();
		}
		if (rows.length === 0) return;

		let updateIdentity: Statement | null = null;
		try {
			for (const row of rows) {
				const identityKey = resolveRowCredentialIdentityKey(row.provider, row);
				// Rows whose identity cannot be derived stay NULL; writing NULL over
				// NULL would just burn a write transaction on every boot.
				if (identityKey === null) continue;
				updateIdentity ??= this.#db.prepare("UPDATE auth_credentials SET identity_key = ? WHERE id = ?");
				updateIdentity.run(identityKey, row.id);
			}
		} finally {
			updateIdentity?.finalize();
		}
	}

	// ─── AuthCredentialStore interface ──────────────────────────────────────

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const results: StoredAuthCredential[] = [];
		for (const row of this.#activeRows(provider)) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	/** Active and disabled logins alike, in id order; `AgentStorage.listAuthCredentials(…, includeDisabled)`. */
	listAllAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows: AuthRow[] = [...this.#activeRows(provider), ...this.#disabledRows(provider)];
		const results: StoredAuthCredential[] = [];
		for (const row of rows.sort((a, b) => a.id - b.id)) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	async listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
		const results: DisabledCredentialSummary[] = [];
		for (const row of this.#disabledRows(provider)) {
			const credential = deserializeCredential(row);
			const summary: DisabledCredentialSummary = {
				id: row.id,
				provider: row.provider,
				type: row.credential_type === "api_key" ? "api_key" : "oauth",
				cause: row.disabled_cause ?? "disabled",
			};
			if (credential?.type === "oauth") {
				if (credential.email) summary.email = credential.email;
				if (credential.accountId) summary.accountId = credential.accountId;
				if (credential.orgId) summary.orgId = credential.orgId;
				if (credential.orgName) summary.orgName = credential.orgName;
			}
			if (typeof row.updated_at === "number" && Number.isFinite(row.updated_at)) {
				summary.disabledAtMs = row.updated_at * 1000;
			}
			results.push(summary);
		}
		return results;
	}

	async replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existing = this.#activeRows(providerName).map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			const result: StoredAuthCredential[] = [];
			const matchedExistingIds = new Set<number>();

			for (const credential of items) {
				const serialized = serializeCredential(providerName, credential);
				if (!serialized) continue;
				const match = existing.find(
					entry =>
						!matchedExistingIds.has(entry.id) &&
						matchesReplacementCredential(providerName, entry.credential, entry.identityKey, credential),
				);
				if (match) {
					matchedExistingIds.add(match.id);
					this.#updateRow(match.id, serialized);
					result.push({ id: match.id, provider: providerName, credential, disabledCause: null });
				} else {
					const id = this.#insertRow(providerName, serialized);
					if (id) {
						result.push({ id, provider: providerName, credential, disabledCause: null });
					}
				}
			}

			for (const row of existing) {
				if (!matchedExistingIds.has(row.id)) {
					this.#deleteStmt.run("replaced by newer credential", row.id);
				}
			}

			return result;
		});

		const result = replace(provider, credentials);
		this.#purgeSupersededDisabledRows(provider, result);
		this.#purgeAnonymousOAuthTombstones(provider, result);
		return result;
	}

	async upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existing = this.#activeRows(providerName).map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			if (item.type === "oauth") {
				for (const row of existing) {
					if (row.credential && row.credential.type === "api_key") {
						this.#deleteStmt.run("replaced by oauth login", row.id);
					}
				}
			}

			let targetId: number | null = null;
			for (const row of existing) {
				if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
				if (targetId === null) {
					targetId = row.id;
					this.#updateRow(row.id, serialized);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) this.#insertRow(providerName, serialized);
			return this.listAuthCredentials(providerName);
		});

		const result = upsert(provider, credential);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	/**
	 * Hard-deletes disabled rows for a provider when an active replacement exists.
	 * OAuth credentials match by identity key; API keys match by provider and type.
	 * Disabled rows without an active same-type replacement remain recoverable.
	 */
	#purgeSupersededDisabledRows(provider: string, activeRows: StoredAuthCredential[]): void {
		try {
			let hasActiveApiKey = false;
			const activeIdentityKeys = new Set<string>();
			const activeOAuthCredentials: AuthCredential[] = [];
			for (const row of activeRows) {
				if (row.credential.type === "api_key") {
					hasActiveApiKey = true;
					continue;
				}
				activeOAuthCredentials.push(row.credential);
				const identityKey = resolveCredentialIdentityKey(provider, row.credential);
				if (identityKey) activeIdentityKeys.add(identityKey);
			}
			if (!hasActiveApiKey && activeIdentityKeys.size === 0) return;

			for (const row of this.#disabledRows(provider)) {
				if (hasActiveApiKey && row.credential_type === "api_key") {
					this.#hardDeleteStmt.run(row.id);
					continue;
				}
				const identityKey = resolveRowCredentialIdentityKey(provider, row);
				if (identityKey && activeIdentityKeys.has(identityKey)) {
					this.#hardDeleteStmt.run(row.id);
					continue;
				}
				// Exact key equality misses a tombstone whose key predates a format
				// the active row now uses (pre-org `<b>` vs `<b>|org:<o>`). An active
				// credential that WOULD have replaced this row had it still been
				// active supersedes its tombstone too, so mirror the replacement
				// matcher rather than restating a weaker rule. The one-way upgrade
				// and shared-workspace guards in matchesReplacementCredential carry
				// over, so this never over-deletes another member's or subscription's
				// row.
				const disabledCredential = deserializeCredential(row);
				if (disabledCredential === null) continue;
				const superseded = activeOAuthCredentials.some(active =>
					matchesReplacementCredential(provider, disabledCredential, identityKey, active),
				);
				if (superseded) this.#hardDeleteStmt.run(row.id);
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	/**
	 * Hard-deletes identity-less disabled OAuth rows once a full replacement stored an
	 * identity-less OAuth credential (e.g. an `mcp_oauth:*` re-login, where the provider
	 * id is the only identity). {@link replaceAuthCredentials} declares the provider's
	 * complete credential set, so such a row is superseded just as an unmatched active
	 * row is. Additive writes (upsert, refresh) never call this: a sibling identity-less
	 * login there, such as a second Devin browser login, is not a replacement.
	 */
	#purgeAnonymousOAuthTombstones(provider: string, stored: StoredAuthCredential[]): void {
		const storedAnonymous = stored.some(
			row => row.credential.type === "oauth" && resolveCredentialIdentityKey(provider, row.credential) === null,
		);
		if (!storedAnonymous) return;
		try {
			for (const row of this.#listDisabledByProviderStmt.all(provider) as AuthRow[]) {
				if (row.credential_type === "api_key") continue;
				if (resolveRowCredentialIdentityKey(provider, row) === null) this.#hardDeleteStmt.run(row.id);
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	/**
	 * Rewrites a row only when its persisted bytes change: an identical write would
	 * still bump `updated_at` and `auth_change_revision`, making every peer process
	 * reload credentials for nothing.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		try {
			const row = this.#credentialState(id);
			const provider = row?.provider ?? "";
			const serialized = serializeCredential(provider, credential);
			if (!serialized) return;
			if (row && storesSerializedCredential(row, serialized)) return;
			this.#updateRow(id, serialized);
			if (provider) {
				this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
			}
		} catch {
			// Ignore update failures
		}
	}

	tryUpdateAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		// Sealed rows differ byte-wise on every write, so the compare-and-set runs on
		// opened `data` under the write lock instead of in the UPDATE's WHERE clause.
		let rewrittenProvider: string | undefined;
		const matched = this.#db
			.transaction((): boolean => {
				const row = this.#credentialState(id);
				if (!row || row.disabled_cause !== null || row.data !== expectedData) return false;
				if (lease && !this.#holdsCredentialRefreshLeaseStmt.get(id, lease.owner, lease.nowMs)) return false;
				const serialized = serializeCredential(row.provider, credential);
				if (!serialized) return false;
				// Rewriting identical bytes would only churn the revision.
				if (storesSerializedCredential(row, serialized)) return true;
				this.#updateRow(id, serialized);
				rewrittenProvider = row.provider;
				return true;
			})
			.immediate();
		if (rewrittenProvider) {
			this.#purgeSupersededDisabledRows(rewrittenProvider, this.listAuthCredentials(rewrittenProvider));
		}
		return matched;
	}

	async deleteAuthCredential(id: number, disabledCause: string): Promise<boolean> {
		try {
			const result = this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
			return result.changes > 0;
		} catch {
			// Ignore delete failures
			return false;
		}
	}

	/**
	 * CAS-style disable: only soft-deletes the row when its (opened) `data` still
	 * matches `expectedData` and the row has not already been disabled. Used by
	 * the OAuth refresh-failure path to avoid clobbering a peer that rotated the
	 * row between our pre-check and the disable.
	 */
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		return this.#db
			.transaction((): boolean => {
				const row = this.#credentialState(id);
				if (!row || row.disabled_cause !== null || row.data !== expectedData) return false;
				if (lease && !this.#holdsCredentialRefreshLeaseStmt.get(id, lease.owner, lease.nowMs)) return false;
				return this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id).changes > 0;
			})
			.immediate();
	}
	async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
		try {
			this.#deleteByProviderStmt.run(normalizeDisabledCause(disabledCause), provider);
		} catch {
			// Ignore delete failures
		}
	}

	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		try {
			const stmt = options?.includeExpired === true ? this.#getCacheIncludingExpiredStmt : this.#getCacheStmt;
			const row = stmt.get(key) as { value?: string } | undefined;
			return row?.value ?? null;
		} catch {
			return null;
		}
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		try {
			this.#upsertCacheStmt.run(key, value, expiresAtSec);
		} catch {
			// Ignore cache set failures
		}
	}

	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix(prefix: string): void {
		try {
			this.#deleteCachePrefixStmt.run(prefix.length, prefix);
		} catch {
			// Ignore cache delete failures
		}
	}

	cleanExpiredCache(): void {
		try {
			this.#deleteExpiredCacheStmt.run();
		} catch {
			// Ignore cleanup errors
		}
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		// Current callers use meter scopes. The physical shared row exists only
		// for direct SQLite readers from pre-meter releases.
		if (providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY && blockScope === LEGACY_CODEX_BLOCK_SCOPE) {
			return undefined;
		}
		this.#sweepExpiredCredentialBlocks();
		const row = this.#getCredentialBlockStmt.get(credentialId, providerKey, blockScope, Date.now()) as
			| { blocked_until_ms?: number; updated_at?: number }
			| undefined;
		return typeof row?.blocked_until_ms === "number" ? row.blocked_until_ms : undefined;
	}

	getCredentialBlockScopes(credentialId: number, providerKey: string): Map<string, number> {
		this.#sweepExpiredCredentialBlocks();
		const rows = this.#listCredentialBlockScopesStmt.all(credentialId, providerKey, Date.now()) as Array<
			Pick<CredentialBlockRow, "block_scope" | "blocked_until_ms">
		>;
		const hidesLegacyShared = providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY;
		const scopes = new Map<string, number>();
		for (const row of rows) {
			if (hidesLegacyShared && row.block_scope === LEGACY_CODEX_BLOCK_SCOPE) continue;
			scopes.set(row.block_scope, row.blocked_until_ms);
		}
		return scopes;
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		if (providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY && blockScope === LEGACY_CODEX_BLOCK_SCOPE) {
			return undefined;
		}
		this.#sweepExpiredCredentialBlocks();
		const nowMs = Date.now();
		const row = this.#getCredentialBlockStmt.get(credentialId, providerKey, blockScope, nowMs) as
			| { blocked_until_ms?: number; updated_at?: number }
			| undefined;
		if (typeof row?.blocked_until_ms !== "number") return undefined;
		const memoryReconcileAfter =
			this.#credentialBlockReconcileAfter.get(`${credentialId}\0${providerKey}\0${blockScope}`) ?? 0;
		const persistedReconcileAfter =
			typeof row.updated_at === "number" ? row.updated_at * 1000 + USAGE_REPORT_TTL_MS : 0;
		const reconcileAfter = Math.max(memoryReconcileAfter, persistedReconcileAfter);
		return reconcileAfter > nowMs ? Math.min(row.blocked_until_ms, reconcileAfter) : undefined;
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		const isLegacyCodexBlock =
			block.providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY && block.blockScope === LEGACY_CODEX_BLOCK_SCOPE;
		const blockScopes = isLegacyCodexBlock ? CODEX_METER_BLOCK_SCOPES : [block.blockScope];
		const nowMs = Date.now();
		const upsert = this.#db.transaction(() => {
			// A mark already holds the write lock: sweep expired rows in the same transaction.
			this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
			for (const blockScope of blockScopes) {
				this.#upsertCredentialBlockStmt.run(
					block.credentialId,
					block.providerKey,
					blockScope,
					block.blockedUntilMs,
				);
			}
		});
		upsert.immediate();
		this.#lastCredentialBlockSweepMs = nowMs;
		this.#pruneCredentialBlockReconcileAfter(nowMs);

		const reconcileAfterMs = Math.min(block.blockedUntilMs, nowMs + USAGE_REPORT_TTL_MS);
		for (const blockScope of blockScopes) {
			this.#credentialBlockReconcileAfter.set(
				`${block.credentialId}\0${block.providerKey}\0${blockScope}`,
				reconcileAfterMs,
			);
		}
		if (isLegacyCodexBlock) {
			this.#credentialBlockReconcileAfter.delete(
				`${block.credentialId}\0${block.providerKey}\0${LEGACY_CODEX_BLOCK_SCOPE}`,
			);
		}
	}

	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
		this.#deleteCredentialBlockStmt.run(credentialId, providerKey, blockScope);
		this.#credentialBlockReconcileAfter.delete(`${credentialId}\0${providerKey}\0${blockScope}`);
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#deleteCredentialBlocksStmt.run(credentialId);
		for (const key of this.#credentialBlockReconcileAfter.keys()) {
			if (key.startsWith(`${credentialId}\0`)) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	cleanExpiredCredentialBlocks(nowMs: number): void {
		// Stamp wall-clock time first: callers may pass a future `nowMs`, and a
		// failed sweep must not be retried by every following read.
		this.#lastCredentialBlockSweepMs = Date.now();
		this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		this.#pruneCredentialBlockReconcileAfter(nowMs);
	}

	#pruneCredentialBlockReconcileAfter(nowMs: number): void {
		for (const [key, reconcileAfterMs] of this.#credentialBlockReconcileAfter) {
			if (reconcileAfterMs <= nowMs) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	/**
	 * Read-path expiry sweep, at most once per {@link CREDENTIAL_BLOCK_SWEEP_INTERVAL_MS}.
	 * A busy write lock only postpones housekeeping; it never fails the read.
	 */
	#sweepExpiredCredentialBlocks(): void {
		const nowMs = Date.now();
		if (nowMs - this.#lastCredentialBlockSweepMs < CREDENTIAL_BLOCK_SWEEP_INTERVAL_MS) return;
		try {
			this.cleanExpiredCredentialBlocks(nowMs);
		} catch (err) {
			if (!isSqliteBusyError(err)) throw err;
		}
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (credentialIds.length === 0) return [];
		this.#sweepExpiredCredentialBlocks();
		const rows = this.#listCredentialBlocksStmt.all(
			JSON.stringify([...new Set(credentialIds)]),
			Date.now(),
			LEGACY_CODEX_BLOCK_PROVIDER_KEY,
			LEGACY_CODEX_BLOCK_SCOPE,
		) as CredentialBlockRow[];
		return rows.map(row => ({
			credentialId: row.credential_id,
			providerKey: row.provider_key,
			blockScope: row.block_scope,
			blockedUntilMs: row.blocked_until_ms,
			updatedAtMs: row.updated_at * 1000,
		}));
	}

	tryAcquireCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const result = this.#acquireCredentialRefreshLeaseStmt.run(credentialId, owner, expiresAtMs, Date.now()) as {
			changes: number;
		};
		return result.changes === 1;
	}

	getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined {
		const row = this.#getCredentialRefreshLeaseStmt.get(credentialId) as { expires_at_ms?: number } | undefined;
		if (typeof row?.expires_at_ms !== "number") return undefined;
		if (row.expires_at_ms <= Date.now()) return undefined;
		return row.expires_at_ms;
	}

	renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const result = this.#renewCredentialRefreshLeaseStmt.run(expiresAtMs, credentialId, owner) as {
			changes: number;
		};
		return result.changes === 1;
	}

	getCredentialRefreshLeaseHolder(credentialId: number): CredentialRefreshLeaseHolder | undefined {
		const row = this.#getCredentialRefreshLeaseHolderStmt.get(credentialId) as
			| { owner?: string; expires_at_ms?: number }
			| undefined;
		if (typeof row?.owner !== "string" || typeof row.expires_at_ms !== "number") return undefined;
		return { owner: row.owner, expiresAtMs: row.expires_at_ms };
	}

	handBackCredentialRefreshLease(credentialId: number, owner: string, holder: CredentialRefreshLeaseHolder): boolean {
		const result = this.#handBackCredentialRefreshLeaseStmt.run(
			holder.owner,
			holder.expiresAtMs,
			credentialId,
			owner,
		) as { changes: number };
		return result.changes === 1;
	}

	releaseCredentialRefreshLease(credentialId: number, owner: string): void {
		try {
			this.#releaseCredentialRefreshLeaseStmt.run(credentialId, owner);
		} catch {
			// Ignore lease release failures; expired leases are stealable.
		}
	}

	recordUsageSnapshots(entries: UsageHistoryEntry[]): void {
		try {
			for (const entry of entries) {
				const bucket = Math.floor(entry.recordedAt / USAGE_HISTORY_BUCKET_MS);
				const last = this.#lastUsageHistoryStmt.get(entry.provider, entry.accountKey, entry.limitId) as
					| { id: number; recorded_at: number }
					| undefined;
				if (last && Math.floor(last.recorded_at / USAGE_HISTORY_BUCKET_MS) === bucket) {
					this.#updateUsageHistoryStmt.run(
						entry.recordedAt,
						entry.email ?? null,
						entry.accountId ?? null,
						entry.label,
						entry.windowLabel ?? null,
						entry.usedFraction ?? null,
						entry.status ?? null,
						entry.resetsAt ?? null,
						last.id,
					);
					continue;
				}
				this.#insertUsageHistoryStmt.run(
					entry.recordedAt,
					entry.provider,
					entry.accountKey,
					entry.email ?? null,
					entry.accountId ?? null,
					entry.limitId,
					entry.label,
					entry.windowLabel ?? null,
					entry.usedFraction ?? null,
					entry.status ?? null,
					entry.resetsAt ?? null,
				);
			}
		} catch {
			// History is best-effort; never break the usage fetch path.
		}
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		try {
			const provider = query?.provider ?? null;
			const rows = this.#listUsageHistoryStmt.all(query?.sinceMs ?? 0, provider, provider) as Array<{
				recorded_at: number;
				provider: string;
				account_key: string;
				email: string | null;
				account_id: string | null;
				limit_id: string;
				label: string;
				window_label: string | null;
				used_fraction: number | null;
				status: string | null;
				resets_at: number | null;
			}>;
			return rows.map(row => ({
				recordedAt: row.recorded_at,
				provider: row.provider as Provider,
				accountKey: row.account_key,
				email: row.email ?? undefined,
				accountId: row.account_id ?? undefined,
				limitId: row.limit_id,
				label: row.label,
				windowLabel: row.window_label ?? undefined,
				usedFraction: row.used_fraction ?? undefined,
				status: (row.status ?? undefined) as UsageHistoryEntry["status"],
				resetsAt: row.resets_at ?? undefined,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Add the `app` attribution column to `client_usage` tables created before
	 * it existed. `CREATE TABLE IF NOT EXISTS` skips established broker DBs, so
	 * the column arrives via ALTER; legacy rows keep the `''` (unlabeled) app.
	 */
	#ensureClientUsageAppColumn(): void {
		const columns = this.#db.query("PRAGMA table_info(client_usage)").all() as Array<{ name: string }>;
		if (!columns.some(column => column.name === "app")) {
			this.#db.run("ALTER TABLE client_usage ADD COLUMN app TEXT NOT NULL DEFAULT ''");
		}
	}

	recordClientUsage(report: ClientUsageReport): void {
		const now = Date.now();
		this.#db
			.query(
				`INSERT INTO clients (install_id, hostname, first_seen, last_seen) VALUES (?, ?, ?, ?)
				 ON CONFLICT(install_id) DO UPDATE SET hostname = COALESCE(excluded.hostname, hostname), last_seen = excluded.last_seen`,
			)
			.run(report.installId, report.hostname ?? null, now, now);
		const app = report.app?.trim() ?? "";
		const findBucket = this.#db.query(
			`SELECT id FROM client_usage
			 WHERE install_id = ? AND app = ? AND provider = ? AND model = ? AND recorded_at >= ?
			 ORDER BY recorded_at DESC LIMIT 1`,
		);
		const merge = this.#db.query(
			`UPDATE client_usage SET recorded_at = ?, requests = requests + ?, input_tokens = input_tokens + ?,
				output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ?,
				cache_write_tokens = cache_write_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?`,
		);
		const insert = this.#db.query(
			`INSERT INTO client_usage (recorded_at, install_id, app, provider, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const entry of report.entries) {
			// Merge into the newest row of the same (install, provider, model)
			// bucket so 10s client flushes don't accrete one row apiece forever.
			const bucketFloor = entry.at - CLIENT_USAGE_BUCKET_MS;
			const existing = findBucket.get(report.installId, app, entry.provider, entry.model, bucketFloor) as {
				id: number;
			} | null;
			if (existing) {
				merge.run(
					entry.at,
					entry.requests,
					entry.inputTokens,
					entry.outputTokens,
					entry.cacheReadTokens,
					entry.cacheWriteTokens,
					entry.costUsd,
					existing.id,
				);
				continue;
			}
			insert.run(
				entry.at,
				report.installId,
				app,
				entry.provider,
				entry.model,
				entry.requests,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheReadTokens,
				entry.cacheWriteTokens,
				entry.costUsd,
			);
		}
	}

	getClientUsageSummary(sinceMs: number): ClientUsageSummary {
		const clients = this.#db
			.query("SELECT install_id, hostname, first_seen, last_seen FROM clients ORDER BY last_seen DESC")
			.all() as Array<{ install_id: string; hostname: string | null; first_seen: number; last_seen: number }>;
		const aggregates = this.#db
			.query(
				`SELECT install_id, app, provider, SUM(requests) requests, SUM(input_tokens) input_tokens,
					SUM(output_tokens) output_tokens, SUM(cache_read_tokens) cache_read_tokens,
					SUM(cache_write_tokens) cache_write_tokens, SUM(cost_usd) cost_usd
				 FROM client_usage WHERE recorded_at >= ? GROUP BY install_id, app, provider
				 ORDER BY install_id, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) DESC`,
			)
			.all(sinceMs) as Array<{
			install_id: string;
			app: string;
			provider: string;
			requests: number;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cache_write_tokens: number;
			cost_usd: number;
		}>;
		const providersByInstall = new Map<string, ClientProviderUsage[]>();
		for (const row of aggregates) {
			let list = providersByInstall.get(row.install_id);
			if (!list) {
				list = [];
				providersByInstall.set(row.install_id, list);
			}
			list.push({
				app: row.app === "" ? undefined : row.app,
				provider: row.provider,
				requests: row.requests,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cacheWriteTokens: row.cache_write_tokens,
				costUsd: row.cost_usd,
			});
		}
		return {
			clients: clients.map(client => ({
				installId: client.install_id,
				hostname: client.hostname ?? undefined,
				firstSeen: client.first_seen,
				lastSeen: client.last_seen,
				providers: providersByInstall.get(client.install_id) ?? [],
			})),
		};
	}

	// ─── Convenience methods for CLI ────────────────────────────────────────

	/**
	 * Save OAuth credentials for a provider.
	 * Preserves unrelated identities and replaces only the matching credential.
	 */
	async saveOAuth(provider: string, credentials: OAuthCredentials): Promise<void> {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		await this.upsertAuthCredential(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		for (const row of this.#activeRows(provider)) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "oauth") {
				const { type: _type, ...oauth } = credential;
				return oauth as OAuthCredentials;
			}
		}
		return null;
	}

	/**
	 * Save API key for a provider (replaces existing).
	 */
	async saveApiKey(provider: string, apiKey: string): Promise<void> {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		await this.replaceAuthCredentials(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		for (const row of this.#activeRows(provider)) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "api_key") {
				return credential.key;
			}
		}
		return null;
	}

	/**
	 * List all providers with credentials.
	 */
	listProviders(): string[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		const providers = new Set<string>();
		for (const row of rows) {
			providers.add(row.provider);
		}
		return Array.from(providers);
	}

	/**
	 * Delete all credentials for a provider.
	 */
	async deleteProvider(provider: string): Promise<void> {
		await this.deleteAuthCredentials(provider, "deleted by user");
	}

	/**
	 * Providers whose logins this machine keeps although an auth broker is
	 * configured: the broker stored them but would not serve them back.
	 * Maintained by `HybridAuthCredentialStore`.
	 */
	listBrokerLocalProviders(): string[] {
		const rows = this.#db.query<{ provider: string }, []>("SELECT provider FROM auth_broker_local_providers").all();
		return rows.map(row => row.provider);
	}

	/**
	 * Read persisted broker-local routes and their active rows in one snapshot. The
	 * left join keeps routes with no usable credential: they still hide broker rows.
	 */
	readBrokerLocalSnapshot(deviceBoundProviders: readonly string[]): {
		providers: Set<string>;
		credentials: StoredAuthCredential[];
	} {
		const providers = new Set(deviceBoundProviders);
		const credentials: StoredAuthCredential[] = [];
		for (const provider of deviceBoundProviders) {
			for (const row of this.listAuthCredentials(provider)) credentials.push(row);
		}
		const rows = this.#db
			.query<AuthRow | { provider: string; id: null }, []>(`
				SELECT p.provider, c.id, c.credential_type, c.data, c.salt, c.disabled_cause, c.identity_key
				FROM auth_broker_local_providers p LEFT JOIN auth_credentials c ON c.provider = p.provider AND c.disabled_cause IS NULL
				ORDER BY p.provider, c.id
			`)
			.all();
		for (const row of rows) {
			providers.add(row.provider);
			if (row.id === null || deviceBoundProviders.includes(row.provider)) continue;
			const credential = deserializeCredential(this.#reveal(row));
			if (credential) credentials.push(toStoredAuthCredential(row, credential));
		}
		return { providers, credentials };
	}

	/** Record `provider` in {@link listBrokerLocalProviders}; a no-op when already listed. */
	markBrokerLocalProvider(provider: string): void {
		this.#db
			.query(
				`INSERT OR IGNORE INTO auth_broker_local_providers (provider, created_at) VALUES (?, ${SQLITE_NOW_EPOCH})`,
			)
			.run(provider);
	}

	/** Drop `provider` from {@link listBrokerLocalProviders}, so its next login tries the broker again. */
	unmarkBrokerLocalProvider(provider: string): void {
		this.#db.query("DELETE FROM auth_broker_local_providers WHERE provider = ?").run(provider);
	}

	/**
	 * SQLite increments `data_version` when another connection commits. Own
	 * writes leave it unchanged and already notify AuthStorage directly.
	 */
	pollExternalChanges(): boolean {
		const dataVersion = this.#readDataVersion();
		if (dataVersion === this.#dataVersion) return false;
		this.#acknowledgeLocalAuthChanges();
		this.#dataVersion = dataVersion;
		const authRevision = this.#readAuthRevision();
		if (authRevision === this.#authRevision) return false;
		this.#authRevision = authRevision;
		return true;
	}

	acknowledgeLocalChanges(): void {
		this.#acknowledgeLocalAuthChanges();
	}

	#acknowledgeLocalAuthChanges(): void {
		const localAuthRevision = this.#readLocalAuthRevision();
		this.#authRevision += localAuthRevision - this.#localAuthRevision;
		this.#localAuthRevision = localAuthRevision;
	}

	#readDataVersion(): number {
		const row = this.#db.query("PRAGMA data_version").get() as { data_version?: number } | null;
		return row?.data_version ?? 0;
	}

	#readAuthRevision(): number {
		const row = this.#db.query("SELECT revision FROM auth_change_revision WHERE id = 1").get() as {
			revision?: number;
		} | null;
		return row?.revision ?? 0;
	}

	#readLocalAuthRevision(): number {
		const row = this.#db.query("SELECT revision FROM auth_local_change_revision WHERE id = 1").get() as {
			revision?: number;
		} | null;
		return row?.revision ?? 0;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const stmt of this.#statements) stmt.finalize();
		if (!this.#borrowConnection) {
			// A deferred close can leave the database file locked on Windows.
			this.#db.close(true);
		}
	}
}

/**
 * SQLite-backed credential persistence for AuthStorage.
 *
 * The public AuthCredentialStore interface remains in ../auth-storage so local
 * and remote stores share the same contract.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import { parseCloudflareAiGatewayCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import {
	getAgentDbPath,
	getDbBusyTimeoutMs,
	isSqliteBusyError,
	isSqliteCorruptionError,
	logger,
} from "@oh-my-pi/pi-utils";
import type {
	AuthCredential,
	AuthCredentialStore,
	CredentialRefreshLeaseFence,
	DisabledCredentialSummary,
	OAuthCredential,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "../auth-storage";
import * as AIError from "../error";
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

/** Row shape for auth_credentials table queries */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
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

const AUTH_SCHEMA_VERSION = 7;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";
const LEGACY_CODEX_BLOCK_PROVIDER_KEY = "openai-codex:oauth";
const LEGACY_CODEX_BLOCK_SCOPE = "shared";
const CODEX_METER_BLOCK_SCOPES = ["chat", "spark"] as const;

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

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if (provider === "anthropic" || provider === "openai-codex") {
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

export function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

function matchesReplacementCredential(
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
		if (provider === "cloudflare-ai-gateway") {
			const existingToken = parseCloudflareAiGatewayCredential(existing.key)?.token;
			const incomingToken = parseCloudflareAiGatewayCredential(incoming.key)?.token;
			return existingToken !== undefined && existingToken === incomingToken;
		}
		return false;
	}
	const incomingIdentifiers = extractOAuthCredentialIdentifiers(incoming);
	const incomingIdentityKey = resolveProviderCredentialIdentityKey(provider, incomingIdentifiers);
	if (incomingIdentityKey === null) return false;
	if (incomingIdentityKey === existingIdentityKey) return true;
	if (existingIdentityKey === null) return false;
	// One-way upgrade, applied only when the INCOMING identity key carries the
	// org qualifier (only anthropic and openai-codex keys do, so other
	// providers never reach the checks below). An org-scoped login `org:<o>`
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
 * Default SQLite-backed implementation of {@link AuthCredentialStore}.
 *
 * Used by the pi-ai CLI and as the default store for `AuthStorage.create()`.
 * Also exposes convenience methods (`saveOAuth`, `getOAuth`, `saveApiKey`,
 * `getApiKey`, `listProviders`, `deleteProvider`) that callers can use directly
 * without going through `AuthStorage`.
 */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteIfMatchesStmt: Statement;
	#updateIfMatchesStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#getCacheIncludingExpiredStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteCachePrefixStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#updateIfMatchesWithLeaseStmt: Statement;
	#deleteIfMatchesWithLeaseStmt: Statement;
	#getCredentialBlockStmt: Statement;
	#listCredentialBlocksByCredentialStmt: Statement;
	#upsertCredentialBlockStmt: Statement;
	#deleteCredentialBlocksStmt: Statement;
	#deleteCredentialBlockStmt: Statement;
	#deleteExpiredCredentialBlocksStmt: Statement;
	#acquireCredentialRefreshLeaseStmt: Statement;
	#getCredentialRefreshLeaseStmt: Statement;
	#renewCredentialRefreshLeaseStmt: Statement;
	#releaseCredentialRefreshLeaseStmt: Statement;
	#credentialBlockReconcileAfter: Map<string, number> = new Map();
	#insertUsageHistoryStmt: Statement;
	#lastUsageHistoryStmt: Statement;
	#listUsageHistoryStmt: Statement;
	#updateUsageHistoryStmt: Statement;
	#dataVersion: number;
	#authRevision: number;
	#localAuthRevision: number;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();
		this.#dataVersion = this.#readDataVersion();
		this.#authRevision = this.#readAuthRevision();
		this.#localAuthRevision = this.#readLocalAuthRevision();

		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listDisabledStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, updated_at FROM auth_credentials WHERE disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, updated_at FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
		this.#updateStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#updateIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#updateIfMatchesWithLeaseStmt = this.#db.prepare(
			`UPDATE auth_credentials
			SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH}
			WHERE id = ? AND data = ? AND disabled_cause IS NULL
				AND EXISTS (
					SELECT 1 FROM auth_credential_refresh_leases
					WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?
				)`,
		);
		this.#deleteStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#deleteIfMatchesWithLeaseStmt = this.#db.prepare(
			`UPDATE auth_credentials
			SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH}
			WHERE id = ? AND data = ? AND disabled_cause IS NULL
				AND EXISTS (
					SELECT 1 FROM auth_credential_refresh_leases
					WHERE credential_id = ? AND owner = ? AND expires_at_ms > ?
				)`,
		);
		this.#deleteByProviderStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
		);
		this.#hardDeleteStmt = this.#db.prepare("DELETE FROM auth_credentials WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#getCacheIncludingExpiredStmt = this.#db.prepare("SELECT value FROM cache WHERE key = ?");
		this.#upsertCacheStmt = this.#db.prepare(
			"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
		);
		this.#deleteCachePrefixStmt = this.#db.prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?");
		this.#deleteExpiredCacheStmt = this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
		this.#getCredentialBlockStmt = this.#db.prepare(
			"SELECT blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ? AND blocked_until_ms > ?",
		);
		this.#listCredentialBlocksByCredentialStmt = this.#db.prepare(
			`SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at
			FROM auth_credential_blocks
			WHERE credential_id = ? AND blocked_until_ms > ?
				AND NOT (provider_key = ? AND block_scope = ?)
			ORDER BY provider_key ASC, block_scope ASC`,
		);
		this.#upsertCredentialBlockStmt = this.#db.prepare(
			`INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at)
			VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH})
			ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
				blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
				updated_at = excluded.updated_at`,
		);
		this.#deleteCredentialBlocksStmt = this.#db.prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?");
		this.#deleteCredentialBlockStmt = this.#db.prepare(
			"DELETE FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ?",
		);
		this.#deleteExpiredCredentialBlocksStmt = this.#db.prepare(
			"DELETE FROM auth_credential_blocks WHERE blocked_until_ms <= ?",
		);
		this.#acquireCredentialRefreshLeaseStmt = this.#db.prepare(
			`INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at)
			VALUES (?, ?, ?, ${SQLITE_NOW_EPOCH})
			ON CONFLICT(credential_id) DO UPDATE SET
				owner = excluded.owner,
				expires_at_ms = excluded.expires_at_ms,
				updated_at = excluded.updated_at
			WHERE auth_credential_refresh_leases.expires_at_ms <= ?`,
		);
		this.#getCredentialRefreshLeaseStmt = this.#db.prepare(
			"SELECT expires_at_ms FROM auth_credential_refresh_leases WHERE credential_id = ?",
		);
		this.#renewCredentialRefreshLeaseStmt = this.#db.prepare(
			`UPDATE auth_credential_refresh_leases SET expires_at_ms = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE credential_id = ? AND owner = ?`,
		);
		this.#releaseCredentialRefreshLeaseStmt = this.#db.prepare(
			"DELETE FROM auth_credential_refresh_leases WHERE credential_id = ? AND owner = ?",
		);
		this.#insertUsageHistoryStmt = this.#db.prepare(
			"INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#lastUsageHistoryStmt = this.#db.prepare(
			"SELECT id, recorded_at FROM usage_history WHERE provider = ? AND account_key = ? AND limit_id = ? ORDER BY recorded_at DESC LIMIT 1",
		);
		this.#updateUsageHistoryStmt = this.#db.prepare(
			"UPDATE usage_history SET recorded_at = ?, email = ?, account_id = ?, label = ?, window_label = ?, used_fraction = ?, status = ?, resets_at = ? WHERE id = ?",
		);
		this.#listUsageHistoryStmt = this.#db.prepare(
			"SELECT recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at FROM usage_history WHERE recorded_at >= ? AND (? IS NULL OR provider = ?) ORDER BY recorded_at ASC",
		);
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<SqliteAuthCredentialStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		// Concurrent omp startups can race against WAL recovery and the schema
		// init's first lock-taking statement. Bun's default `busy_timeout` is 0,
		// so retry the open on `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` with bounded
		// exponential backoff before surfacing the failure. See issue #2421.
		const maxAttempts = 4;
		const baseDelayMs = 100;
		let lastBusyError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let db: Database | undefined;
			try {
				db = new Database(dbPath);
				// Install the busy handler BEFORE the first lock-taking statement
				// on this connection. The leases DDL below and the constructor's
				// schema init both acquire locks during WAL recovery; without a
				// non-zero `busy_timeout` they fail immediately with SQLITE_BUSY.
				// See issue #2421.
				SqliteAuthCredentialStore.#installBusyTimeout(db);
				try {
					await fs.chmod(dbPath, 0o600);
				} catch {
					// Ignore chmod failures (e.g., Windows)
				}
				SqliteAuthCredentialStore.#ensureAuthCredentialRefreshLeasesTable(db);
				return new SqliteAuthCredentialStore(db);
			} catch (err) {
				db?.close();
				if (!isSqliteBusyError(err)) {
					throw err;
				}
				lastBusyError = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxAttempts - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}
		throw new AIError.ConfigurationError(
			`Failed to open auth database at '${dbPath}' after ${maxAttempts} attempts: ${lastBusyError?.message}`,
			{ cause: lastBusyError },
		);
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

	#backfillCredentialIdentityKeys(): void {
		const selectRowsStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE identity_key IS NULL ORDER BY id ASC",
		);
		let rows: AuthRow[];
		try {
			rows = selectRowsStmt.all() as AuthRow[];
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
		const rows =
			(provider
				? (this.#listActiveByProviderStmt.all(provider) as AuthRow[])
				: (this.#listActiveStmt.all() as AuthRow[])) ?? [];

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	async listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
		const rows =
			(provider
				? (this.#listDisabledByProviderStmt.all(provider) as DisabledAuthRow[])
				: (this.#listDisabledStmt.all() as DisabledAuthRow[])) ?? [];
		const results: DisabledCredentialSummary[] = [];
		for (const row of rows) {
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

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
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
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, match.id);
					result.push({ id: match.id, provider: providerName, credential, disabledCause: null });
				} else {
					const row = this.#insertStmt.get(
						providerName,
						serialized.credentialType,
						serialized.data,
						serialized.identityKey,
					) as { id?: number } | undefined;
					if (row?.id) {
						result.push({ id: row.id, provider: providerName, credential, disabledCause: null });
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
		return result;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
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
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, row.id);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) {
				const row = this.#insertStmt.get(
					providerName,
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
				) as { id?: number } | undefined;
				targetId = row?.id ?? null;
			}

			const activeRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const result: StoredAuthCredential[] = [];
			for (const row of activeRows) {
				const activeCredential = deserializeCredential(row);
				if (!activeCredential) continue;
				result.push(toStoredAuthCredential(row, activeCredential));
			}
			return result;
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

			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
			for (const row of disabledRows) {
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

	updateAuthCredential(id: number, credential: AuthCredential): void {
		try {
			const providerStmt = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?");
			let providerRow: { provider?: string } | undefined;
			try {
				providerRow = providerStmt.get(id) as { provider?: string } | undefined;
			} finally {
				providerStmt.finalize();
			}
			const provider = providerRow?.provider ?? "";
			const serialized = serializeCredential(provider, credential);
			if (!serialized) return;
			this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, id);
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
		const providerStmt = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?");
		let providerRow: { provider?: string } | undefined;
		try {
			providerRow = providerStmt.get(id) as { provider?: string } | undefined;
		} finally {
			providerStmt.finalize();
		}
		const provider = providerRow?.provider ?? "";
		const serialized = serializeCredential(provider, credential);
		if (!serialized) return false;
		const result = lease
			? (this.#updateIfMatchesWithLeaseStmt.run(
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
					id,
					expectedData,
					id,
					lease.owner,
					lease.nowMs,
				) as { changes: number })
			: (this.#updateIfMatchesStmt.run(
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
					id,
					expectedData,
				) as { changes: number });
		if (result.changes === 0) return false;
		if (provider) {
			this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
		}
		return true;
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		try {
			this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
		} catch {
			// Ignore delete failures
		}
	}

	/**
	 * CAS-style disable: only soft-deletes the row when its `data` column still
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
		const result = lease
			? (this.#deleteIfMatchesWithLeaseStmt.run(
					normalizeDisabledCause(disabledCause),
					id,
					expectedData,
					id,
					lease.owner,
					lease.nowMs,
				) as { changes: number })
			: (this.#deleteIfMatchesStmt.run(normalizeDisabledCause(disabledCause), id, expectedData) as {
					changes: number;
				});
		return result.changes > 0;
	}
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
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
		const nowMs = Date.now();
		const isCodexBlock = providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY;
		// Current callers use meter scopes. The physical shared row exists only
		// for direct SQLite readers from pre-meter releases.
		if (isCodexBlock && blockScope === LEGACY_CODEX_BLOCK_SCOPE) {
			return undefined;
		}
		if (!isCodexBlock) this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		const row = this.#getCredentialBlockStmt.get(credentialId, providerKey, blockScope, nowMs) as
			| { blocked_until_ms?: number; updated_at?: number }
			| undefined;
		return typeof row?.blocked_until_ms === "number" ? row.blocked_until_ms : undefined;
	}

	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		const nowMs = Date.now();
		const isCodexBlock = providerKey === LEGACY_CODEX_BLOCK_PROVIDER_KEY;
		if (isCodexBlock && blockScope === LEGACY_CODEX_BLOCK_SCOPE) {
			return undefined;
		}
		if (!isCodexBlock) this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
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
		const upsert = this.#db.transaction(() => {
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

		const reconcileAfterMs = Math.min(block.blockedUntilMs, Date.now() + USAGE_REPORT_TTL_MS);
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
		this.#deleteExpiredCredentialBlocksStmt.run(nowMs);
		for (const [key, reconcileAfterMs] of this.#credentialBlockReconcileAfter) {
			if (reconcileAfterMs <= nowMs) this.#credentialBlockReconcileAfter.delete(key);
		}
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (credentialIds.length === 0) return [];
		const nowMs = Date.now();
		this.cleanExpiredCredentialBlocks(nowMs);
		const seenCredentialIds = new Set<number>();
		const blocks: StoredCredentialBlock[] = [];
		for (const credentialId of credentialIds) {
			if (seenCredentialIds.has(credentialId)) continue;
			seenCredentialIds.add(credentialId);
			const rows = this.#listCredentialBlocksByCredentialStmt.all(
				credentialId,
				nowMs,
				LEGACY_CODEX_BLOCK_PROVIDER_KEY,
				LEGACY_CODEX_BLOCK_SCOPE,
			) as CredentialBlockRow[];
			for (const row of rows) {
				blocks.push({
					credentialId: row.credential_id,
					providerKey: row.provider_key,
					blockScope: row.block_scope,
					blockedUntilMs: row.blocked_until_ms,
					updatedAtMs: row.updated_at * 1000,
				});
			}
		}
		return blocks;
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
	saveOAuth(provider: string, credentials: OAuthCredentials): void {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		this.upsertAuthCredentialForProvider(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
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
	saveApiKey(provider: string, apiKey: string): void {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
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
	deleteProvider(provider: string): void {
		this.deleteAuthCredentialsForProvider(provider, "deleted by user");
	}

	/**
	 * SQLite increments `data_version` when another connection commits. Own
	 * writes leave it unchanged and already notify AuthStorage directly.
	 */
	pollExternalChanges(): boolean {
		this.#acknowledgeLocalAuthChanges();
		const dataVersion = this.#readDataVersion();
		if (dataVersion === this.#dataVersion) return false;
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
		this.#listActiveStmt.finalize();
		this.#listActiveByProviderStmt.finalize();
		this.#listDisabledStmt.finalize();
		this.#listDisabledByProviderStmt.finalize();
		this.#insertStmt.finalize();
		this.#updateStmt.finalize();
		this.#deleteStmt.finalize();
		this.#deleteIfMatchesStmt.finalize();
		this.#deleteByProviderStmt.finalize();
		this.#hardDeleteStmt.finalize();
		this.#getCacheStmt.finalize();
		this.#getCacheIncludingExpiredStmt.finalize();
		this.#upsertCacheStmt.finalize();
		this.#deleteExpiredCacheStmt.finalize();
		this.#getCredentialBlockStmt.finalize();
		this.#listCredentialBlocksByCredentialStmt.finalize();
		this.#upsertCredentialBlockStmt.finalize();
		this.#deleteCredentialBlocksStmt.finalize();
		this.#deleteCredentialBlockStmt.finalize();
		this.#deleteExpiredCredentialBlocksStmt.finalize();
		this.#insertUsageHistoryStmt.finalize();
		this.#lastUsageHistoryStmt.finalize();
		this.#listUsageHistoryStmt.finalize();
		this.#updateUsageHistoryStmt.finalize();
		this.#updateIfMatchesStmt.finalize();
		this.#updateIfMatchesWithLeaseStmt.finalize();
		this.#deleteIfMatchesWithLeaseStmt.finalize();
		this.#deleteCachePrefixStmt.finalize();
		this.#acquireCredentialRefreshLeaseStmt.finalize();
		this.#getCredentialRefreshLeaseStmt.finalize();
		this.#renewCredentialRefreshLeaseStmt.finalize();
		this.#releaseCredentialRefreshLeaseStmt.finalize();
		this.#db.close();
	}
}

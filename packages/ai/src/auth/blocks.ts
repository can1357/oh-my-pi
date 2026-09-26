import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, UsageReport } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import type { CredentialPool } from "./pool";
import { isSqliteCorruptionError, USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { AuthCredentialStore } from "./store";
import { isUsageLimitReached, usageReportMetadataValue, usageReportScopeAccountId } from "./usage-report";
import type { UsageCache, UsageRequestDescriptor } from "./usage-cache";
import type { AuthCredential, BlocksApi, StoredCredentialBlock } from "./types";

/** Default block when no provider reset time is known; used by selectors and rate limits. */
export const DEFAULT_BLOCK_MS = 60_000;

/** Composite key for round-robin tracking: "<provider>:oauth" or "<provider>:api_key". */
export function providerTypeKey(provider: string, type: AuthCredential["type"]): string {
	return `${provider}:${type}`;
}

/** Scoped backoff map key used by the credential block store. */
export function scopedBackoffKey(providerKey: string, blockScope: string | undefined): string {
	return blockScope ? `${providerKey}\0${blockScope}` : providerKey;
}

const MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX = "model-policy:";
const MODEL_ACCOUNT_POLICY_PROVIDERS: Readonly<Record<string, true>> = {
	"openai-codex": true,
	cursor: true,
};

/** Scope key for one model-specific account-policy block, shared by selectors and rate limits. */
export function modelAccountPolicyBlockScope(provider: string, modelId: string | undefined): string | undefined {
	if (!Object.hasOwn(MODEL_ACCOUNT_POLICY_PROVIDERS, provider) || typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bareModelId || bareModelId.includes("\0")) return undefined;
	return `${MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX}${bareModelId}`;
}

/** Scope keys that a request must check, including model-policy constraints. */
export function credentialBlockScopesForRequest(
	provider: string,
	strategy: CredentialRankingStrategy | undefined,
	rankingContext: CredentialRankingContext,
	blockScope: string | undefined,
): readonly string[] {
	const scopes = strategy?.blockScopes?.(rankingContext) ?? (blockScope ? [blockScope] : []);
	const modelPolicyScope = modelAccountPolicyBlockScope(provider, rankingContext.modelId);
	if (!modelPolicyScope || scopes.includes(modelPolicyScope)) return scopes;
	return [...scopes, modelPolicyScope];
}

/**
 * One live in-memory rate-limit block. `timed` is true when `until` came from
 * provider-stated timing (a parsed retry hint or a usage-report reset) rather
 * than a heuristic guess, tracking whichever deadline won the longest-wins
 * merge. `probeAfter` is the earliest time live usage reconciliation may clear it.
 */
type CredentialBackoff = { until: number; timed: boolean; probeAfter: number };

/** Latch for unrecoverably corrupt persisted block stores, shared with the credential pool. */
export class BlockStoreHealth {
	readonly #sourceLabel: string | undefined;
	#damaged = false;

	constructor(sourceLabel: string | undefined) {
		this.#sourceLabel = sourceLabel;
	}

	get damaged(): boolean {
		return this.#damaged;
	}

	handle(err: unknown): boolean {
		if (!isSqliteCorruptionError(err)) return false;
		this.#reportDamagedBlockStore(err);
		return true;
	}

	assertWritable(): void {
		if (!this.#damaged) return;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		throw new Error(`Persistent credential block store ${store} is unavailable after SQLite corruption`);
	}

	/**
	 * Latches {@link BlockStoreHealth.damaged} on the first
	 * unrecoverable persisted-block store error and surfaces it once at `error`
	 * level with the store location, so an operator can repair or replace it.
	 * Later reads/writes short-circuit silently — the in-memory backoff map keeps
	 * rate-limit blocks applying for the life of the process; only cross-process
	 * persistence is lost.
	 */
	#reportDamagedBlockStore(err: unknown): void {
		if (this.#damaged) return;
		this.#damaged = true;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		logger.error(
			"Persistent credential store is corrupt; cross-process rate-limit persistence is disabled for this process. In-memory backoff still applies. Repair the store with `sqlite3 <path> '.recover'` or delete it to recreate on next login.",
			{ err, store },
		);
	}
}

/** Dependencies for persisted rate-limit blocks and usage-report healing. */
export interface CredentialBlocksDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	health: BlockStoreHealth;
	usageCache: UsageCache;
	strategies: RankingStrategyResolver;
}

/** Temporary rate-limit blocks: id-keyed in memory, mirrored to the store, healed by live usage. */
export class CredentialBlocks implements BlocksApi {
	readonly #deps: CredentialBlocksDeps;
	/** Backoff key (provider:type, optionally scoped) -> credential row id -> live in-memory block. */
	#credentialBackoff: Map<string, Map<number, CredentialBackoff>> = new Map();

	constructor(deps: CredentialBlocksDeps) {
		this.#deps = deps;
		try {
			this.#deps.store.cleanExpiredCredentialBlocks?.(Date.now());
		} catch (err) {
			// Best-effort, but init-time corruption must latch the block store
			// immediately so the first evaluation doesn't re-query a broken DB.
			this.#deps.health.handle(err);
		}
	}

	/** Returns in-memory block expiry timestamp for a credential/key pair, cleaning up expired entries. */
	#getCredentialBlockedUntilForKey(backoffKey: string, credentialId: number, nowMs: number): number | undefined {
		const block = this.#credentialBackoff.get(backoffKey)?.get(credentialId);
		if (!block) return undefined;
		if (block.until <= nowMs) {
			this.#deleteCredentialBackoff(backoffKey, credentialId);
			return undefined;
		}
		return block.until;
	}

	#deleteCredentialBackoff(backoffKey: string, credentialId: number): void {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		backoffMap?.delete(credentialId);
		if (backoffMap?.size === 0) this.#credentialBackoff.delete(backoffKey);
	}

	#readPersistedCredentialBlock(
		credentialId: number,
		providerKey: string,
		blockScope: string | undefined,
	): number | undefined {
		if (this.#deps.health.damaged) return undefined;
		const getCredentialBlock = this.#deps.store.getCredentialBlock?.bind(this.#deps.store);
		if (!getCredentialBlock) return undefined;
		try {
			return getCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			if (this.#deps.health.handle(err)) return undefined;
			logger.debug("Failed to read credential block from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return undefined;
		}
	}

	#readPersistedCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number {
		if (this.#deps.health.damaged) return 0;
		const getCredentialBlockReconcileAfter = this.#deps.store.getCredentialBlockReconcileAfter?.bind(
			this.#deps.store,
		);
		if (!getCredentialBlockReconcileAfter) return 0;
		try {
			return getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope) ?? 0;
		} catch (err) {
			if (this.#deps.health.handle(err)) return 0;
			// Advisory read: transient failures (e.g. SQLITE_BUSY) fall back to
			// the in-memory probe window, mirroring #readPersistedCredentialBlock.
			logger.debug("Failed to read credential block reconcile-after time from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return 0;
		}
	}

	/** Returns block expiry timestamp for a credential, checking unscoped and scoped blocks. */
	blockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
	): number | undefined {
		const nowMs = Date.now();
		// A request honours its own scope plus any legacy catch-all scope, so a
		// block written before backoff was scoped still applies to everything.
		const scopes = (
			typeof blockScopeOrScopes === "string" ? [blockScopeOrScopes] : (blockScopeOrScopes ?? [])
		).filter(scope => scope.length > 0);
		const credentialId = this.#deps.pool.entries(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return undefined;
		let blockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialId, nowMs);
		for (const blockScope of scopes) {
			const scopedBlockedUntil = this.#getCredentialBlockedUntilForKey(
				scopedBackoffKey(providerKey, blockScope),
				credentialId,
				nowMs,
			);
			if (scopedBlockedUntil !== undefined && (blockedUntil === undefined || scopedBlockedUntil > blockedUntil)) {
				blockedUntil = scopedBlockedUntil;
			}
		}

		const persistedGlobalBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, "");
		if (
			persistedGlobalBlockedUntil !== undefined &&
			(blockedUntil === undefined || persistedGlobalBlockedUntil > blockedUntil)
		) {
			blockedUntil = persistedGlobalBlockedUntil;
		}
		for (const blockScope of scopes) {
			const persistedScopedBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope);
			if (
				persistedScopedBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedScopedBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedScopedBlockedUntil;
			}
		}
		return blockedUntil;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	isBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | readonly string[] | undefined = undefined,
	): boolean {
		return this.blockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	/**
	 * Whether the in-memory block currently sitting at exactly `deadline` for
	 * this credential was written with provider-stated timing. Mirrors the
	 * scope enumeration of {@link CredentialBlocks.blockedUntil}.
	 * A deadline with no matching in-memory entry came from the persisted
	 * store, which carries no provenance — a stale persisted heuristic guess
	 * (pre-restart hintless response) must not outrank a fresh complete usage
	 * report, so persisted-only deadlines count as untimed. Persisted
	 * deadlines longer than this call's own request still win through the
	 * merged `blockedUntilMs` comparison, which needs no provenance.
	 */
	isTimed(
		providerKey: string,
		blockScopeOrScopes: string | readonly string[] | undefined,
		credentialId: number,
		deadline: number,
	): boolean {
		const scopes = (
			typeof blockScopeOrScopes === "string" ? [blockScopeOrScopes] : (blockScopeOrScopes ?? [])
		).filter(scope => scope.length > 0);
		for (const key of [providerKey, ...scopes.map(scope => scopedBackoffKey(providerKey, scope))]) {
			const block = this.#credentialBackoff.get(key)?.get(credentialId);
			if (block?.until === deadline && block.timed) return true;
		}
		return false;
	}

	/**
	 * Marks a credential as blocked until the specified time. `providerTimed`
	 * records whether the requested deadline comes from provider-stated
	 * timing (a parsed retry hint or a usage-report reset) rather than a
	 * heuristic/default guess; the stored block keeps the provenance of
	 * whichever deadline wins the longest-wins merge.
	 */
	mark(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
		providerTimed = false,
	): void {
		const credentialId = this.#deps.pool.entries(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return;
		const backoffKey = scopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, CredentialBackoff>();
		const existing = backoffMap.get(credentialId);
		const existingUntil = existing?.until ?? 0;
		const nextBlockedUntil = Math.max(existingUntil, blockedUntilMs);
		const existingTimed = existing?.timed ?? false;
		const nextTimed =
			blockedUntilMs > existingUntil
				? providerTimed
				: blockedUntilMs === existingUntil
					? existingTimed || providerTimed
					: existingTimed;
		backoffMap.set(credentialId, {
			until: nextBlockedUntil,
			timed: nextTimed,
			probeAfter: Math.min(nextBlockedUntil, Date.now() + USAGE_REPORT_TTL_MS),
		});
		this.#credentialBackoff.set(backoffKey, backoffMap);
		this.#deps.usageCache.invalidate(provider);

		const upsertCredentialBlock = this.#deps.store.upsertCredentialBlock?.bind(this.#deps.store);
		if (!upsertCredentialBlock || this.#deps.health.damaged) return;
		try {
			upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: blockScope ?? "",
				blockedUntilMs: nextBlockedUntil,
			});
		} catch (err) {
			if (this.#deps.health.handle(err)) return;
			logger.debug("Failed to persist credential block", {
				err,
				credentialId,
				provider,
				providerKey,
				blockScope,
				blockedUntilMs: nextBlockedUntil,
			});
		}
	}

	/**
	 * Lift any temporary backoff blocks on one credential (across the bare
	 * `provider:oauth` key and its scoped `\0`-suffixed derivatives). Called
	 * after a saved reset is redeemed so the just-reset account is immediately
	 * selectable again instead of being skipped/under-ranked by a stale block
	 * that `markUsageLimitReached` set for the now-obsolete reset time.
	 */
	clearAll(provider: string, credentialId: number): void {
		try {
			this.deleteAll(credentialId);
		} catch (err) {
			logger.debug("Failed to clear persisted credential blocks", {
				err,
				provider,
				credentialId,
			});
		}

		const providerKey = providerTypeKey(provider, "oauth");
		const scopedPrefix = `${providerKey}\0`;
		for (const key of this.#credentialBackoff.keys()) {
			if (key === providerKey || key.startsWith(scopedPrefix)) this.#deleteCredentialBackoff(key, credentialId);
		}
	}

	/**
	 * Clear one backoff scope. The in-memory backoff is per scope so it is
	 * dropped directly; the persisted store deletes a credential's blocks as a
	 * unit, so it is only purged once no other scope still holds a live block.
	 * Leaving a persisted row behind is safe: the scope it belongs to is
	 * unblocked in memory, and the row heals on the pass where its own meter
	 * recovers.
	 */
	clearScope(provider: string, credentialId: number, providerKey: string, blockScope: string | undefined): void {
		this.#deleteCredentialBackoff(scopedBackoffKey(providerKey, blockScope), credentialId);
		try {
			this.delete(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			logger.debug("Failed to clear persisted credential block", {
				err,
				provider,
				credentialId,
				blockScope,
			});
		}
	}

	/** Providers whose stale usage-limit blocks a healthy live report may clear. */
	supportsHealing(provider: Provider): boolean {
		return this.#deps.strategies(provider)?.healableBlockScopes !== undefined;
	}

	/**
	 * Whether a fresh report could lift what currently blocks this credential.
	 *
	 * A strategy vouches only for the scopes it names, so unless it also heals
	 * the unscoped block ({@link CredentialRankingStrategy.healsUnscopedBlock}),
	 * a live unscoped block — a usage limit, a refresh failure — keeps the
	 * credential unusable whatever the report says about a scope. A probe then
	 * cannot change the outcome and must not be spent; the scoped block heals on
	 * a later pass, once the block that actually holds the credential has lifted.
	 */
	canHeal(
		provider: Provider,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined,
	): boolean {
		if (!this.supportsHealing(provider)) return false;
		if (
			!this.#deps.strategies(provider)?.healsUnscopedBlock &&
			this.blockedUntil(provider, providerKey, credentialIndex) !== undefined
		) {
			return false;
		}
		return this.blockedUntil(provider, providerKey, credentialIndex, blockScopeOrScopes) !== undefined;
	}

	/**
	 * Self-heal stale usage-limit blocks: when a fresh live usage report says a
	 * scope is below every limit gating it, drop its persisted and in-memory
	 * blocks so credential selection re-includes the recovered account before
	 * the block expires by clock. Providers declare their scopes and any meter
	 * verdicts via {@link CredentialRankingStrategy.healableBlockScopes}.
	 */
	reconcile(provider: Provider, credentialId: number, report: UsageReport): void {
		const providerKey = providerTypeKey(provider, "oauth");
		if (!this.#deps.pool.entries(provider).some(entry => entry.id === credentialId)) return;
		const strategy = this.#deps.strategies(provider);
		// Only a live report proves recovery. A broker can serve its retained
		// last-good report for hours after `/usage` starts failing, and those
		// healthy limits describe the account before the 429 that blocked it.
		if (!Number.isFinite(report.fetchedAt) || Date.now() - report.fetchedAt > USAGE_REPORT_TTL_MS) return;
		for (const { blockScope, limits, healthy } of strategy?.healableBlockScopes?.(report) ?? []) {
			if (healthy === false || isUsageLimitReached(limits) || (healthy === undefined && limits.length === 0))
				continue;
			this.#clearHealedBlockScope(provider, providerKey, credentialId, blockScope);
		}
	}

	/**
	 * Drop one scope's block after a healthy report, unless the block is too
	 * fresh: `/usage` can lag the request path that just returned 429, so local
	 * and broker-sourced blocks get one usage-cache window before a healthy
	 * report may clear them.
	 */
	#clearHealedBlockScope(
		provider: Provider,
		providerKey: string,
		credentialId: number,
		blockScope: string | undefined,
	): void {
		const nowMs = Date.now();
		const scopedKey = scopedBackoffKey(providerKey, blockScope);
		// Only the deadline stored under this scope: `blockedUntil` also merges
		// the unscoped block, which a scoped heal neither owns nor clears.
		const blockedUntilMs = Math.max(
			this.#getCredentialBlockedUntilForKey(scopedKey, credentialId, nowMs) ?? 0,
			this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope) ?? 0,
		);
		if (blockedUntilMs === 0) return;
		const globalProbeAfterMs = this.#credentialBackoff.get(providerKey)?.get(credentialId)?.probeAfter ?? 0;
		const scopedProbeAfterMs = this.#credentialBackoff.get(scopedKey)?.get(credentialId)?.probeAfter ?? 0;
		const storeGlobalProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(credentialId, providerKey, "");
		const storeScopedProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(
			credentialId,
			providerKey,
			blockScope ?? "",
		);
		if (Math.max(globalProbeAfterMs, scopedProbeAfterMs, storeGlobalProbeAfterMs, storeScopedProbeAfterMs) > nowMs) {
			return;
		}
		this.clearScope(provider, credentialId, providerKey, blockScope);
		logger.info("Cleared stale usage-limit block after healthy live usage report", {
			credentialId,
			provider,
			blockScope,
			clearedBlockedUntilMs: blockedUntilMs,
		});
	}

	reconcileRequest(request: UsageRequestDescriptor, report: UsageReport): void {
		if (!this.supportsHealing(request.provider)) return;
		const credentialId = this.#deps.pool.findIdForUsageCredential(request.provider, request.credential);
		if (credentialId === undefined) return;
		this.reconcile(request.provider, credentialId, report);
	}

	#findStoredCredentialIdsForUsageReport(report: UsageReport): number[] {
		if (!this.supportsHealing(report.provider)) return [];
		const email = usageReportMetadataValue(report, "email")?.toLowerCase();
		const accountId = (
			usageReportMetadataValue(report, "accountId") ?? usageReportScopeAccountId(report)
		)?.toLowerCase();
		if (!email && !accountId) return [];
		const matches: number[] = [];
		for (const entry of this.#deps.pool.entries(report.provider)) {
			const credential = entry.credential;
			if (credential.type !== "oauth") continue;
			const credentialEmail = credential.email?.trim().toLowerCase();
			const credentialAccountId = credential.accountId?.trim().toLowerCase();
			// Every identity dimension present on BOTH sides must agree — the
			// account id is shared workspace-wide and one email can span
			// workspaces, so a single-dimension match can cross-link siblings.
			const emailComparable = Boolean(email && credentialEmail);
			const accountComparable = Boolean(accountId && credentialAccountId);
			if (!emailComparable && !accountComparable) continue;
			if (emailComparable && credentialEmail !== email) continue;
			if (accountComparable && credentialAccountId !== accountId) continue;
			matches.push(entry.id);
		}
		return matches;
	}

	reconcileReports(reports: UsageReport[]): void {
		const reconciled = new Set<number>();
		for (const report of reports) {
			for (const credentialId of this.#findStoredCredentialIdsForUsageReport(report)) {
				if (reconciled.has(credentialId)) continue;
				reconciled.add(credentialId);
				this.reconcile(report.provider, credentialId, report);
			}
		}
	}

	/**
	 * Broker-server seam: list non-expired persisted blocks for snapshot entries.
	 */
	list(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (this.#deps.health.damaged) return [];
		const listCredentialBlocks = this.#deps.store.listCredentialBlocks?.bind(this.#deps.store);
		if (!listCredentialBlocks) return [];
		try {
			return listCredentialBlocks(credentialIds);
		} catch (err) {
			if (this.#deps.health.handle(err)) return [];
			throw err;
		}
	}

	/**
	 * Broker-server seam: persist one credential block and notify snapshot waiters.
	 */
	upsert(block: StoredCredentialBlock): void {
		this.#deps.health.assertWritable();
		const upsertCredentialBlock = this.#deps.store.upsertCredentialBlock?.bind(this.#deps.store);
		if (!upsertCredentialBlock) return;
		try {
			upsertCredentialBlock(block);
		} catch (err) {
			if (this.#deps.health.handle(err)) this.#deps.health.assertWritable();
			throw err;
		}
		this.#deps.usageCache.invalidateProviderKey(block.providerKey);
		this.#deps.pool.bump("credential-block");
	}

	/**
	 * Broker-server seam: clear all persisted blocks for one credential and notify snapshot waiters.
	 */
	delete(credentialId: number, providerKey: string, blockScope: string): void {
		this.#deps.health.assertWritable();
		const deleteCredentialBlock = this.#deps.store.deleteCredentialBlock?.bind(this.#deps.store);
		if (!deleteCredentialBlock) return;
		try {
			deleteCredentialBlock(credentialId, providerKey, blockScope);
		} catch (err) {
			if (this.#deps.health.handle(err)) this.#deps.health.assertWritable();
			throw err;
		}
		this.#deps.usageCache.invalidateProviderKey(providerKey);
		this.#deps.pool.bump("credential-block");
	}

	deleteAll(credentialId: number): void {
		this.#deps.health.assertWritable();
		const deleteCredentialBlocks = this.#deps.store.deleteCredentialBlocks?.bind(this.#deps.store);
		if (!deleteCredentialBlocks) return;
		try {
			deleteCredentialBlocks(credentialId);
		} catch (err) {
			if (this.#deps.health.handle(err)) this.#deps.health.assertWritable();
			throw err;
		}
		this.#deps.pool.bump("credential-block");
	}
}

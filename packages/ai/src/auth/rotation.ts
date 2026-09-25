import * as AIError from "../error";
import { isUsageLimitOutcome } from "../error/rate-limit";
import { extractProviderRetryHint } from "../utils/retry-after";
import type { CredentialRankingContext, CredentialRankingStrategy } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import { raceSignal } from "./abort";
import {
	DEFAULT_BLOCK_MS,
	credentialBlockScopesForRequest,
	modelAccountPolicyBlockScope,
	providerTypeKey,
} from "./blocks";
import type { CredentialBlocks } from "./blocks";
import type { KeyOverrides } from "./cascade";
import type { SessionAffinity } from "./affinity";
import type { CredentialPool } from "./pool";
import type { AuthCredentialStore } from "./store";
import type {
	AuthCredential,
	InvalidateCredentialMatchingOptions,
	LimitsApi,
	MarkUsageLimitOptions,
	RotateCredentialOptions,
	UsageLimitMarkResult,
} from "./types";
import type { UsageService } from "./usage";
import {
	isUsageLimitExhausted,
	isUsageLimitReached,
	scopedUsageLimits,
	usageResetAtMs,
	windowResetAt,
} from "./usage-report";

/** Routing scope and strategy for one failed credential. */
export type CredentialBlockRouting = {
	providerKey: string;
	strategy: CredentialRankingStrategy | undefined;
	rankingContext: CredentialRankingContext;
	blockScope: string | undefined;
	siblingBlockScopes: readonly string[];
};

/** Dependencies for rate-limit marking and credential rotation. */
export interface RateLimitsDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	overrides: KeyOverrides;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	strategies: RankingStrategyResolver;
}

/** Usage-limit marking, credential rotation after failures, and bearer-matched invalidation. */
export class RateLimits implements LimitsApi {
	#deps: RateLimitsDeps;

	constructor(deps: RateLimitsDeps) {
		this.#deps = deps;
	}

	async #resolveCredentialTarget(
		provider: string,
		sessionId: string | undefined,
		options?: { credentialId?: number; apiKey?: string; allowStaleOAuthBearer?: boolean },
	): Promise<{ type: AuthCredential["type"]; index: number; explicit: boolean } | undefined> {
		const explicit = options?.credentialId !== undefined || options?.apiKey !== undefined;
		if (explicit) {
			const latestRows = this.#deps.store.listAuthCredentials(provider);
			this.#deps.pool.replace(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}
		if (options?.credentialId !== undefined) {
			const stored = this.#deps.pool.entries(provider);
			const index = stored.findIndex(entry => entry.id === options.credentialId);
			const entry = index === -1 ? undefined : stored[index];
			if (entry) return { type: entry.credential.type, index, explicit: true };
		}
		if (options?.apiKey !== undefined) {
			const stored = this.#deps.pool.entries(provider);
			for (let index = 0; index < stored.length; index++) {
				const entry = stored[index];
				if (entry && (await this.#credentialMatchesApiKey(entry.credential, options.apiKey))) {
					return { type: entry.credential.type, index, explicit: true };
				}
			}
			// Quota and account policy survive token refresh; hard auth failures do not.
			if (options.allowStaleOAuthBearer && options.credentialId === undefined) {
				const credentialId = this.#deps.pool.idForBearer(provider, options.apiKey);
				const index =
					credentialId === undefined
						? -1
						: stored.findIndex(entry => entry.id === credentialId && entry.credential.type === "oauth");
				if (index >= 0) return { type: "oauth", index, explicit: true };
			}
		}
		if (explicit) return undefined;
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		return sessionCredential ? { ...sessionCredential, explicit: false } : undefined;
	}
	#credentialBlockRouting(
		provider: string,
		credentialType: AuthCredential["type"],
		modelId: string | undefined,
		blockScopeOverride?: string,
	): CredentialBlockRouting {
		const providerKey = providerTypeKey(provider, credentialType);
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = { modelId };
		const defaultBlockScope = strategy?.blockScope?.(rankingContext);
		const blockScope = blockScopeOverride ?? defaultBlockScope;
		const requestBlockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, defaultBlockScope);
		const siblingBlockScopes =
			blockScopeOverride && !requestBlockScopes.includes(blockScopeOverride)
				? [...requestBlockScopes, blockScopeOverride]
				: requestBlockScopes;
		return {
			providerKey,
			strategy,
			rankingContext,
			blockScope,
			siblingBlockScopes,
		};
	}
	#blockCredentialForRotation(
		provider: string,
		credentialType: AuthCredential["type"],
		targetIndex: number,
		blockedUntil: number,
		routing: CredentialBlockRouting,
		providerTimed: boolean,
	): UsageLimitMarkResult {
		// Snapshot the live block deadline BEFORE this call's mark: the merged
		// value below masks a pre-existing block shorter than this call's own
		// request (longest-wins), and recovery that replaces this call's
		// heuristic fallback with an authoritative report window still needs
		// the prior response's provider-stated deadline.
		const priorBlockedUntilMs =
			targetIndex >= 0
				? this.#deps.blocks.blockedUntil(provider, routing.providerKey, targetIndex, routing.blockScope)
				: undefined;
		const targetId = targetIndex >= 0 ? this.#deps.pool.entries(provider)[targetIndex]?.id : undefined;
		const priorBlockedUntilTimed =
			targetId !== undefined && priorBlockedUntilMs !== undefined
				? this.#deps.blocks.isTimed(routing.providerKey, routing.blockScope, targetId, priorBlockedUntilMs)
				: false;
		if (targetIndex >= 0) {
			this.#deps.blocks.mark(
				provider,
				routing.providerKey,
				targetIndex,
				blockedUntil,
				routing.blockScope,
				providerTimed,
			);
		}

		// Report the merged deadline the block map actually stores, not this
		// call's input: a sibling session may have established a longer block
		// for the same credential (out-of-order usage-limit responses), and
		// #markCredentialBlocked keeps the longest. Waiting on the shorter
		// value would retry before the credential is actually usable.
		const mergedBlockedUntil =
			targetIndex >= 0
				? (this.#deps.blocks.blockedUntil(provider, routing.providerKey, targetIndex, routing.blockScope) ??
					blockedUntil)
				: blockedUntil;

		const remainingCredentials = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === credentialType && entry.index !== targetIndex,
			);

		let retryAtMs: number | undefined;
		for (const candidate of remainingCredentials) {
			// Sibling availability must use the same scope set selection reads, or
			// this reports a sibling as free that selection will then refuse.
			const candidateBlockedUntil = this.#deps.blocks.blockedUntil(
				provider,
				routing.providerKey,
				candidate.index,
				routing.siblingBlockScopes,
			);
			if (candidateBlockedUntil === undefined)
				return {
					switched: true,
					blockedUntilMs: mergedBlockedUntil,
					priorBlockedUntilMs,
					priorBlockedUntilTimed,
				};
			if (retryAtMs === undefined || candidateBlockedUntil < retryAtMs) retryAtMs = candidateBlockedUntil;
		}
		return {
			switched: false,
			retryAtMs,
			blockedUntilMs: mergedBlockedUntil,
			priorBlockedUntilMs,
			priorBlockedUntilTimed,
		};
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns whether a sibling credential is available now; when none is, also
	 * reports the earliest time a blocked sibling becomes available again so
	 * callers can wait for the sibling instead of the provider's full window.
	 */
	async markReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageLimitOptions,
	): Promise<UsageLimitMarkResult> {
		await this.#deps.pool.adoptExternalChanges();
		const sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
			allowStaleOAuthBearer: true,
		});
		if (!sessionCredential) return { switched: false };
		const target = this.#deps.pool.entries(provider)[sessionCredential.index];
		if (!target || target.credential.type !== sessionCredential.type) return { switched: false };
		const credentialType = sessionCredential.type;
		const targetCredentialId = target.id;

		const routing = this.#credentialBlockRouting(provider, credentialType, options?.modelId);
		const now = Date.now();
		const requestedBlockedUntilMs = now + (options?.retryAfterMs ?? DEFAULT_BLOCK_MS);
		let blockedUntil = requestedBlockedUntilMs;
		// Heuristic/default fallbacks are guesses; provider-stated hints and
		// report-derived extensions are timed.
		let providerTimed = options?.providerTimed === true;

		// Epoch ms of the usage-report-derived reset. Authoritative only when
		// EVERY exhausted window carries a future reset: a permanent cap
		// alongside a timed window must not authorize a wait that can never
		// clear it, and a bare heuristic must not sleep alone. Set
		// independently of whether the report extends the hint so a shorter
		// authoritative window still counts as provider timing.
		let reportResetAtMs: number | undefined;
		if (target && routing.strategy) {
			const report = await raceSignal(
				this.#deps.usage.report(provider, target.credential, options),
				options?.signal,
				"usage fetch aborted",
			);
			if (report) {
				const scopedLimits = scopedUsageLimits(routing.strategy, report, routing.rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
						providerTimed = true;
					}
					const nowMs = Date.now();
					const exhaustedLimits = scopedLimits.filter(limit => isUsageLimitExhausted(limit));
					const futureResets = exhaustedLimits
						.map(limit => windowResetAt(limit.window))
						.filter((reset): reset is number => reset !== undefined && reset > nowMs);
					if (exhaustedLimits.length > 0 && futureResets.length === exhaustedLimits.length) {
						reportResetAtMs = Math.max(...futureResets);
					}
				}
			}
		}
		options?.signal?.throwIfAborted();

		// Usage lookup may refresh, disable, or remove a row. Re-resolve its
		// durable id before applying positional in-memory and persisted blocks.
		const targetIndex = this.#deps.pool
			.entries(provider)
			.findIndex(entry => entry.id === targetCredentialId && entry.credential.type === credentialType);
		const rotation = this.#blockCredentialForRotation(
			provider,
			credentialType,
			targetIndex,
			blockedUntil,
			routing,
			providerTimed,
		);
		return {
			...rotation,
			requestedBlockedUntilMs,
			...(reportResetAtMs === undefined ? {} : { reportResetAtMs }),
		};
	}
	#extractStructuredApiKeyToken(apiKey: string): string | undefined {
		if (!apiKey.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(apiKey) as { token?: unknown };
			return typeof parsed.token === "string" ? parsed.token : undefined;
		} catch {
			return undefined;
		}
	}

	async #credentialMatchesApiKey(credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (await this.#deps.overrides.resolve(credential.key)) === apiKey;
		}
		if (credential.access === apiKey) return true;
		return this.#extractStructuredApiKeyToken(apiKey) === credential.access;
	}
	async invalidateMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean> {
		const signal = options?.signal;
		const sessionId = options?.sessionId;
		const stored = this.#deps.pool.entries(provider);
		let matched: { id: number; type: AuthCredential["type"]; index: number } | undefined;
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && (await this.#credentialMatchesApiKey(entry.credential, apiKey))) {
				matched = { id: entry.id, type: entry.credential.type, index };
				break;
			}
		}

		if (!matched) {
			await this.#deps.pool.reload();
			return false;
		}

		this.#deps.affinity.clear(provider, sessionId);
		this.#deps.blocks.mark(
			provider,
			providerTypeKey(provider, matched.type),
			matched.index,
			Date.now() + DEFAULT_BLOCK_MS,
		);

		const markSuspect = this.#deps.store.markCredentialSuspect?.bind(this.#deps.store);
		if (markSuspect) {
			await markSuspect(matched.id, { signal });
		} else {
			await this.#deps.pool.reload();
		}

		const latestRows = this.#deps.store.listAuthCredentials(provider);
		this.#deps.pool.replace(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return true;
	}
	/**
	 * Rotate away from the credential that failed after a retryable auth error —
	 * step (c) of the auth-retry policy. Prefer the failed stored row id supplied
	 * in `options.credentialId`, then the failed bearer supplied in
	 * `options.apiKey`, so overlapping requests cannot redirect rotation through
	 * stale session stickiness. Fall back to the session-sticky credential only
	 * when neither explicit target is available. For hard-auth errors, an explicit
	 * target that no longer matches storage returns `false` without mutation.
	 * Delayed usage-limit and account-policy errors may instead recover the durable
	 * OAuth row from the bearer fingerprint recorded when the request resolved.
	 *
	 * - usage-limit / account-rate-limit error → {@link RateLimits.markReached}
	 *   (temporary block via its own backoff — default plus server usage-report
	 *   reset; sticky left intact so the next resolve re-ranks around the block).
	 * - exact model-entitlement denial (Codex ChatGPT account or Cursor plan) →
	 *   temporarily block only that requested model, then rotate.
	 * - other account-scoped policy denial → temporarily block that account
	 *   without marking its credential suspect, then rotate through siblings.
	 * - otherwise (hard 401 / auth failure) → mark the credential suspect (or
	 *   reload when no broker hook is wired) and block it, then drop matching
	 *   sticky state.
	 *
	 * Returns whether another usable credential of the same type remains.
	 */
	async rotate(provider: string, sessionId: string | undefined, options?: RotateCredentialOptions): Promise<boolean> {
		await this.#deps.pool.adoptExternalChanges();
		const error = options?.error;
		const status = AIError.status(error);
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		const exactCursorModelPolicy = AIError.isCursorPlanAccountPolicyError(error, provider);
		const accountPolicy = exactCursorModelPolicy || AIError.isAccountPolicyError(error);
		if (!accountPolicy && (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message))) {
			// Thread the provider-specified reset window (e.g. Devin "Your limit
			// will reset in 13 minutes") into the block duration so the credential
			// is not reselected and hammered while the cap remains active.
			const retryAfterMs = extractProviderRetryHint(provider, message);
			return (
				await this.markReached(provider, sessionId, {
					retryAfterMs,
					providerTimed: retryAfterMs !== undefined,
					modelId: options?.modelId,
					apiKey: options?.apiKey,
					credentialId: options?.credentialId,
					signal: options?.signal,
				})
			).switched;
		}

		const deniedModel = AIError.codexChatGPTAccountPolicyModel(error);
		const exactCodexModelPolicy =
			deniedModel !== undefined && AIError.isCodexChatGPTAccountPolicyError(error, provider, options?.modelId);
		const exactModelPolicy = exactCodexModelPolicy || exactCursorModelPolicy;
		const sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
			allowStaleOAuthBearer: accountPolicy || exactModelPolicy,
		});
		if (!sessionCredential) return false;
		// The exact sentence is provider-controlled input. A non-Codex provider,
		// absent request model, or mismatched model must not turn it into either a
		// global block or a hard-auth invalidation.
		if (deniedModel !== undefined && !exactCodexModelPolicy) return false;
		if (exactModelPolicy || accountPolicy) {
			const modelPolicyScope = exactModelPolicy
				? modelAccountPolicyBlockScope(provider, options?.modelId)
				: undefined;
			if (exactModelPolicy && modelPolicyScope === undefined) return false;
			const routing = this.#credentialBlockRouting(
				provider,
				sessionCredential.type,
				options?.modelId,
				modelPolicyScope,
			);
			// Account-wide denials must not inherit a quota scope that healthy usage can heal.
			routing.blockScope = modelPolicyScope;
			const sticky = this.#deps.affinity.get(provider, sessionId);
			if (
				!sessionCredential.explicit ||
				(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
			) {
				this.#deps.affinity.clear(provider, sessionId);
			}
			return this.#blockCredentialForRotation(
				provider,
				sessionCredential.type,
				sessionCredential.index,
				Date.now() + DEFAULT_BLOCK_MS,
				routing,
				false,
			).switched;
		}

		const providerKey = providerTypeKey(provider, sessionCredential.type);
		// Snapshot sibling availability before mutating so a soft-deleting
		// suspect hook can't reindex the answer out from under us.
		const hasSibling = this.#deps.pool
			.credentials(provider)
			.some(
				(credential, index) =>
					credential.type === sessionCredential.type &&
					index !== sessionCredential.index &&
					!this.#deps.blocks.isBlocked(provider, providerKey, index),
			);
		const target = this.#deps.pool.entries(provider)[sessionCredential.index];
		const sticky = this.#deps.affinity.get(provider, sessionId);
		if (
			!sessionCredential.explicit ||
			(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
		) {
			this.#deps.affinity.clear(provider, sessionId);
		}
		this.#deps.blocks.mark(provider, providerKey, sessionCredential.index, Date.now() + DEFAULT_BLOCK_MS);

		if (target && AIError.isInvalidatedOAuthTokenError(error)) {
			const disabledCause = message ?? "upstream reported invalidated OAuth token";
			const deleted = await this.#deps.pool.disable(target.id, disabledCause);
			if (deleted) {
				const latestRows = this.#deps.store.listAuthCredentials(provider);
				this.#deps.pool.replace(
					provider,
					latestRows.map(row => ({ id: row.id, credential: row.credential })),
				);
			}
			return deleted && hasSibling;
		}

		if (target) {
			const markSuspect = this.#deps.store.markCredentialSuspect?.bind(this.#deps.store);
			if (markSuspect) {
				await markSuspect(target.id, { signal: options?.signal });
			} else {
				await this.#deps.pool.reload();
			}
			const latestRows = this.#deps.store.listAuthCredentials(provider);
			this.#deps.pool.replace(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}

		return hasSibling;
	}
}

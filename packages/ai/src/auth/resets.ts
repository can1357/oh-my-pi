import { logger } from "@oh-my-pi/pi-utils";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { UsageReport } from "../usage";
import { claudeResetClearedBlockScopes, consumeClaudeResetCredit, listClaudeResetCredits } from "../usage/claude-reset";
import { consumeCodexResetCredit, listCodexResetCredits, pickSoonestExpiringCredit } from "../usage/openai-codex-reset";
import type { CredentialBlocks } from "./blocks";
import { providerTypeKey } from "./blocks";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import { isUsageLimitReached } from "./usage-report";
import type { OAuthAccounts } from "./oauth";
import type { CredentialPool } from "./pool";
import type { AuthCredentialStore } from "./store";
import type {
	ListResetCreditsOptions,
	OAuthAccess,
	OAuthAccountSummary,
	RedeemResetCreditOptions,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetsApi,
} from "./types";
import type { UsageService } from "./usage";
import type { UsageCache } from "./usage-cache";

/** Dependencies for listing and redeeming stored-account reset credits. */
export interface ResetCreditsDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	oauth: OAuthAccounts;
	affinity: SessionAffinity;
	usage: UsageService;
	usageCache: UsageCache;
	blocks: CredentialBlocks;
}

/** Saved rate-limit resets (Codex / Claude): list offers and redeem one per account. */
export class ResetCredits implements ResetsApi {
	#deps: ResetCreditsDeps;
	/** Manual and automatic attempts on one stored account share a mutation. */
	#resetInFlight = new Map<string, { creditId?: string; promise: Promise<ResetCreditRedeemOutcome> }>();
	#listInFlight = new Map<string, Promise<ResetCreditAccountStatus[]>>();
	/** Ambiguous Claude claims retain their idempotency key until reconciled. */
	#pendingClaudeResets = new Map<
		string,
		{ creditId: string; requestId: string; program?: string; remainingCount?: number }
	>();

	constructor(deps: ResetCreditsDeps) {
		this.#deps = deps;
	}

	/** List live saved-reset balances and eligibility for one provider's stored OAuth accounts. */
	async list(options?: ListResetCreditsOptions): Promise<ResetCreditAccountStatus[]> {
		const provider = options?.provider ?? "openai-codex";
		if (provider !== "openai-codex" && provider !== "anthropic") return [];
		const baseUrl = options?.baseUrlResolver?.(provider);
		const sessionId = options?.sessionId;
		const restricted = this.#deps.affinity.isRestricted(provider, sessionId);
		let accounts = this.#deps.oauth.accounts(provider, sessionId);
		if (restricted && sessionId !== undefined) {
			accounts = accounts.filter(account => this.#deps.affinity.permits(provider, sessionId, account.credentialId));
		}
		if (provider !== "anthropic") return this.#listAccounts(provider, baseUrl, accounts, options);
		options?.signal?.throwIfAborted();
		// Discovery probes the active account first. Restricted callers must not
		// share discovery with other sessions, whose permission may change independently.
		const activeId = accounts.find(account => account.active)?.credentialId;
		const key = JSON.stringify([
			provider,
			baseUrl,
			activeId,
			restricted ? sessionId : undefined,
			accounts.map(account => account.credentialId),
		]);
		let pending = this.#listInFlight.get(key);
		if (!pending) {
			pending = this.#listAccounts(provider, baseUrl, accounts, { ...options, signal: undefined }).finally(() =>
				this.#listInFlight.delete(key),
			);
			this.#listInFlight.set(key, pending);
		}
		const statuses = await raceSignal(pending, options?.signal, "Reset discovery aborted");
		if (sessionId === undefined || !this.#deps.affinity.isRestricted(provider, sessionId)) return statuses;
		return statuses.filter(status => this.#deps.affinity.permits(provider, sessionId, status.credentialId));
	}

	async #listAccounts(
		provider: string,
		baseUrl: string | undefined,
		accounts: OAuthAccountSummary[],
		options?: ListResetCreditsOptions,
	): Promise<ResetCreditAccountStatus[]> {
		const sessionId = options?.sessionId;
		const permits = (credentialId: number) =>
			sessionId === undefined || this.#deps.affinity.permits(provider, sessionId, credentialId);
		const loadAccount = async (account: OAuthAccountSummary): Promise<ResetCreditAccountStatus | undefined> => {
			if (!permits(account.credentialId)) return undefined;
			const base = { ...account, provider };
			const access = await this.#deps.oauth.accessById(provider, account.credentialId, {
				signal: options?.signal,
			});
			if (!permits(account.credentialId)) return undefined;
			if (!access?.ok)
				return {
					...base,
					availableCount: 0,
					credits: [],
					error: access?.error ?? "Account no longer available",
				};
			let retryAfterMs: number | undefined;
			const auth = {
				...access,
				baseUrl,
				fetch: this.#deps.usage.fetch,
				signal: options?.signal,
				onRateLimited: (delay: number | undefined) => {
					retryAfterMs = delay ?? 0;
				},
			};
			const list = provider === "anthropic" ? await listClaudeResetCredits(auth) : await listCodexResetCredits(auth);
			if (!permits(account.credentialId)) return undefined;
			if (!list)
				return {
					...base,
					availableCount: 0,
					credits: [],
					error: "Failed to load saved resets",
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			return { ...base, ...list };
		};
		if (provider !== "anthropic") {
			const statuses = await Promise.all(accounts.map(loadAccount));
			return statuses.filter(status => status !== undefined);
		}
		const results: ResetCreditAccountStatus[] = [];
		accounts.sort((left, right) => Number(right.active) - Number(left.active));
		for (const account of accounts) {
			options?.signal?.throwIfAborted();
			const status = await loadAccount(account);
			if (status) results.push(status);
		}
		return results;
	}

	/**
	 * Redeem a stored account's saved reset after checking its live offer.
	 * Business refusals return a code; transport errors may throw without losing Claude's request ID.
	 */
	async redeem(options: RedeemResetCreditOptions): Promise<ResetCreditRedeemOutcome> {
		const { target } = options;
		const { provider, creditId } = target;
		const identity = { provider, accountId: target.accountId, email: target.email, orgId: target.orgId };
		if (provider !== "openai-codex" && provider !== "anthropic") {
			return { ...identity, ok: false, code: "unsupported_provider" };
		}
		const baseUrl = options.baseUrlResolver?.(provider);
		const match = await this.#deps.oauth.accessById(provider, target.credentialId, { signal: options.signal });
		if (!match) return { ...identity, ok: false, code: "no_account" };
		const resolvedIdentity = {
			provider,
			accountId: match.accountId,
			email: match.email,
			orgId: match.orgId,
		};
		if (!match.ok) return { ...resolvedIdentity, ok: false, code: "account_unavailable" };
		const accountKey = JSON.stringify([provider, baseUrl, target.credentialId]);
		const inFlight = this.#resetInFlight.get(accountKey);
		if (inFlight) {
			if (inFlight.creditId !== creditId) return { ...resolvedIdentity, ok: false, code: "reset_in_progress" };
			return inFlight.promise;
		}
		const promise = this.#redeemAccountReset(provider, match, accountKey, {
			creditId,
			baseUrl,
			signal: options.signal,
		}).finally(() => this.#resetInFlight.delete(accountKey));
		this.#resetInFlight.set(accountKey, { creditId, promise });
		return promise;
	}

	async #redeemAccountReset(
		provider: string,
		access: OAuthAccess,
		accountKey: string,
		options: { creditId?: string; baseUrl?: string; signal?: AbortSignal },
	): Promise<ResetCreditRedeemOutcome> {
		const identity = { provider, accountId: access.accountId, email: access.email, orgId: access.orgId };
		const auth = { ...access, baseUrl: options.baseUrl, fetch: this.#deps.usage.fetch, signal: options.signal };
		let creditId = options.creditId;
		let result: ResetCreditRedeemOutcome;
		let report: UsageReport | null = null;
		if (provider === "anthropic") {
			const list = await listClaudeResetCredits(auth);
			if (!list) return { ...identity, ok: false, code: "credit_list_failed" };
			const selected = list.credits.find(credit => credit.id === list.nextCreditId);
			if (creditId && creditId !== list.nextCreditId) {
				return { ...identity, ok: false, code: "offer_changed", creditId };
			}
			if (!list.eligible || !selected || !selected.usable || (list.redeemableCount ?? 0) < 1) {
				return {
					...identity,
					ok: false,
					code: list.availableCount > 0 ? "ineligible" : "no_credit",
					reason: list.reason,
				};
			}
			creditId = selected.id;
			let pending = this.#pendingClaudeResets.get(accountKey);
			const pendingCreditId = pending?.creditId;
			// The ambiguous claim's credit left the live offer: it was consumed or
			// expired. Either way its idempotency key can never settle, and the
			// account is at a wall again now, so a new offer is a fresh claim.
			if (pendingCreditId !== undefined && !list.credits.some(credit => credit.id === pendingCreditId)) {
				this.#pendingClaudeResets.delete(accountKey);
				pending = undefined;
			}
			if (pending) {
				if (pending.creditId !== creditId) return { ...identity, ok: false, code: "reset_unconfirmed", creditId };
				if (
					pending.remainingCount !== undefined &&
					selected.remainingCount !== undefined &&
					selected.remainingCount < pending.remainingCount
				) {
					this.#pendingClaudeResets.delete(accountKey);
					this.#deps.usageCache.invalidateAfterReset(provider, options.baseUrl, {
						resetSpentCredentialId: access.credentialId,
					});
					return { ...identity, ok: false, code: "already_redeemed", creditId };
				}
				if (pending.program === "juniper_tide") {
					return { ...identity, ok: false, code: "reset_unconfirmed", creditId };
				}
			}
			report = list.report ?? null;
			const requestId = pending?.requestId ?? crypto.randomUUID();
			options.signal?.throwIfAborted();
			this.#pendingClaudeResets.set(accountKey, {
				creditId,
				requestId,
				program: selected.program,
				remainingCount: selected.remainingCount,
			});
			const consumed = await consumeClaudeResetCredit({
				...auth,
				baseUrl: list.baseUrl ?? auth.baseUrl,
				orgId: list.orgId ?? access.orgId,
				credit: selected,
				redeemRequestId: requestId,
			});
			if (
				consumed.ok ||
				consumed.code === "already_redeemed" ||
				consumed.code === "nothing_to_reset" ||
				consumed.code === "ineligible" ||
				(!pending &&
					(consumed.code === "cooldown" ||
						consumed.status === 401 ||
						consumed.status === 403 ||
						consumed.status === 429))
			) {
				this.#pendingClaudeResets.delete(accountKey);
			}
			result = {
				...identity,
				ok: consumed.ok,
				code: consumed.code,
				reason: consumed.reason,
				cleared: consumed.cleared,
				creditId,
			};
		} else {
			if (!creditId) {
				const list = await listCodexResetCredits(auth);
				if (!list) return { ...identity, ok: false, code: "credit_list_failed" };
				const credit = pickSoonestExpiringCredit(list.credits);
				if (!credit) return { ...identity, ok: false, code: "no_credit" };
				creditId = credit.id;
			}
			const consumed = await consumeCodexResetCredit({ ...auth, creditId });
			result = { ...identity, ok: consumed.ok, code: consumed.code, creditId };
		}
		if (result.ok) {
			this.#deps.usageCache.invalidateAfterReset(provider, options.baseUrl, {
				resetSpentCredentialId: access.credentialId,
			});
			if (this.#deps.store.invalidateUsageCache) {
				await this.#deps.store.invalidateUsageCache(provider, options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}
			if (access.credentialId !== undefined) {
				if (provider === "anthropic") {
					// Partial resets must leave blocks for uncovered weekly/model limits intact.
					const cleared = result.cleared ?? [];
					if (
						report &&
						Number.isFinite(report.fetchedAt) &&
						Date.now() - report.fetchedAt <= USAGE_REPORT_TTL_MS &&
						cleared.length > 0 &&
						this.#deps.pool.entries(provider).some(entry => entry.id === access.credentialId)
					) {
						const scopes = claudeResetClearedBlockScopes(cleared, report);
						if (scopes.includes(undefined)) {
							// A legacy global block may be the only stored evidence of a
							// tier wall. Preserve that independent wall before lifting it.
							for (const limit of report.limits) {
								const tier = limit.scope.tier;
								const reset = limit.window?.resetsAt;
								if (
									(tier !== "fable" && tier !== "mythos") ||
									cleared.includes(limit.id) ||
									!isUsageLimitReached([limit]) ||
									typeof reset !== "number" ||
									!Number.isFinite(reset) ||
									reset <= Date.now()
								)
									continue;
								this.#deps.blocks.upsert({
									credentialId: access.credentialId,
									providerKey: providerTypeKey(provider, "oauth"),
									blockScope: `tier:${tier}`,
									blockedUntilMs: reset,
								});
							}
						}
						for (const scope of scopes) {
							this.#deps.blocks.clearScope(
								provider,
								access.credentialId,
								providerTypeKey(provider, "oauth"),
								scope,
							);
						}
					}
				} else {
					this.#deps.blocks.clearAll(provider, access.credentialId);
				}
			}
		}
		return result;
	}
}

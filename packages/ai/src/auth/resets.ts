import { logger } from "@oh-my-pi/pi-utils";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { UsageReport } from "../usage";
import { claudeResetClearedBlockScopes, consumeClaudeResetCredit, listClaudeResetCredits } from "../usage/claude-reset";
import { consumeCodexResetCredit, listCodexResetCredits, pickSoonestExpiringCredit } from "../usage/openai-codex-reset";
import type { CredentialBlocks } from "./blocks";
import { providerTypeKey } from "./blocks";
import type { OAuthAccounts } from "./oauth";
import type { CredentialPool } from "./pool";
import type { AuthCredentialStore } from "./store";
import type {
	ListResetCreditsOptions,
	OAuthAccess,
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
	usage: UsageService;
	usageCache: UsageCache;
	blocks: CredentialBlocks;
}

/** Saved rate-limit resets (Codex / Claude): list offers and redeem one per account. */
export class ResetCredits implements ResetsApi {
	#deps: ResetCreditsDeps;
	/** Manual and automatic attempts on one stored account share a mutation. */
	#resetInFlight = new Map<string, { creditId?: string; promise: Promise<ResetCreditRedeemOutcome> }>();
	/** Ambiguous Claude claims retain their idempotency key until reconciled. */
	#pendingClaudeResets = new Map<
		string,
		{ creditId: string; requestId: string; program?: string; remainingCount?: number; startedAt: number }
	>();

	constructor(deps: ResetCreditsDeps) {
		this.#deps = deps;
	}

	/** List live saved-reset balances and eligibility for one provider's stored OAuth accounts. */
	async list(options?: ListResetCreditsOptions): Promise<ResetCreditAccountStatus[]> {
		const provider = options?.provider ?? "openai-codex";
		if (provider !== "openai-codex" && provider !== "anthropic") return [];
		const accounts = this.#deps.oauth.accounts(provider, options?.sessionId);
		const baseUrl = options?.baseUrlResolver?.(provider);
		return Promise.all(
			accounts.map(async (account): Promise<ResetCreditAccountStatus> => {
				const base = { ...account, provider };
				const access = await this.#deps.oauth.accessById(provider, account.credentialId, {
					signal: options?.signal,
				});
				if (!access?.ok)
					return {
						...base,
						availableCount: 0,
						credits: [],
						error: access?.error ?? "Account no longer available",
					};
				const auth = { ...access, baseUrl, fetch: this.#deps.usage.fetch, signal: options?.signal };
				const list =
					provider === "anthropic" ? await listClaudeResetCredits(auth) : await listCodexResetCredits(auth);
				if (!list)
					return {
						...base,
						availableCount: 0,
						credits: [],
						error: "Failed to load saved resets",
					};
				return { ...base, ...list };
			}),
		);
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
			if (pending && Date.now() - pending.startedAt >= 10 * 60_000) {
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
					this.#deps.usageCache.invalidate(provider, options.baseUrl);
					return { ...identity, ok: false, code: "already_redeemed", creditId };
				}
				if (pending.program === "juniper_tide") {
					return { ...identity, ok: false, code: "reset_unconfirmed", creditId };
				}
			}
			const credential = this.#deps.pool.entries(provider).find(entry => entry.id === access.credentialId);
			if (credential?.credential.type === "oauth") {
				report = await this.#deps.usage.report(provider, credential.credential, {
					baseUrl: options.baseUrl,
					signal: options.signal,
				});
			}
			const requestId = pending?.requestId ?? crypto.randomUUID();
			options.signal?.throwIfAborted();
			this.#pendingClaudeResets.set(accountKey, {
				creditId,
				requestId,
				program: selected.program,
				remainingCount: selected.remainingCount,
				startedAt: pending?.startedAt ?? Date.now(),
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
			this.#deps.usageCache.invalidate(provider, options.baseUrl);
			if (this.#deps.store.invalidateUsageCache) {
				await this.#deps.store.invalidateUsageCache(options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}
			if (access.credentialId !== undefined) {
				if (provider === "anthropic") {
					// Partial resets must leave blocks for uncovered weekly/model limits intact.
					const cleared = result.cleared ?? [];
					if (
						report &&
						Date.now() - report.fetchedAt <= USAGE_REPORT_TTL_MS &&
						cleared.length > 0 &&
						this.#deps.pool.entries(provider).some(entry => entry.id === access.credentialId)
					) {
						for (const scope of claudeResetClearedBlockScopes(cleared, report)) {
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

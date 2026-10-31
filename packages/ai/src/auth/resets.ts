import { logger, runOutsideRequestHold } from "@oh-my-pi/pi-utils";
import { SharedFlight } from "@oh-my-pi/pi-utils/shared-flight";
import type { FetchImpl } from "@oh-my-pi/pi-utils/tls-fetch";
import * as AIError from "../error";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { UsageReport } from "../usage";
import { claudeResetClearedBlockScopes, consumeClaudeResetCredit, listClaudeResetCredits } from "../usage/claude-reset";
import { consumeCodexResetCredit, listCodexResetCredits, pickSoonestExpiringCredit } from "../usage/openai-codex-reset";
import type { CredentialBlocks } from "./blocks";
import { providerTypeKey } from "./blocks";
import { raceSignal } from "./abort";
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
	usage: UsageService;
	usageCache: UsageCache;
	blocks: CredentialBlocks;
}

/** One account's live reset discovery; each caller adds the account summary its own session sees. */
type ResetDiscovery = Omit<ResetCreditAccountStatus, keyof OAuthAccountSummary | "provider">;

/** How one discovery pass reaches the network. */
interface ResetTransport {
	/** Ends the pass: checked between accounts and passed to each account's credential lookup. */
	signal?: AbortSignal;
	/** The signal each provider call gets. Without one, the provider applies its own request timeouts. */
	requestSignal?: AbortSignal;
	fetch: FetchImpl;
}

/**
 * `fetch` for shared reset work: each request also ends once the work's own `lifetime` does, when every
 * caller has left (and, for a redemption, at {@link REDEMPTION_TIMEOUT_MS}). The work gives the provider
 * no signal of its own, so a provider that bounds each request itself (Claude) still does.
 */
function fetchWithin(fetchImpl: FetchImpl, lifetime: AbortSignal): FetchImpl {
	return (input, init) =>
		fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime });
}

/**
 * The longest one redemption runs, however long its callers wait. A caller's own timeout no longer
 * ends the shared work while another caller waits, and a Codex consume sets no timeout of its own;
 * this bound keeps every attempt well inside a caller's cross-process fence (the coding agent's
 * holds a `pending` marker for 60 s), so no other process spends while the attempt may still land.
 * Claude's own requests stop sooner (5 s offer list, 25 s claim).
 */
const REDEMPTION_TIMEOUT_MS = 45_000;

/** Each account's discovery under the summary the caller's own session sees, in the caller's order. */
function composeStatuses(
	provider: string,
	accounts: readonly OAuthAccountSummary[],
	discovered: ReadonlyMap<number, ResetDiscovery>,
): ResetCreditAccountStatus[] {
	return accounts.flatMap(account => {
		const discovery = discovered.get(account.credentialId);
		return discovery ? [{ ...account, provider, ...discovery }] : [];
	});
}

/** Saved rate-limit resets (Codex / Claude): list offers and redeem one per account. */
export class ResetCredits implements ResetsApi {
	#deps: ResetCreditsDeps;
	/** Manual and automatic attempts on one stored account share a mutation. */
	#resetInFlight = new Map<string, { creditId?: string; flight: SharedFlight<ResetCreditRedeemOutcome> }>();
	#listInFlight = new Map<string, SharedFlight<Map<number, ResetDiscovery>>>();
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
		const signal = options?.signal;
		// The caller's own session decides which accounts it sees and which is active; a shared pass only
		// supplies what the network says about each.
		const accounts = this.#deps.oauth.accounts(provider, options?.sessionId);
		if (provider !== "anthropic") {
			const discovered = await this.#discoverResets(provider, baseUrl, accounts, {
				signal,
				requestSignal: signal,
				fetch: this.#deps.usage.fetch,
			});
			return composeStatuses(provider, accounts, discovered);
		}
		signal?.throwIfAborted();
		if (accounts.length === 0) return [];
		// Discovery is sequential and probes the active account first, so only
		// callers sharing that account can share one pass.
		accounts.sort((left, right) => Number(right.active) - Number(left.active));
		const activeId = accounts.find(account => account.active)?.credentialId;
		const key = JSON.stringify([provider, baseUrl, activeId]);
		let flight = this.#listInFlight.get(key);
		if (flight?.abandoned) {
			// Every caller left that pass, so it stops at its next request. Wait it out, then start afresh.
			await raceSignal(flight.settled, signal, "Reset discovery aborted");
			return this.list(options);
		}
		if (!flight) {
			const started = SharedFlight.start(signal, lifetime =>
				// Shared by every caller on this account, so started outside the caller's provider-request hold.
				runOutsideRequestHold(() =>
					this.#discoverResets(provider, baseUrl, accounts, {
						signal: lifetime,
						fetch: fetchWithin(this.#deps.usage.fetch, lifetime),
					}),
				).finally(() => this.#listInFlight.delete(key)),
			);
			if (started instanceof Promise) return started;
			this.#listInFlight.set(key, started);
			flight = started;
		}
		const discovered = await flight.join(signal, () => new AIError.AbortError("Reset discovery aborted"));
		return composeStatuses(provider, accounts, discovered);
	}

	/** What the network says about each account's saved resets, keyed by credential id. */
	async #discoverResets(
		provider: string,
		baseUrl: string | undefined,
		accounts: readonly OAuthAccountSummary[],
		transport: ResetTransport,
	): Promise<Map<number, ResetDiscovery>> {
		const discover = async (account: OAuthAccountSummary): Promise<ResetDiscovery> => {
			const access = await this.#deps.oauth.accessById(provider, account.credentialId, {
				signal: transport.signal,
			});
			if (!access?.ok) {
				return { availableCount: 0, credits: [], error: access?.error ?? "Account no longer available" };
			}
			let retryAfterMs: number | undefined;
			const auth = {
				...access,
				baseUrl,
				fetch: transport.fetch,
				signal: transport.requestSignal,
				onRateLimited: (delay: number | undefined) => {
					retryAfterMs = delay ?? 0;
				},
			};
			const list = provider === "anthropic" ? await listClaudeResetCredits(auth) : await listCodexResetCredits(auth);
			if (!list) {
				return {
					availableCount: 0,
					credits: [],
					error: "Failed to load saved resets",
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			}
			return list;
		};
		if (provider !== "anthropic") {
			return new Map(
				await Promise.all(accounts.map(async account => [account.credentialId, await discover(account)] as const)),
			);
		}
		const discovered = new Map<number, ResetDiscovery>();
		for (const account of accounts) {
			transport.signal?.throwIfAborted();
			discovered.set(account.credentialId, await discover(account));
		}
		return discovered;
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
			if (!inFlight.flight.abandoned) {
				return inFlight.flight.join(options.signal, () => new AIError.AbortError("Reset redemption aborted"));
			}
			// Every caller left that redemption, so it stops at its next request; a new one must not spend
			// beside it. Wait it out, then start afresh.
			await raceSignal(inFlight.flight.settled, options.signal, "Reset redemption aborted");
			return this.redeem(options);
		}
		const flight = SharedFlight.start(options.signal, lifetime =>
			// Shared with every attempt on this account, so started outside the caller's provider-request hold.
			runOutsideRequestHold(() =>
				this.#redeemAccountReset(provider, match, accountKey, {
					creditId,
					baseUrl,
					signal: AbortSignal.any([lifetime, AbortSignal.timeout(REDEMPTION_TIMEOUT_MS)]),
				}),
			).finally(() => this.#resetInFlight.delete(accountKey)),
		);
		if (flight instanceof Promise) return flight;
		this.#resetInFlight.set(accountKey, { creditId, flight });
		return flight.join(options.signal, () => new AIError.AbortError("Reset redemption aborted"));
	}

	async #redeemAccountReset(
		provider: string,
		access: OAuthAccess,
		accountKey: string,
		options: { creditId?: string; baseUrl?: string; signal: AbortSignal },
	): Promise<ResetCreditRedeemOutcome> {
		const identity = { provider, accountId: access.accountId, email: access.email, orgId: access.orgId };
		// The redemption's own signal ends it once every caller has left, or at its bound; a provider that
		// bounds each request itself still does.
		const auth = { ...access, baseUrl: options.baseUrl, fetch: fetchWithin(this.#deps.usage.fetch, options.signal) };
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
			options.signal.throwIfAborted();
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

/**
 * Usage governor for one {@link AuthStorage}: admission of governed sends and read-only status.
 *
 * Reads the in-memory pool and the cached usage snapshots only. It never fetches, refreshes,
 * reloads or prunes the pool, never redeems or counts resets, never marks a limit reached, and
 * never writes an `auth_credential_blocks` row. A wait is pacing, not a provider block.
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { logger, sleepUntil } from "@oh-my-pi/pi-utils";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, UsageCredential, UsageReport } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import {
	type EvaluatedLedgerWindow,
	type LedgerAdmitRequest,
	type LedgerAdmitResult,
	type LedgerWindow,
	UsageLedger,
} from "../usage-governor/ledger";
import { UsageRouteInvalidatedError } from "../usage-governor/admission";
import {
	admissionVerdict,
	applicableWindows,
	GOVERNOR_STALE_MS,
	type ApplicableWindow,
	evaluateWindow,
	reserveFraction,
} from "../usage-governor/policy";
import {
	DISABLED_USAGE_GOVERNOR_CONFIG,
	type GovernorApi,
	type UsageAdmissionGrant,
	type UsageAdmissionOutcome,
	type UsageAdmissionRequest,
	type UsageGovernorBankedResets,
	type UsageGovernorConfig,
	type UsageGovernorEvent,
	type UsageGovernorStatus,
	type UsageGovernorWaitRecord,
	type UsageGovernorWindowStatus,
	type UsageRouteAccountEvaluation,
	type UsageRouteEvaluation,
	type UsageRouteEvaluationRequest,
	type UsageRouteBinding,
	type UsageRouteTarget,
	type UsageRoutingScope,
} from "../usage-governor/types";
import { fingerprintBearer } from "./bearer-fingerprint";
import type { AccountPolicies } from "./policy";
import type { CredentialPool, StoredCredential } from "./pool";
import { oauthAccountKey, type AuthCredential, type UsageApi } from "./types";
import { buildUsageCredential, usageCacheIdentity } from "./usage-cache";

/** Re-check interval while a request waits, so config and snapshot changes are noticed. */
const WAIT_RECHECK_MS = 15_000;
/** After a ledger failure, governed admissions fail open without touching the ledger for this long. */
const DEGRADED_RETRY_MS = 30_000;
/** Default number of recent wait records in {@link GovernorApi.status}. */
const DEFAULT_STATUS_WAIT_LIMIT = 50;

/** The store-bound modules the governor reads. Re-read per call so `replaceStore` is followed. */
export interface CredentialGovernorSource {
	readonly pool: CredentialPool;
	readonly usage: UsageApi;
	readonly policies: AccountPolicies;
	readonly affinity?: { permits(provider: string, sessionId: string, credentialId: number): boolean };
	readonly permitsOAuthFingerprint?: (provider: string) => boolean;
	readonly permitsRoute?: (binding: UsageRouteBinding, request: UsageAdmissionRequest) => boolean;
	readonly strategies: RankingStrategyResolver;
}

/** Construction options. `dbPath` undefined makes the governor inert: no file, never active. */
export interface CredentialGovernorOptions {
	dbPath?: string;
	config?: UsageGovernorConfig;
	source: () => CredentialGovernorSource;
	now?: () => number;
}

/** A request resolved to its selected row and applicable windows, before any ledger access. */
interface ResolvedRequest {
	provider: Provider;
	row: StoredCredential;
	windows: LedgerWindow[];
}

/** Outcome of one admission attempt, paired with the provider it resolved to. */
interface Attempt {
	provider: Provider;
	result: LedgerAdmitResult;
}

/** A wait this admission has opened and not yet closed. */
interface OpenWait {
	id: number;
	record: UsageGovernorWaitRecord;
}

/** Governor over the local pool. Implements {@link GovernorApi}; see the module doc for its boundaries. */
export class CredentialGovernor implements GovernorApi {
	readonly #dbPath: string | undefined;
	readonly #source: () => CredentialGovernorSource;
	readonly #now: () => number;
	readonly #listeners = new Set<(event: UsageGovernorEvent) => void>();
	readonly #scopes = new Map<string, UsageRoutingScope>();
	#config: UsageGovernorConfig;
	#ledger: UsageLedger | undefined;
	#degradedReason: string | undefined;
	#degradedUntilMs = 0;
	#closed = false;

	constructor(options: CredentialGovernorOptions) {
		this.#dbPath = options.dbPath;
		this.#source = options.source;
		this.#now = options.now ?? Date.now;
		this.#config = options.config ?? DISABLED_USAGE_GOVERNOR_CONFIG;
	}

	get config(): UsageGovernorConfig {
		return this.#config;
	}

	get active(): boolean {
		return this.#config.enabled && this.#dbPath !== undefined && !this.#closed;
	}

	configure(config: UsageGovernorConfig): void {
		this.#config = config;
		this.#emit({ kind: "config", config });
	}

	setRoutingScope(scope: UsageRoutingScope): void {
		const current = this.#scopes.get(scope.id);
		if (current && scope.revision < current.revision) throw new Error("Usage routing scope revision regressed");
		if (current && scope.revision === current.revision && JSON.stringify(current) !== JSON.stringify(scope)) {
			throw new Error("Usage routing scope changed without a new revision");
		}
		this.#scopes.set(scope.id, structuredClone(scope));
	}

	removeRoutingScope(scopeId: string): void {
		this.#scopes.delete(scopeId);
	}

	async evaluateRoutes(request: UsageRouteEvaluationRequest, signal?: AbortSignal): Promise<UsageRouteEvaluation> {
		signal?.throwIfAborted();
		return this.#evaluateRoutes(request);
	}

	#evaluateRoutes(request: UsageRouteEvaluationRequest, cachedOnly = false): UsageRouteEvaluation {
		const scope = this.#scopes.get(request.scopeId);
		if (!scope || scope.revision !== request.revision) throw new Error("Usage routing scope revision mismatch");
		const owner = request.owner ?? { kind: "role" as const, role: request.role };
		const targets =
			owner.kind === "role"
				? scope.roles.find(item => item.role === owner.role)?.targets
				: scope.models?.find(item => item.selector === owner.selector)?.targets;
		if (!targets || request.targets.some(target => !targets.some(allowed => sameTarget(target, allowed)))) {
			throw new Error("Usage routing targets do not belong to this owner");
		}
		const source = this.#source();
		const now = this.#now();
		const evaluate = (target: UsageRouteTarget): UsageRouteAccountEvaluation[] =>
			source.pool.entries(target.provider).map(row => {
				const unknown: UsageRouteAccountEvaluation = {
					selector: target.selector,
					credentialId: row.id,
					eligibility: "unknown",
					allowance: "unknown",
					quotaKeys: [],
					state: "unknown",
					protectedFor: [],
				};
				if (!this.active || !source.affinity) return unknown;
				if (!source.affinity.permits(target.provider, request.sessionId, row.id)) {
					return { ...unknown, eligibility: "ineligible" };
				}
				if (target.accountIds !== undefined && row.credential.type === "oauth") {
					const account = oauthAccountKey(row.credential);
					if (account === undefined || !target.accountIds.includes(account)) {
						return { ...unknown, eligibility: "ineligible" };
					}
				}
				const credential =
					source.usage.resolvedUsageCredential?.(target.provider, row.credential) ??
					(row.credential.type === "oauth" ? buildUsageCredential(row.credential) : undefined);
				const report = source.usage.cachedReport(target.provider, row.credential, { baseUrl: target.baseUrl });
				const provider = source.usage.providerFor(target.provider);
				if (!credential || !report || !provider?.governorAllowance) return unknown;
				const context = { modelId: target.modelId };
				const params = { provider: target.provider, credential, baseUrl: target.baseUrl };
				if (provider.supports && !provider.supports(params)) return { ...unknown, eligibility: "ineligible" };
				const gate = source.strategies(target.provider)?.planGate?.(context)?.(report);
				if (gate === false) return { ...unknown, eligibility: "ineligible" };
				if (source.strategies(target.provider)?.planGate?.(context) && gate !== true) return unknown;
				const ids = provider.governorAllowance(params, report, context);
				if (!ids || ids.length === 0 || new Set(ids).size !== ids.length) return unknown;
				const limits = ids.map(id => report.limits.find(limit => limit.id === id));
				if (
					limits.some(
						limit =>
							!limit ||
							!limit.observedAt ||
							limit.observedAt > now ||
							now - limit.observedAt > GOVERNOR_STALE_MS,
					)
				)
					return unknown;
				const windows = this.#applicable(target.provider, row.credential, report, context, now, credential);
				if (
					windows.length !== ids.length ||
					windows.some(window => !window.limitId || !ids.includes(window.limitId))
				)
					return unknown;
				const evaluated = (cachedOnly ? this.#inspectCached.bind(this) : this.#inspect.bind(this))(
					windows.map(window => ({
						...window,
						reserve: this.#reserveFor(source, target.provider, row.credential, false),
					})),
					now,
				);
				if (evaluated.some(window => window.decision.state === "unknown" || window.decision.state === "stale"))
					return unknown;
				const verdict = admissionVerdict(
					evaluated.map(window => window.decision),
					now,
				);
				const state = evaluated.some(window => window.decision.state === "closed")
					? "closed"
					: evaluated.some(window => window.decision.state === "paced")
						? "paced"
						: "open";
				const resets = report.resetCredits;
				const expiry =
					resets?.eligible === true &&
					resets.observedAt !== undefined &&
					resets.observedAt <= now &&
					now - resets.observedAt <= GOVERNOR_STALE_MS
						? resets.credits
								?.filter(
									credit =>
										credit.usable === true &&
										(credit.remainingCount ?? 0) > 0 &&
										ids.every(id => credit.clears?.includes(id)) &&
										credit.expiresAt !== undefined &&
										Number.isFinite(Date.parse(credit.expiresAt)) &&
										Date.parse(credit.expiresAt) > now,
								)
								.map(credit => Date.parse(credit.expiresAt!))
								.sort((a, b) => a - b)[0]
						: undefined;
				return {
					...unknown,
					eligibility: "eligible",
					allowance: windows.some(window => window.exhausted || (window.usedFraction ?? 0) >= 1)
						? "spent"
						: "included",
					state,
					quotaKeys: windows.map(window => createHash("sha256").update(window.quotaKey).digest("base64url")),
					admissibleAtMs: verdict.admissibleAtMs,
					resetTieBreakExpiresAtMs: expiry,
				};
			});
		const byRole = new Map(scope.roles.map(plan => [plan.role, plan.targets.flatMap(evaluate)]));
		const accounts = request.targets.flatMap(evaluate);
		const currentOpportunities = owner.kind === "role" ? (byRole.get(owner.role) ?? []) : targets.flatMap(evaluate);
		if (this.#config.roleProtection !== "off") {
			for (const account of accounts) {
				if (account.eligibility !== "eligible" || account.allowance !== "included" || account.state !== "open")
					continue;
				const independent = currentOpportunities.some(
					other =>
						other.eligibility === "eligible" &&
						other.allowance === "included" &&
						other.state === "open" &&
						other.quotaKeys.every(key => !account.quotaKeys.includes(key)),
				);
				if (!independent) continue;
				account.protectedFor = scope.roles
					.filter(plan => plan.role !== request.role)
					.filter(plan => {
						const opportunities = (byRole.get(plan.role) ?? []).filter(
							other =>
								other.eligibility === "eligible" && other.allowance === "included" && other.state === "open",
						);
						return (
							opportunities.some(other => other.quotaKeys.some(key => account.quotaKeys.includes(key))) &&
							!opportunities.some(other => other.quotaKeys.every(key => !account.quotaKeys.includes(key)))
						);
					})
					.map(plan => plan.role);
			}
		}
		return { scopeId: scope.id, revision: scope.revision, accounts };
	}

	validateRoute(binding: UsageRouteBinding, request: UsageAdmissionRequest): boolean {
		if (
			!this.active ||
			request.credentialId !== binding.credentialId ||
			request.bearerFingerprint !== binding.bearerFingerprint ||
			request.provider !== binding.target.provider ||
			request.modelId !== binding.target.modelId ||
			request.baseUrl !== binding.target.baseUrl ||
			!request.context?.sessionId
		)
			return false;
		const source = this.#source();
		if (source.permitsRoute?.(binding, request) !== true) return false;
		const row = source.pool.entries(binding.target.provider).find(entry => entry.id === binding.credentialId);
		if (!row) return false;
		if (row.credential.type === "oauth") {
			if (!source.pool.isCurrentBearerFingerprint(binding.target.provider, row.id, binding.bearerFingerprint))
				return false;
		} else {
			const credential = source.usage.resolvedUsageCredential?.(binding.target.provider, row.credential);
			if (!credential?.apiKey || fingerprintBearer(credential.apiKey) !== binding.bearerFingerprint) return false;
		}
		try {
			const evaluation = this.#evaluateRoutes(
				{
					scopeId: binding.scopeId,
					revision: binding.revision,
					owner: binding.owner,
					role: binding.owner.kind === "role" ? binding.owner.role : "",
					sessionId: request.context.sessionId,
					targets: [binding.target],
				},
				true,
			);
			return evaluation.accounts.some(
				account =>
					account.selector === binding.target.selector &&
					account.credentialId === binding.credentialId &&
					account.eligibility === "eligible" &&
					account.allowance === "included" &&
					account.state === "open",
			);
		} catch {
			return false;
		}
	}

	onEvent(listener: (event: UsageGovernorEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Release the ledger handle and stop admitting. The governor is not reusable afterwards. */
	close(): void {
		this.#closed = true;
		this.#ledger?.close();
		this.#ledger = undefined;
		this.#listeners.clear();
	}

	/**
	 * Resolve when the send may go out; reject only when `signal` aborts (leaving no reservation).
	 * Resolves `undefined` when the request is not governed or the ledger is degraded.
	 */
	async admit(request: UsageAdmissionRequest, signal?: AbortSignal): Promise<UsageAdmissionGrant | undefined> {
		if (request.usageRouteBinding && !this.validateRoute(request.usageRouteBinding, request)) {
			throw new UsageRouteInvalidatedError();
		}
		if (!this.active) return undefined;
		const grantId = crypto.randomUUID();
		let wait: OpenWait | undefined;
		try {
			for (;;) {
				signal?.throwIfAborted();
				if (request.usageRouteBinding && !this.validateRoute(request.usageRouteBinding, request)) {
					throw new UsageRouteInvalidatedError();
				}
				if (!this.active) {
					// Disabled or closed while waiting: release the request instead of holding it for a window that no longer governs.
					this.#closeWait(wait, "admitted", this.#now());
					return undefined;
				}
				const now = this.#now();
				const attempt = this.#attempt(request, grantId, now, wait?.id);
				if (attempt === undefined) {
					this.#closeWait(wait, "admitted", now);
					return undefined;
				}
				if (attempt.result.kind === "admitted") {
					this.#closeWait(wait, "admitted", now);
					return { id: grantId, waitedMs: wait ? now - wait.record.startedAtMs : 0 };
				}
				const result = attempt.result;
				if (wait === undefined) {
					wait = { id: result.waitId, record: waitRecord(request, attempt.provider, result, now) };
					this.#emit({ kind: "wait-start", wait: wait.record });
				}
				wait.record = { ...wait.record, untilMs: result.admissibleAtMs, reason: result.reason };
				await sleepUntil(Math.min(result.admissibleAtMs, now + WAIT_RECHECK_MS), signal);
			}
		} catch (error) {
			this.#closeWait(wait, "aborted", this.#now());
			throw error;
		}
	}

	settle(grantId: string, outcome: UsageAdmissionOutcome): void {
		const now = this.#now();
		const ledger = this.#ledgerOrDegrade(now);
		if (!ledger) return;
		try {
			ledger.settle(grantId, outcome, now);
		} catch (error) {
			this.#degrade(error, now);
		}
	}

	/**
	 * Pacing of one account under the background reserve, from its already-fetched report (ranking seam).
	 * Read-only: no fetch, no refresh, no write. `measured` is true when a window had a fresh usage
	 * fraction; `pacedUntil` is set when the account is paced past `now`.
	 */
	pacing(
		provider: Provider,
		credential: AuthCredential,
		usage: UsageReport,
		context: CredentialRankingContext,
		baseUrl?: string,
	): { measured: boolean; pacedUntil?: number } {
		if (!this.active) return { measured: false };
		const now = this.#now();
		const source = this.#source();
		if (credential.type === "api_key") {
			const resolved = source.usage.resolvedUsageCredential?.(provider, credential);
			const adapter = source.usage.providerFor(provider);
			const ids =
				resolved && adapter?.governorAllowance?.({ provider, credential: resolved, baseUrl }, usage, context);
			if (
				!ids?.length ||
				ids.some(id => {
					const limit = usage.limits.find(item => item.id === id);
					return !limit?.observedAt || limit.observedAt > now || now - limit.observedAt > GOVERNOR_STALE_MS;
				})
			)
				return { measured: false };
		}
		const applicable = this.#applicable(provider, credential, usage, context, now);
		if (applicable.length === 0) return { measured: false };
		const reserve = this.#reserveFor(source, provider, credential, false);
		const evaluated = this.#inspect(
			applicable.map(window => ({ ...window, reserve })),
			now,
		);
		const measured = evaluated.some(
			window =>
				window.decision.state === "open" || window.decision.state === "paced" || window.decision.state === "closed",
		);
		const verdict = admissionVerdict(
			evaluated.map(window => window.decision),
			now,
		);
		return { measured, pacedUntil: verdict.admissibleAtMs > now ? verdict.admissibleAtMs : undefined };
	}

	/**
	 * Read-only snapshot for display: windows with state, banked resets (never counted),
	 * recent waits, and ledger health. No network, no credential mutation, no pool reload.
	 */
	status(options: { provider?: string; waitLimit?: number } = {}): UsageGovernorStatus {
		const now = this.#now();
		const source = this.#source();
		const windows: UsageGovernorWindowStatus[] = [];
		for (const provider of source.pool.providers()) {
			if (options.provider !== undefined && provider !== options.provider) continue;
			for (const row of source.pool.entries(provider)) {
				const report = source.usage.cachedReport(provider, row.credential);
				if (!report) continue;
				const applicable = this.#applicable(provider, row.credential, report, {}, now);
				if (applicable.length === 0) continue;
				const reserve = this.#reserveFor(source, provider, row.credential, false);
				const evaluated = this.#inspect(
					applicable.map(window => ({ ...window, reserve })),
					now,
				);
				const banked = bankedResetsOf(report);
				evaluated.forEach((window, index) => {
					// Banked resets are shown once per account, on its first window.
					windows.push(windowStatus(provider, row.id, window, index === 0 ? banked : undefined, now));
				});
			}
		}
		const ledger = this.#ledgerState(now);
		return {
			atMs: now,
			config: this.#config,
			ledger,
			degradedReason: ledger === "degraded" ? this.#degradedReason : undefined,
			windows,
			waits: this.#recentWaits(options.waitLimit ?? DEFAULT_STATUS_WAIT_LIMIT),
		};
	}

	/** One admission attempt: one ledger transaction, or `undefined` to fail open. */
	#attempt(
		request: UsageAdmissionRequest,
		grantId: string,
		now: number,
		waitId: number | undefined,
	): Attempt | undefined {
		if (this.#degradedUntilMs > now) return undefined;
		let resolved: ResolvedRequest | undefined;
		try {
			resolved = this.#resolve(request, now);
		} catch (error) {
			logger.warn("usage governor could not resolve a request; admitting without pacing", { error: String(error) });
			return undefined;
		}
		if (!resolved) return undefined;
		const ledger = this.#ledgerOrDegrade(now);
		if (!ledger) return undefined;
		const context = request.context;
		const admitRequest: LedgerAdmitRequest = {
			grantId,
			nowMs: now,
			lead: this.#config.lead,
			windows: resolved.windows,
			waitId,
			provider: resolved.provider,
			credentialId: resolved.row.id,
			modelId: request.modelId,
			role: context?.role,
			source: context?.source ?? "unattributed",
			sessionId: context?.sessionId,
			interactive: context?.interactive === true,
			pid: process.pid,
		};
		try {
			return { provider: resolved.provider, result: ledger.admit(admitRequest) };
		} catch (error) {
			this.#degrade(error, now);
			return undefined;
		}
	}

	/** Resolve a request to its selected row and applicable windows. Reads memory and cache only. */
	#resolve(request: UsageAdmissionRequest, now: number): ResolvedRequest | undefined {
		const source = this.#source();
		const found = this.#findRow(source, request);
		if (!found) return undefined;
		const { provider, row } = found;
		const credential =
			row.credential.type === "api_key"
				? source.usage.resolvedUsageCredential?.(provider, row.credential)
				: undefined;
		if (row.credential.type === "api_key") {
			const bearer = credential?.apiKey;
			if (!bearer || !request.bearerFingerprint || fingerprintBearer(bearer) !== request.bearerFingerprint)
				return undefined;
		}
		const report = source.usage.cachedReport(provider, row.credential, { baseUrl: request.baseUrl });
		if (!report) return undefined;
		const context = { modelId: request.modelId };
		const applicable = this.#applicable(provider, row.credential, report, context, now, credential);
		if (applicable.length === 0) return undefined;
		if (row.credential.type === "api_key") {
			const adapter = source.usage.providerFor(provider);
			const ids =
				credential &&
				adapter?.governorAllowance?.({ provider, credential, baseUrl: request.baseUrl }, report, context);
			if (
				!ids?.length ||
				ids.some(id => {
					const limit = report.limits.find(item => item.id === id);
					return !limit?.observedAt || limit.observedAt > now || now - limit.observedAt > GOVERNOR_STALE_MS;
				}) ||
				applicable.some(window => !window.limitId || !ids.includes(window.limitId))
			)
				return undefined;
		}
		const interactive = request.context?.interactive === true;
		const reserve = this.#reserveFor(source, provider, row.credential, interactive);
		return { provider, row, windows: applicable.map(window => ({ ...window, reserve })) };
	}

	/** Resolve only an explicitly attributed stored row; matching bearer bytes is not provenance. */
	#findRow(
		source: CredentialGovernorSource,
		request: UsageAdmissionRequest,
	): { provider: Provider; row: StoredCredential } | undefined {
		for (const provider of source.pool.providers()) {
			if (request.provider !== undefined && provider !== request.provider) continue;
			if (request.credentialId === undefined && source.permitsOAuthFingerprint?.(provider) !== true) continue;
			const id =
				request.credentialId ??
				(request.provider && request.bearerFingerprint
					? source.pool.idForBearerFingerprint(provider, request.bearerFingerprint)
					: undefined);
			if (id === undefined) continue;
			const row = source.pool.entries(provider).find(entry => entry.id === id);
			if (row) return { provider, row };
		}
		return undefined;
	}

	#applicable(
		provider: Provider,
		credential: AuthCredential,
		report: UsageReport,
		context: CredentialRankingContext,
		now: number,
		resolved?: UsageCredential,
	): ApplicableWindow[] {
		const strategy: CredentialRankingStrategy | undefined = this.#source().strategies(provider);
		return applicableWindows({
			strategy,
			report,
			context,
			nowMs: now,
			provider,
			accountIdentity: usageCacheIdentity(
				resolved ??
					this.#source().usage.resolvedUsageCredential?.(provider, credential) ??
					buildUsageCredential(credential),
			),
		});
	}

	#reserveFor(
		source: CredentialGovernorSource,
		provider: Provider,
		credential: AuthCredential,
		interactive: boolean,
	): number {
		const policy = source.policies.forCredential(provider, credential);
		return reserveFraction({
			reservePct: policy?.reservePct ?? source.policies.defaultReservePct,
			interactiveReserve: this.#config.interactiveReserve,
			interactive,
		});
	}

	/** Evaluate windows against the ledger, or against the cache alone when the ledger is unavailable. */
	#inspect(windows: LedgerWindow[], now: number): EvaluatedLedgerWindow[] {
		const ledger = this.#ledgerForRead();
		const readOnly = ledger !== undefined && ledger !== this.#ledger;
		if (ledger) {
			try {
				return ledger.inspect(windows, now, this.#config.lead);
			} catch (error) {
				this.#readFailed(ledger, error, now);
			} finally {
				if (readOnly) ledger.close();
			}
		}
		return this.#inspectCached(windows, now);
	}

	#inspectCached(windows: LedgerWindow[], now: number): EvaluatedLedgerWindow[] {
		return windows.map(window => ({
			...window,
			decision: evaluateWindow({
				nowMs: now,
				lead: this.#config.lead,
				reserve: window.reserve,
				resetsAt: window.resetsAt,
				durationMs: window.durationMs,
				usedFraction: window.usedFraction,
				exhausted: window.exhausted,
				fetchedAt: window.fetchedAt,
				pending: 0,
				costPerRequest: 0,
			}),
			pending: 0,
			inFlight: 0,
		}));
	}

	#recentWaits(limit: number): UsageGovernorWaitRecord[] {
		const ledger = this.#ledgerForRead();
		if (!ledger) return [];
		const readOnly = ledger !== this.#ledger;
		try {
			return ledger.recentWaits(limit);
		} catch (error) {
			this.#readFailed(ledger, error, this.#now());
			return [];
		} finally {
			if (readOnly) ledger.close();
		}
	}

	/** The open ledger for admission: opened on first use; any failure degrades to fail-open. */
	#ledgerOrDegrade(now: number): UsageLedger | undefined {
		if (this.#closed || this.#degradedUntilMs > now) return undefined;
		if (this.#ledger) return this.#ledger;
		if (this.#dbPath === undefined) return undefined;
		try {
			this.#ledger = UsageLedger.open(this.#dbPath);
			return this.#ledger;
		} catch (error) {
			this.#degrade(error, now);
			return undefined;
		}
	}

	/** Ledger for status and ranking reads: never creates or writes the file, and only once governance is enabled. */
	#ledgerForRead(): UsageLedger | undefined {
		if (this.#closed) return undefined;
		if (this.#ledger) return this.#ledger;
		if (!this.#config.enabled || this.#dbPath === undefined || !fs.existsSync(this.#dbPath)) return undefined;
		try {
			return UsageLedger.openReadOnly(this.#dbPath);
		} catch (error) {
			logger.debug("usage governor ledger is not readable yet; evaluating from the cache alone", {
				error: String(error),
			});
			return undefined;
		}
	}

	/** Only a failure of the writable ledger degrades admission. */
	#readFailed(ledger: UsageLedger, error: unknown, now: number): void {
		if (ledger === this.#ledger) {
			this.#degrade(error, now);
			return;
		}
		logger.debug("usage governor ledger read failed; evaluating from the cache alone", { error: String(error) });
	}

	#degrade(error: unknown, now: number): void {
		this.#degradedReason = error instanceof Error ? error.message : String(error);
		this.#degradedUntilMs = now + DEGRADED_RETRY_MS;
		logger.warn("usage governor ledger degraded; admitting without pacing", { reason: this.#degradedReason });
		try {
			this.#ledger?.close();
		} catch {
			// The handle is discarded either way.
		}
		this.#ledger = undefined;
	}

	#ledgerState(now: number): "ok" | "degraded" | "closed" {
		if (!this.#config.enabled) return "closed";
		return this.#degradedUntilMs > now ? "degraded" : "ok";
	}

	#closeWait(wait: OpenWait | undefined, outcome: "admitted" | "aborted", now: number): void {
		if (wait === undefined) return;
		try {
			this.#ledger?.endWait(wait.id, outcome, now);
		} catch (error) {
			this.#degrade(error, now);
		}
		this.#emit({ kind: "wait-end", wait: { ...wait.record, endedAtMs: now, outcome } });
	}

	#emit(event: UsageGovernorEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("usage governor listener failed", { error: String(error) });
			}
		}
	}
}

/** The display record for one wait, built from the first attempt that waited. */
function waitRecord(
	request: UsageAdmissionRequest,
	provider: Provider,
	result: Extract<LedgerAdmitResult, { kind: "wait" }>,
	now: number,
): UsageGovernorWaitRecord {
	const context = request.context;
	return {
		startedAtMs: now,
		provider,
		credentialId: request.credentialId,
		modelId: request.modelId,
		role: context?.role,
		source: context?.source ?? "unattributed",
		sessionId: context?.sessionId,
		pid: process.pid,
		reason: result.reason,
		bindingLabel: result.bindingLabel,
		usedFraction: result.usedFraction,
		allowedFraction: result.allowedFraction,
		untilMs: result.admissibleAtMs,
		resetsAtMs: result.resetsAtMs,
	};
}

/** Banked resets for display only: the count, eligibility and the soonest expiry. Never counted as capacity. */
function bankedResetsOf(report: UsageReport): UsageGovernorBankedResets | undefined {
	const credits = report.resetCredits;
	if (!credits || credits.availableCount <= 0) return undefined;
	let soonestExpiresAtMs: number | undefined;
	for (const credit of credits.credits ?? []) {
		if (!credit.expiresAt) continue;
		const expiresAt = Date.parse(credit.expiresAt);
		if (!Number.isFinite(expiresAt)) continue;
		soonestExpiresAtMs = soonestExpiresAtMs === undefined ? expiresAt : Math.min(soonestExpiresAtMs, expiresAt);
	}
	return {
		available: credits.availableCount,
		redeemable: credits.redeemableCount,
		eligible: credits.eligible,
		reason: credits.reason,
		soonestExpiresAtMs,
	};
}

function windowStatus(
	provider: Provider,
	credentialId: number,
	window: EvaluatedLedgerWindow,
	bankedResets: UsageGovernorBankedResets | undefined,
	now: number,
): UsageGovernorWindowStatus {
	const { decision } = window;
	const gated = decision.state === "paced" || decision.state === "closed";
	return {
		provider,
		credentialId,
		quotaKey: createHash("sha256").update(window.quotaKey).digest("base64url"),
		label: window.label,
		state: decision.state,
		usedFraction: window.usedFraction,
		allowedFraction: decision.allowedFraction,
		reserveFraction: window.reserve,
		resetsAtMs: window.resetsAt,
		observedAtMs: window.fetchedAt,
		pendingRequests: window.pending,
		inFlightRequests: window.inFlight,
		costPerRequest: window.costPerRequest,
		admissibleAtMs: gated && decision.admissibleAtMs > now ? decision.admissibleAtMs : undefined,
		bankedResets,
	};
}

function sameTarget(left: UsageRouteTarget, right: UsageRouteTarget): boolean {
	return (
		left.selector === right.selector &&
		left.provider === right.provider &&
		left.modelId === right.modelId &&
		left.baseUrl === right.baseUrl &&
		(left.accountIds === undefined
			? right.accountIds === undefined
			: right.accountIds !== undefined &&
				left.accountIds.length === right.accountIds.length &&
				left.accountIds.every((id, index) => id === right.accountIds?.[index]))
	);
}

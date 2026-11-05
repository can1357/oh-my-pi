/**
 * Usage governor for one {@link AuthStorage}: admission of governed sends and read-only status.
 *
 * Reads the in-memory pool and the cached usage snapshots only. It never fetches, refreshes,
 * reloads or prunes the pool, never redeems or counts resets, never marks a limit reached, and
 * never writes an `auth_credential_blocks` row. A wait is pacing, not a provider block.
 */
import * as fs from "node:fs";
import { logger, sleepUntil } from "@oh-my-pi/pi-utils";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, UsageReport } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import {
	type EvaluatedLedgerWindow,
	type LedgerAdmitRequest,
	type LedgerAdmitResult,
	type LedgerWindow,
	UsageLedger,
} from "../usage-governor/ledger";
import {
	admissionVerdict,
	applicableWindows,
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
} from "../usage-governor/types";
import type { AccountPolicies } from "./policy";
import type { CredentialPool, StoredCredential } from "./pool";
import type { AuthCredential, UsageApi } from "./types";
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
		if (!this.active) return undefined;
		const grantId = crypto.randomUUID();
		let wait: OpenWait | undefined;
		try {
			for (;;) {
				signal?.throwIfAborted();
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
	): { measured: boolean; pacedUntil?: number } {
		if (!this.active) return { measured: false };
		const now = this.#now();
		const source = this.#source();
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
				if (row.credential.type !== "oauth") continue;
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
		if (row.credential.type !== "oauth") return undefined;
		const report = source.usage.cachedReport(provider, row.credential, { baseUrl: request.baseUrl });
		if (!report) return undefined;
		const applicable = this.#applicable(provider, row.credential, report, { modelId: request.modelId }, now);
		if (applicable.length === 0) return undefined;
		const interactive = request.context?.interactive === true;
		const reserve = this.#reserveFor(source, provider, row.credential, interactive);
		return { provider, row, windows: applicable.map(window => ({ ...window, reserve })) };
	}

	/** The stored row a request names, by credential id or else by bearer fingerprint (in-memory pool only). */
	#findRow(
		source: CredentialGovernorSource,
		request: UsageAdmissionRequest,
	): { provider: Provider; row: StoredCredential } | undefined {
		for (const provider of source.pool.providers()) {
			if (request.provider !== undefined && provider !== request.provider) continue;
			const id =
				request.credentialId ??
				(request.bearerFingerprint === undefined
					? undefined
					: source.pool.idForBearerFingerprint(provider, request.bearerFingerprint));
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
	): ApplicableWindow[] {
		const strategy: CredentialRankingStrategy | undefined = this.#source().strategies(provider);
		return applicableWindows({
			strategy,
			report,
			context,
			nowMs: now,
			provider,
			accountIdentity: usageCacheIdentity(buildUsageCredential(credential)),
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
		quotaKey: window.quotaKey,
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

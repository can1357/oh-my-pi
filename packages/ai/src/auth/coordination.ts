import { logger } from "@oh-my-pi/pi-utils";
import type { Provider } from "../types";
import type { RankingStrategyResolver } from "../usage/registry";
import { credentialBlockScopesForRequest, providerTypeKey } from "./blocks";
import type { CredentialBlocks } from "./blocks";
import type { SessionAffinity } from "./affinity";
import type { CredentialPool, StoredCredential } from "./pool";
import { QuotaProbeLeaseBook } from "./probe-lease";
import type { ApiKeySelection } from "./rank";
import type { UsageCache } from "./usage-cache";
import type { AuthApiKeyOptions, AuthCredential } from "./types";

/**
 * Stable physical identity for an OAuth row: account/org/project/email only —
 * never token bytes. Two payloads describing the same account share a
 * fingerprint; a refresh that swaps `access`/`refresh` keeps it, while a
 * re-login to a different account changes it.
 */
function fingerprintOAuthPhysicalIdentity(credential: AuthCredential): string | null {
	if (credential.type !== "oauth") return null;
	const parts: string[] = [];
	const accountId = credential.accountId?.trim();
	const email = credential.email?.trim().toLowerCase();
	const orgId = credential.orgId?.trim();
	if (accountId) parts.push(`account:${accountId}`);
	if (email) parts.push(`email:${email}`);
	if (orgId) parts.push(`org:${orgId}`);
	if (parts.length === 0) return null;
	return parts.join("|");
}

function identityFieldMap(fingerprint: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of fingerprint.split("|")) {
		const sep = part.indexOf(":");
		if (sep <= 0) continue;
		fields.set(part.slice(0, sep), part.slice(sep + 1));
	}
	return fields;
}

/** True only when an identifier present in both snapshots disagrees. A field
 * missing from either side is inconclusive (ordinary metadata loss on reload),
 * never a switch: bumping would purge quota blocks, usage state, and session
 * affinity for an unchanged account. */
function identityFingerprintsConflict(oldFingerprint: string, newFingerprint: string): boolean {
	const oldFields = identityFieldMap(oldFingerprint);
	const newFields = identityFieldMap(newFingerprint);
	for (const [key, value] of oldFields) {
		const next = newFields.get(key);
		if (next !== undefined && next !== value) return true;
	}
	return false;
}

export function anonymousProbeRequestKey(credentialId: number, blockScope: string): string {
	return `anon-probe:${credentialId}:${blockScope}`;
}

export interface CredentialCoordinationDeps {
	pool: CredentialPool;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usageCache: UsageCache;
	strategies: RankingStrategyResolver;
	probeLeases: QuotaProbeLeaseBook;
}

/**
 * In-process credential coordination layered over the pool/blocks modules:
 * per-row incarnation counters and single-flight quota-probe leases. All state is in-memory — it exists to
 * keep *concurrent requests in this process* from double-vending one
 * credential row, and to arbitrate which request may probe a blocked
 * credential's quota. Persisted blocks/affinity live in their own modules.
 */
export class CredentialCoordination {
	/** Per-credential generation counter, bumped when a row's physical identity changes. */
	#credentialIncarnation = new Map<number, number>();
	#inflightProbes = new Map<string, { credentialId: number; blockScope: string; leaseId: string }>();
	#probeLeases: QuotaProbeLeaseBook;
	readonly #deps: CredentialCoordinationDeps;

	constructor(deps: CredentialCoordinationDeps) {
		this.#deps = deps;
		this.#probeLeases = deps.probeLeases;
	}

	// ------------------------------------------------------------------
	// Incarnation
	// ------------------------------------------------------------------

	getCredentialIncarnation(credentialId: number): number {
		return this.#credentialIncarnation.get(credentialId) ?? 1;
	}

	/**
	 * Bump the incarnation when a stored row's physical identity changes
	 * (type swap, different API key bytes, or an OAuth identity-field change
	 * that is not a conservative enrichment). Called by the pool whenever a
	 * replace observes a differing credential at the same durable row id.
	 */
	maybeBumpIncarnation(provider: string, credentialId: number, previous: AuthCredential, next: AuthCredential): void {
		const oldFp = fingerprintOAuthPhysicalIdentity(previous);
		const newFp = fingerprintOAuthPhysicalIdentity(next);
		if (!oldFp || !newFp || oldFp === newFp) return;
		if (!identityFingerprintsConflict(oldFp, newFp)) return;
		this.#bumpCredentialIncarnation(provider, credentialId);
	}

	#bumpCredentialIncarnation(provider: string, credentialId: number): void {
		const incarnation = (this.#credentialIncarnation.get(credentialId) ?? 1) + 1;
		this.#credentialIncarnation.set(credentialId, incarnation);
		this.#deps.affinity.clearCredential(provider, credentialId);
		this.#deps.blocks.clearCredential(provider, credentialId);
		this.#probeLeases.purgeCredential(credentialId);
		this.#deps.usageCache.invalidate(provider);
		logger.info("auth-storage credential incarnation bumped after identity change", {
			provider,
			credentialId,
			incarnation,
		});
	}

	/**
	 * {@link CredentialBlocks.blockedUntil} scoped per request. The requestId
	 * parameter is carried for signature stability across the gateway stack;
	 * request-scoped overlays arrive with turn reservations.
	 */
	blockedUntilForRequest(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
		_requestId?: string,
	): number | undefined {
		return this.#deps.blocks.blockedUntil(provider, providerKey, credentialIndex, blockScopeOrScopes);
	}

	isBlockedForRequest(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
		requestId?: string,
	): boolean {
		return (
			this.blockedUntilForRequest(provider, providerKey, credentialIndex, blockScopeOrScopes, requestId) !==
			undefined
		);
	}

	/**
	 * Re-assert Retry-After provenance for a still-active block after a
	 * longest-wins merge extended the deadline: only refreshes the recorded
	 * deadline when the scope is already Retry-After-sourced — re-labeling an
	 * ordinary hard cooldown as Retry-After would forbid last-resort probes.
	 */
	refreshRetryAfterProvenance(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		credentialId: number,
		probeScope: string,
		blockScopeOrScopes: string | readonly string[] | undefined,
		requestId?: string,
	): void {
		if (!this.#probeLeases.isRetryAfterSourced(credentialId, probeScope)) return;
		const blockedUntil = this.blockedUntilForRequest(
			provider,
			providerKey,
			credentialIndex,
			blockScopeOrScopes,
			requestId,
		);
		if (blockedUntil !== undefined) this.#probeLeases.noteRetryAfterBlock(credentialId, probeScope, blockedUntil);
	}

	// ------------------------------------------------------------------
	// Quota probe leases
	// ------------------------------------------------------------------

	tryAcquireQuotaProbeLease(credentialId: number, blockScope: string): string | null {
		return this.#probeLeases.tryAcquire(credentialId, blockScope);
	}

	/** Re-apply Retry-After provenance from durable blocks after restart / peer reload. */
	hydrateRetryAfterProvenance(credentialId: number): void {
		for (const block of this.#deps.blocks.list([credentialId])) {
			if (!block.retryAfter) continue;
			if (block.blockedUntilMs <= Date.now()) continue;
			this.#probeLeases.noteRetryAfterBlock(credentialId, block.blockScope, block.blockedUntilMs);
		}
	}

	#resolveQuotaProbeLeaseScope(credentialId: number, blockScope: string): string {
		if (this.#probeLeases.isRetryAfterSourced(credentialId, blockScope)) return blockScope;
		if (blockScope !== "" && this.#probeLeases.isRetryAfterSourced(credentialId, "")) return "";
		return blockScope;
	}

	/**
	 * Prefer the block scope that is actually active for this credential (global
	 * `""` and Retry-After provenance win over a derived chat/spark request scope).
	 */
	resolveBlockingProbeScope(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		credentialId: number,
		blockScope: string | undefined,
		blockScopes: readonly string[] | undefined,
		requestId: string | undefined,
	): string {
		const candidates: string[] = [""];
		if (blockScope) candidates.push(blockScope);
		for (const scope of blockScopes ?? []) {
			if (scope && !candidates.includes(scope)) candidates.push(scope);
		}
		for (const scope of candidates) {
			if (
				this.#probeLeases.isRetryAfterSourced(credentialId, scope) &&
				this.blockedUntilForRequest(provider, providerKey, credentialIndex, scope || undefined, requestId) !==
					undefined
			) {
				return scope;
			}
		}
		for (const scope of candidates) {
			if (
				this.blockedUntilForRequest(provider, providerKey, credentialIndex, scope || undefined, requestId) !==
				undefined
			) {
				return scope;
			}
		}
		return blockScope ?? "";
	}

	/**
	 * Acquire a probe lease for `requestId`, or reuse the request-owned lease when
	 * auth retry re-enters while the same request still holds it (tryAcquire would
	 * otherwise return null and clearQuotaProbe would be unreachable).
	 */
	acquireOrReuseQuotaProbeLease(requestId: string, credentialId: number, probeScope: string): boolean {
		const existing = this.#inflightProbes.get(requestId);
		if (existing && existing.credentialId === credentialId && existing.blockScope === probeScope) {
			return true;
		}
		const lease = this.tryAcquireQuotaProbeLease(credentialId, probeScope);
		if (!lease) return false;
		this.clearQuotaProbe(requestId);
		this.#inflightProbes.set(requestId, {
			credentialId,
			blockScope: probeScope,
			leaseId: lease,
		});
		return true;
	}

	hasInflightProbe(requestId: string): boolean {
		return this.#inflightProbes.has(requestId);
	}

	recordQuotaProbeSuccess(credentialId: number, blockScope: string, leaseId: string | null): boolean {
		if (!this.#probeLeases.recordSuccess(credentialId, blockScope, leaseId)) return false;
		for (const provider of this.#deps.pool.providers()) {
			const entries = this.#deps.pool.entries(provider);
			const index = entries.findIndex(entry => entry.id === credentialId);
			if (index < 0) continue;
			const providerKey = providerTypeKey(provider, entries[index]!.credential.type);
			this.#deps.blocks.clearScope(provider, credentialId, providerKey, blockScope || undefined);
			return true;
		}
		return true;
	}

	noteTransientSoftAvoid(credentialId: number, blockScope: string, untilMs: number): void {
		this.#probeLeases.noteSoftAvoid(credentialId, blockScope, untilMs);
	}

	/**
	 * Drop an inflight quota probe for `requestId` without clearing cooldown.
	 * Call when the attempt is abandoned (fallback / turn release) so a later
	 * request can acquire a fresh lease.
	 */
	clearQuotaProbe(requestId: string): void {
		const probe = this.#inflightProbes.get(requestId);
		if (!probe) return;
		this.#inflightProbes.delete(requestId);
		this.#probeLeases.release(probe.credentialId, probe.blockScope, probe.leaseId);
	}

	settleQuotaProbeSuccess(requestId: string): boolean {
		const probe = this.#inflightProbes.get(requestId);
		if (!probe) return false;
		this.#inflightProbes.delete(requestId);
		return this.recordQuotaProbeSuccess(probe.credentialId, probe.blockScope, probe.leaseId);
	}

	clearAnonymousQuotaProbe(credentialId: number, blockScope: string): void {
		const key = anonymousProbeRequestKey(credentialId, blockScope);
		if (!this.#inflightProbes.has(key)) return;
		this.clearQuotaProbe(key);
	}

	settleAnonymousQuotaProbe(credentialId: number, blockScope: string): boolean {
		const key = anonymousProbeRequestKey(credentialId, blockScope);
		if (!this.#inflightProbes.has(key)) return false;
		return this.settleQuotaProbeSuccess(key);
	}

	// ------------------------------------------------------------------
	// Selection-time probes and cooldown inspection
	// ------------------------------------------------------------------

	/**
	 * Probe path for a blocked API-key candidate: acquires the single-flight
	 * quota-probe lease (anonymous probes keyed by credential+scope). Returns
	 * true only when the candidate may be vended as a probe.
	 */
	tryApiKeyProbe(
		provider: string,
		providerKey: string,
		selection: ApiKeySelection,
		options: AuthApiKeyOptions | undefined,
		blockScope?: string,
		blockScopes?: readonly string[],
	): boolean {
		if (
			!this.isBlockedForRequest(
				provider,
				providerKey,
				selection.index,
				blockScopes ?? blockScope,
				options?.requestId,
			)
		)
			return false;
		const credentialId = this.#deps.pool.entries(provider)[selection.index]?.id;
		if (credentialId === undefined) return false;
		const scope = this.resolveBlockingProbeScope(
			provider,
			providerKey,
			selection.index,
			credentialId,
			blockScope,
			blockScopes,
			options?.requestId,
		);
		const requestId = options?.requestId ?? anonymousProbeRequestKey(credentialId, scope);
		if (!options?.requestId && this.#inflightProbes.has(requestId)) return false;
		return this.acquireOrReuseQuotaProbeLease(requestId, credentialId, scope);
	}

	/**
	 * True when the provider has stored credentials but every candidate is under
	 * an active backoff / Retry-After / probe-lease hold (so getApiKey returned
	 * undefined for quota reasons rather than missing auth).
	 */
	hasCoolingDownCredentials(provider: Provider, modelId?: string): boolean {
		const entries = this.#deps.pool.entries(provider);
		if (entries.length === 0) return false;
		const rankingContext = { modelId };
		const strategy = this.#deps.strategies(provider);
		for (const credType of ["oauth", "api_key"] as const) {
			const typed = entries
				.map((entry, index) => ({ entry, index }))
				.filter(item => item.entry.credential.type === credType);
			if (typed.length === 0) continue;
			const providerKey = providerTypeKey(provider, credType);
			const blockScope = strategy?.blockScope?.(rankingContext);
			const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
			const anyUnblocked = typed.some(
				item => !this.isBlockedForRequest(provider, providerKey, item.index, blockScopes ?? blockScope),
			);
			if (!anyUnblocked) return true;
		}
		return false;
	}
}

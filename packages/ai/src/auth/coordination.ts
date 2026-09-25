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
import type {
	AuthApiKeyOptions,
	AuthCredential,
	TurnReservation,
	TurnReservationResult,
} from "./types";
import { DEFAULT_TURN_RESERVATION_TTL_MS } from "./types";

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
	const projectId = credential.projectId?.trim();
	if (accountId) parts.push(`account:${accountId}`);
	if (email) parts.push(`email:${email}`);
	if (orgId) parts.push(`org:${orgId}`);
	if (projectId) parts.push(`project:${projectId}`);
	if (parts.length === 0) return null;
	return parts.join("|");
}

/** Stable identity for API-key rows so key replacement bumps incarnation. */
function fingerprintApiKeyPhysicalIdentity(credential: AuthCredential): string | null {
	if (credential.type !== "api_key") return null;
	return `api_key:${Bun.SHA256.hash(credential.key, "base64url")}`;
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

/**
 * True when `newFingerprint` only adds identity fields (or repeats values) —
 * e.g. a refresh that newly reports `orgId` for the same account. Enrichment
 * keeps the incarnation (and any live reservations) stable; a field that
 * changes or disappears is a real identity change and must bump.
 */
function isConservativeIdentityEnrichment(oldFingerprint: string, newFingerprint: string): boolean {
	const oldFields = identityFieldMap(oldFingerprint);
	const newFields = identityFieldMap(newFingerprint);
	for (const [field, value] of oldFields) {
		if (newFields.get(field) !== value) return false;
	}
	return true;
}

function turnReservationKey(credentialId: number, incarnation: number): string {
	return `${credentialId}:${incarnation}`;
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
 * per-row incarnation counters, requestId-scoped turn reservations, and
 * single-flight quota-probe leases. All state is in-memory — it exists to
 * keep *concurrent requests in this process* from double-vending one
 * credential row, and to arbitrate which request may probe a blocked
 * credential's quota. Persisted blocks/affinity live in their own modules.
 */
export class CredentialCoordination {
	/** Per-credential generation counter, bumped when a row's physical identity changes. */
	#credentialIncarnation = new Map<number, number>();
	#turnReservations = new Map<
		string,
		{ requestId: string; expiresAtMs: number; credentialId: number; incarnation: number; token: number }
	>();
	#turnReservationToken = 0;
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
		// Type replacement (oauth ↔ api_key) always invalidates prior reservations.
		if (previous.type !== next.type) {
			this.#bumpCredentialIncarnation(provider, credentialId);
			return;
		}
		if (previous.type === "api_key" && next.type === "api_key") {
			const oldFp = fingerprintApiKeyPhysicalIdentity(previous);
			const newFp = fingerprintApiKeyPhysicalIdentity(next);
			if (!oldFp || !newFp || oldFp === newFp) return;
			this.#bumpCredentialIncarnation(provider, credentialId);
			return;
		}
		const oldFp = fingerprintOAuthPhysicalIdentity(previous);
		const newFp = fingerprintOAuthPhysicalIdentity(next);
		if (!oldFp || !newFp || oldFp === newFp) return;
		if (isConservativeIdentityEnrichment(oldFp, newFp)) return;
		this.#bumpCredentialIncarnation(provider, credentialId);
	}

	#bumpCredentialIncarnation(provider: string, credentialId: number): void {
		const incarnation = (this.#credentialIncarnation.get(credentialId) ?? 1) + 1;
		this.#credentialIncarnation.set(credentialId, incarnation);
		this.#deps.affinity.clearCredential(provider, credentialId);
		this.#deps.blocks.clearCredential(provider, credentialId);
		this.#probeLeases.purgeCredential(credentialId);
		this.#purgeTurnReservationsForCredential(credentialId);
		this.#deps.usageCache.invalidate(provider);
		logger.info("auth-storage credential incarnation bumped after identity change", {
			provider,
			credentialId,
			incarnation,
		});
	}

	// ------------------------------------------------------------------
	// Turn reservations
	// ------------------------------------------------------------------

	#purgeTurnReservationsForCredential(credentialId: number): void {
		const prefix = `${credentialId}:`;
		for (const key of [...this.#turnReservations.keys()]) {
			if (key.startsWith(prefix)) this.#turnReservations.delete(key);
		}
	}

	activeTurnReservation(
		credentialId: number,
		incarnation: number,
		nowMs: number = Date.now(),
	): { requestId: string; expiresAtMs: number } | undefined {
		const key = turnReservationKey(credentialId, incarnation);
		const held = this.#turnReservations.get(key);
		if (!held) return undefined;
		if (held.expiresAtMs <= nowMs) {
			this.#turnReservations.delete(key);
			return undefined;
		}
		return { requestId: held.requestId, expiresAtMs: held.expiresAtMs };
	}

	tryAcquireTurnReservation(args: {
		credentialId: number;
		incarnation: number;
		requestId: string;
		ttlMs?: number;
	}): TurnReservationResult {
		const nowMs = Date.now();
		const ttlMs = args.ttlMs ?? DEFAULT_TURN_RESERVATION_TTL_MS;
		const key = turnReservationKey(args.credentialId, args.incarnation);
		const held = this.activeTurnReservation(args.credentialId, args.incarnation, nowMs);
		if (held && held.requestId !== args.requestId) {
			return { ok: false, heldByRequestId: held.requestId, expiresAtMs: held.expiresAtMs };
		}
		const probe = this.#inflightProbes.get(args.requestId);
		if (probe && probe.credentialId !== args.credentialId) this.clearQuotaProbe(args.requestId);
		const expiresAtMs = nowMs + ttlMs;
		this.#turnReservationToken += 1;
		const token = this.#turnReservationToken;
		this.#turnReservations.set(key, {
			requestId: args.requestId,
			expiresAtMs,
			credentialId: args.credentialId,
			incarnation: args.incarnation,
			token,
		});
		const reservation: TurnReservation = {
			credentialId: args.credentialId,
			incarnation: args.incarnation,
			requestId: args.requestId,
			expiresAtMs,
			release: () => {
				const current = this.#turnReservations.get(key);
				if (current?.requestId === args.requestId && current.token === token) {
					this.#turnReservations.delete(key);
				}
			},
		};
		return { ok: true, reservation };
	}

	releaseTurnReservation(requestId: string): void {
		for (const [key, held] of this.#turnReservations) {
			if (held.requestId === requestId) this.#turnReservations.delete(key);
		}
		// Abandon any inflight probe for this request without treating it as success.
		this.clearQuotaProbe(requestId);
	}

	/** Extend every live reservation held by `requestId` so long streams outlive the idle TTL. */
	renewTurnReservation(requestId: string, ttlMs: number = DEFAULT_TURN_RESERVATION_TTL_MS): void {
		const expiresAtMs = Date.now() + ttlMs;
		for (const [key, held] of this.#turnReservations) {
			if (held.requestId === requestId) {
				this.#turnReservations.set(key, { ...held, expiresAtMs });
			}
		}
	}

	/** Acquire an exclusive turn reservation for a stored API-key row when requestId is set. */
	tryReserveApiKeySelection(provider: string, selection: ApiKeySelection, requestId: string | undefined): boolean {
		if (!requestId) return true;
		const reserveId = this.#deps.pool.entries(provider)[selection.index]?.id;
		if (reserveId === undefined) return true;
		return this.tryAcquireTurnReservation({
			credentialId: reserveId,
			incarnation: this.getCredentialIncarnation(reserveId),
			requestId,
		}).ok;
	}

	// ------------------------------------------------------------------
	// Request-aware blocking: a foreign-held reservation counts as a block
	// ------------------------------------------------------------------

	/**
	 * {@link CredentialBlocks.blockedUntil} plus the in-flight reservation
	 * overlay: a credential exclusively held by a different requestId reads as
	 * blocked until the hold expires. Persisted blocks that outlive the
	 * in-memory map re-assert Retry-After provenance into the probe book so
	 * restarts cannot silently downgrade a provider-timed wait.
	 */
	blockedUntilForRequest(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
		requestId?: string,
	): number | undefined {
		const nowMs = Date.now();
		const credentialId = this.#deps.pool.entries(provider)[credentialIndex]?.id;
		let blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, credentialIndex, blockScopeOrScopes);
		if (credentialId === undefined) return blockedUntil;
		const held = this.activeTurnReservation(credentialId, this.getCredentialIncarnation(credentialId), nowMs);
		if (held && held.requestId !== requestId && (blockedUntil === undefined || held.expiresAtMs > blockedUntil)) {
			blockedUntil = held.expiresAtMs;
		}
		return blockedUntil;
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

	// ------------------------------------------------------------------
	// Quota probe leases
	// ------------------------------------------------------------------

	tryAcquireQuotaProbeLease(credentialId: number, blockScope: string): string | null {
		return this.#probeLeases.tryAcquire(credentialId, blockScope);
	}

	/** Whether the live block for this credential+scope carries provider-stated (Retry-After) timing. */
	isRetryAfterSourced(credentialId: number, blockScope: string): boolean {
		return this.#probeLeases.isRetryAfterSourced(credentialId, blockScope);
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

	// ------------------------------------------------------------------
	// Selection-time probes and cooldown inspection
	// ------------------------------------------------------------------


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

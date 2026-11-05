/**
 * One-shot capability tokens for destructive operations.
 *
 * A destructive call that would destroy work with no other copy (an isolation
 * worktree holding uncommitted edits, a parked agent whose transcript exists
 * only in memory, a live agent that still owes turns to queued peer messages)
 * refuses on its first attempt: nothing is destroyed, and the refusal carries a
 * freshly issued token. The caller retries with the token in the operation's
 * `force` parameter, which authorizes exactly one execution.
 *
 * Tokens are:
 * - **bounded** to one action and one target, so a token minted for an
 *   isolation discard cannot cancel a job;
 * - **one-shot**: consuming a token deletes its grant, so a replay refuses;
 * - **short-lived**: {@link CAPABILITY_TOKEN_TTL_MS} (10 minutes), enforced on
 *   every check, with a timer that drops the grant so an unused token does not
 *   accumulate;
 * - **in-memory only**: grants never touch disk, so a restart cannot resurrect
 *   an authorization the user has not repeated.
 */

import { randomBytes } from "node:crypto";

/** How long an issued token authorizes its one operation. */
export const CAPABILITY_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Stable capability ids. A token is bound to the action it was issued for, so
 * every destructive call site must name its own.
 */
export const CapabilityAction = {
	/** Delete an isolation worktree that still holds uncommitted changes. */
	isolationDiscard: "isolation-discard",
	/** Release an agent registration whose unsaved output has no other copy. */
	agentRelease: "agent-release",
} as const;
export type CapabilityAction = (typeof CapabilityAction)[keyof typeof CapabilityAction];

/** One outstanding authorization. */
interface Grant {
	action: string;
	target: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
}

/** Default `force` parameter name, quoted in refusals when a call site does not override it. */
const DEFAULT_FORCE_PARAM = "force";

/**
 * Thrown instead of performing a destructive operation that was not authorized.
 * Nothing has been destroyed when this is thrown; `token` is a fresh grant for
 * the same action and target, and the message names the parameter to retry with.
 */
export class CapabilityRequiredError extends Error {
	/** Freshly issued one-shot token that authorizes the retry. */
	readonly token: string;
	readonly action: string;
	readonly target: string;
	readonly forceParam: string;

	constructor(message: string, init: { token: string; action: string; target: string; forceParam: string }) {
		super(message);
		this.name = "CapabilityRequiredError";
		this.token = init.token;
		this.action = init.action;
		this.target = init.target;
		this.forceParam = init.forceParam;
	}
}

/** Whether `value` is a capability refusal (destructive call not authorized). */
export function isCapabilityRequiredError(value: unknown): value is CapabilityRequiredError {
	return value instanceof CapabilityRequiredError;
}

/**
 * In-memory grant table. Every method takes the action and target the grant
 * must match, so a leaked token is useless outside its one operation.
 */
export class CapabilityTokenStore {
	readonly #grants = new Map<string, Grant>();
	readonly #ttlMs: number;
	#now: () => number;
	#sequence = 0;

	constructor(options: { ttlMs?: number; now?: () => number } = {}) {
		this.#ttlMs = options.ttlMs ?? CAPABILITY_TOKEN_TTL_MS;
		this.#now = options.now ?? Date.now;
	}

	/** Lifetime of a token, as quoted in refusal messages. */
	get ttlMs(): number {
		return this.#ttlMs;
	}

	/** Number of live grants (expired ones are swept first). */
	get size(): number {
		this.#sweep();
		return this.#grants.size;
	}

	/** Mint a grant for exactly one `action` on one `target`. */
	issue(action: string, target: string): string {
		this.#sweep();
		const token = `${randomBytes(4).toString("hex")}@${(this.#sequence += 1).toString(36)}`;
		const timer = setTimeout(() => this.#grants.delete(token), this.#ttlMs);
		// An unused token must not keep a process (or a test runner) alive.
		timer.unref?.();
		this.#grants.set(token, { action, target, expiresAt: this.#now() + this.#ttlMs, timer });
		return token;
	}

	/** Whether `token` authorizes `action` on `target` right now; never consumes it. */
	check(token: string | undefined, action: string, target: string): boolean {
		const grant = token === undefined ? undefined : this.#live(token.trim(), action, target);
		return grant !== undefined;
	}

	/** Consume `token` for `action` on `target`. Returns false when it is spent, expired, or mismatched. */
	consume(token: string | undefined, action: string, target: string): boolean {
		if (token === undefined) return false;
		const key = token.trim();
		if (!this.#live(key, action, target)) return false;
		this.#drop(key);
		return true;
	}

	/** Test-only: forget every grant (and its timer) and restore the default clock. */
	reset(): void {
		// Map iteration tolerates deleting the entry it is on.
		for (const key of this.#grants.keys()) this.#drop(key);
		this.#now = Date.now;
	}

	/** Test-only: drive expiry from `now` instead of the wall clock. */
	useClock(now?: () => number): void {
		this.#now = now ?? Date.now;
	}

	#live(token: string, action: string, target: string): Grant | undefined {
		const grant = this.#grants.get(token);
		if (!grant) return undefined;
		if (grant.expiresAt <= this.#now()) {
			this.#drop(token);
			return undefined;
		}
		return grant.action === action && grant.target === target ? grant : undefined;
	}

	#drop(token: string): void {
		const grant = this.#grants.get(token);
		if (!grant) return;
		clearTimeout(grant.timer);
		this.#grants.delete(token);
	}

	#sweep(): void {
		const now = this.#now();
		for (const [token, grant] of this.#grants) {
			if (grant.expiresAt <= now) this.#drop(token);
		}
	}
}

/** Process-wide grant table. In-memory by design: authorizations do not outlive the process. */
export const capabilityTokens = new CapabilityTokenStore();

/** Mint a one-shot token for a destructive `action` on `target`. */
export function issueCapabilityToken(action: string, target: string): string {
	return capabilityTokens.issue(action, target);
}

/** Test-only: drop every grant issued by the module-level store. */
export function resetCapabilityTokensForTests(): void {
	capabilityTokens.reset();
}

/** Test-only: drive the module-level store's expiry from `now` (omit to restore the wall clock). */
export function setCapabilityTokenClockForTests(now?: () => number): void {
	capabilityTokens.useClock(now);
}

export interface CapabilityGuardOptions {
	/** Capability the caller must be authorized for; see {@link CapabilityAction}. */
	action: string;
	/** The one thing the operation destroys, named in the refusal. */
	target: string;
	/** Caller-supplied token (the `force` parameter), already trimmed by the call site. */
	force: string | undefined;
	/** What the refused call would destroy, as the refusal's opening clause. */
	consequence: string;
	/** How the caller retries with a token, rendered into the refusal (e.g. `force: "<token>"`). */
	retry: (token: string) => string;
	/** Name of the parameter the token travels in. Defaults to `force`. */
	forceParam?: string;
}

/**
 * Authorize a destructive call, or throw {@link CapabilityRequiredError} with a
 * fresh token. A valid `force` is *not* consumed here: the innermost mutation
 * consumes it, so a chain (tool → job control → lifecycle) spends the token
 * once, at the point of no return.
 */
export function requireCapabilityToken(options: CapabilityGuardOptions): void {
	const { action, target, force, consequence, retry } = options;
	const forceParam = options.forceParam ?? DEFAULT_FORCE_PARAM;
	if (force !== undefined && capabilityTokens.check(force, action, target)) return;

	const token = capabilityTokens.issue(action, target);
	const minutes = Math.round(capabilityTokens.ttlMs / 60_000);
	const rejection =
		force === undefined
			? ""
			: `The supplied token ${JSON.stringify(force)} was rejected: it is expired, already used, or was issued for a different operation. `;
	throw new CapabilityRequiredError(
		`Capability token required: ${consequence}. Nothing was destroyed. ${rejection}Repeat the call with ${retry(token)} — a one-shot capability token bound to "${action}" on ${JSON.stringify(target)}, valid for ${minutes} minutes and single use.`,
		{ token, action, target, forceParam },
	);
}

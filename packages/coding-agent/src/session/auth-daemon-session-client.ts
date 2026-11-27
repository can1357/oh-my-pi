import type { SessionRestrictionLease } from "@oh-my-pi/pi-ai";
import { MAX_AUTH_DAEMON_SESSION_ID_LENGTH } from "./auth-daemon-contract";
import type { AuthDaemonLink } from "./auth-daemon-link";

interface Restriction {
	readonly lease: SessionRestrictionLease;
	token?: string;
	ending?: true;
}

function booleanAcknowledgment(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid daemon auth session acknowledgment");
	return value;
}

/** Session state for a single bound daemon lease. Never replayed onto a replacement link. */
export class AuthDaemonSessions {
	readonly #link: AuthDaemonLink;
	readonly #restrictions = new Map<string, Map<string, Restriction>>();
	#pending: Promise<void> = Promise.resolve();
	#policyFailure?: { error: unknown };

	constructor(link: AuthDaemonLink) {
		this.#link = link;
	}

	pin(
		provider: string,
		sessionId: string,
		credentialId: number,
		options?: { restoredAtMs?: number },
	): Promise<boolean> {
		const restoredAtMs = options?.restoredAtMs;
		const params =
			restoredAtMs === undefined
				? { provider, sessionId, credentialId }
				: { provider, sessionId, credentialId, restoredAtMs };
		return this.#enqueue(async () => booleanAcknowledgment(await this.#link.request("session-pin", params)));
	}

	release(provider: string, sessionId: string): Promise<boolean> {
		return this.#enqueue(async () =>
			booleanAcknowledgment(await this.#link.request("session-release", { provider, sessionId })),
		);
	}

	clear(provider: string, sessionId: string): Promise<void> {
		return this.#enqueue(async () => {
			if ((await this.#link.request("session-clear", { provider, sessionId })) !== true) {
				throw new Error("Invalid daemon auth session clear acknowledgment");
			}
		});
	}

	inherit(
		sourceSessionId: string,
		targetSessionId: string,
		allow?: readonly { provider: string; explicit: boolean }[],
	): Promise<number> {
		const params =
			allow === undefined
				? { sourceSessionId, targetSessionId }
				: {
						sourceSessionId,
						targetSessionId,
						allow: allow.map(({ provider, explicit }) => ({ provider, explicit })),
					};
		return this.#enqueue(async () => {
			const count = await this.#link.request("session-inherit", params);
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
				throw new Error("Invalid daemon auth session inheritance acknowledgment");
			}
			return count;
		});
	}

	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		if (
			!provider ||
			provider.includes(":") ||
			!sessionId ||
			sessionId.length > MAX_AUTH_DAEMON_SESSION_ID_LENGTH ||
			identityKeys.some(key => !key)
		) {
			throw new Error("Invalid daemon auth account restriction");
		}
		const params = { provider, sessionId, identityKeys: [...identityKeys] };
		const restriction: Restriction = { lease: Symbol("sessions.restrict") };
		let sessions = this.#restrictions.get(provider);
		if (sessions === undefined) this.#restrictions.set(provider, (sessions = new Map()));
		sessions.set(sessionId, restriction);
		void this.#enqueue(async () => {
			const token = await this.#link.request("session-restrict", params);
			if (typeof token !== "string" || token.length === 0) {
				throw new Error("Invalid daemon auth session restriction acknowledgment");
			}
			restriction.token = token;
		}, true);
		return restriction.lease;
	}

	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const sessions = this.#restrictions.get(provider);
		const restriction = sessions?.get(sessionId);
		if (!sessions || !restriction || restriction.lease !== lease || restriction.ending) return;
		restriction.ending = true;
		void this.#enqueue(async () => {
			const { token } = restriction;
			if (
				token === undefined ||
				(await this.#link.request("session-unrestrict", { provider, sessionId, token })) !== true
			) {
				throw new Error("Daemon auth session restriction was not lifted");
			}
			if (sessions.get(sessionId) !== restriction) return;
			sessions.delete(sessionId);
			if (sessions.size === 0) this.#restrictions.delete(provider);
		}, true);
	}

	/** Suppress local credentials while a restriction is pending, active, or awaiting removal. */
	isRestricted(provider: string, sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.#restrictions.get(provider)?.has(sessionId) === true;
	}

	/**
	 * Gate key, access and health operations on acknowledged policy updates.
	 * A callback can dispatch an operation without yielding to a newly queued update.
	 */
	settled(): Promise<void>;
	settled<T>(run: () => T | Promise<T>): Promise<T>;
	async settled<T>(run?: () => T | Promise<T>): Promise<T | void> {
		let pending: Promise<void>;
		do {
			pending = this.#pending;
			await pending;
		} while (pending !== this.#pending);
		if (this.#policyFailure) throw this.#policyFailure.error;
		return run?.();
	}

	#enqueue<T>(run: () => Promise<T>, policy = false): Promise<T> {
		const result = this.#pending.then(() => {
			if (this.#policyFailure) throw this.#policyFailure.error;
			return run();
		});
		this.#pending = result.then(
			() => {},
			error => {
				// A missing policy acknowledgment leaves the server's scope unknown.
				if (policy) this.#policyFailure ??= { error };
			},
		);
		return result;
	}
}

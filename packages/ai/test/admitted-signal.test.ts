/**
 * The abort signal an admitted call hands its author in place of the caller's.
 *
 * Bun's `EventTarget` does not carry the async context from `addEventListener`: an author's abort
 * listener runs inside whoever calls `abort()`, in that caller's context — outside the session the
 * author belongs to, and after that session has gone if the abort comes late enough. Contract
 * under test, for the shared {@link AdmittedSignal} and at each host site in this package that
 * hands a signal to a registered provider:
 *
 *   1. A caller already aborted reaches the author aborted before the call, with the same reason.
 *   2. A later abort reaches the author in the same turn, with the caller's reason, as its
 *      session's work.
 *   3. `aborted` and `throwIfAborted` say what the caller's say wherever the author can look.
 *   4. The forwarding listener comes off at the call's terminal, fulfilled or failed: a long-lived
 *      caller signal gathers none, and a later abort reaches no author code.
 *   5. A host registration receives the caller's own signal.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import { AdmittedSignal, callThroughGate, type ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const sessionScope = new AsyncLocalStorage<object>();

interface SessionGate extends ProviderCallGate {
	retired: boolean;
	/** Whether the caller runs as this session's work. */
	readonly inside: boolean;
}

/** A session's gate as the host's is built: its admission is an async context. */
function sessionGate(): SessionGate {
	const session = {};
	const gate: SessionGate = {
		retired: false,
		run<R>(call: () => R): R {
			if (gate.retired) throw new Error("gate retired");
			return sessionScope.run(session, call);
		},
		get inside() {
			return sessionScope.getStore() === session;
		},
	};
	return gate;
}

/** Where an author's listener ran: as its session's work or not, and whether that session had gone. */
interface Ran {
	inside: boolean;
	retired: boolean;
}

function observe(signal: AbortSignal): { aborted: boolean; reason: unknown; thrown: unknown } {
	let thrown: unknown;
	try {
		signal.throwIfAborted();
	} catch (error) {
		thrown = error;
	}
	return { aborted: signal.aborted, reason: signal.reason, thrown };
}

/** The abort listeners `signal` still holds, as its own add/remove calls report them. A `once`
 *  listener that fired is not removed through them, so only use this where nothing aborts. */
function abortListeners(signal: AbortSignal): Set<unknown> {
	const listening = new Set<unknown>();
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = (...args: Parameters<typeof add>) => {
		if (args[0] === "abort") listening.add(args[1]);
		add(...args);
	};
	signal.removeEventListener = (...args: Parameters<typeof remove>) => {
		if (args[0] === "abort") listening.delete(args[1]);
		remove(...args);
	};
	return listening;
}

interface MadeSignal {
	signal: AbortSignal;
	listeners: Set<unknown>;
}

/** Records every signal `AbortSignal[factory]` makes until the test ends, with its listeners. */
function recordSignalsFrom(factory: "any" | "timeout"): MadeSignal[] {
	const made: MadeSignal[] = [];
	const original = AbortSignal[factory] as (...args: unknown[]) => AbortSignal;
	const record = (...args: unknown[]) => {
		const signal = original.apply(AbortSignal, args);
		made.push({ signal, listeners: abortListeners(signal) });
		return signal;
	};
	Object.defineProperty(AbortSignal, factory, { value: record, configurable: true, writable: true });
	cleanups.push(() =>
		Object.defineProperty(AbortSignal, factory, { value: original, configurable: true, writable: true }),
	);
	return made;
}

/** Resolves when `signal` aborts: the event the host's own timer raises. */
function abortOf(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	jest.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("AdmittedSignal", () => {
	test("a caller already aborted reaches the author aborted before the call, with the same reason", () => {
		const gate = sessionGate();
		const caller = new AbortController();
		const reason = { why: "before" };
		caller.abort(reason);
		const listeners = abortListeners(caller.signal);
		const admitted = new AdmittedSignal(gate, caller.signal);

		const seen = callThroughGate(gate, () => observe(admitted.admit()!));

		expect(seen.aborted).toBe(true);
		expect(seen.reason).toBe(reason);
		expect(seen.thrown).toBe(reason);
		expect(listeners.size).toBe(0);
	});

	test("a later abort reaches the author in the same turn, with the caller's reason, as its session's work", () => {
		const gate = sessionGate();
		const caller = new AbortController();
		const admitted = new AdmittedSignal(gate, caller.signal);
		const ran: Array<Ran & { reason: unknown; thrown: unknown }> = [];
		const own = callThroughGate(gate, () => {
			const signal = admitted.admit()!;
			signal.addEventListener("abort", () => {
				const { reason, thrown } = observe(signal);
				ran.push({ inside: gate.inside, retired: gate.retired, reason, thrown });
			});
			return signal;
		});
		const reason = { why: "later" };

		caller.abort(reason);
		// Same turn: nothing was awaited between the abort and this line.
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({ inside: true, retired: false });
		expect(ran[0]!.reason).toBe(reason);
		expect(ran[0]!.thrown).toBe(reason);

		caller.abort({ why: "again" });
		expect(own.reason).toBe(reason);
		expect(ran).toHaveLength(1);
	});

	test("aborted and throwIfAborted say what the caller's say wherever the author can look", async () => {
		const gate = sessionGate();
		const caller = new AbortController();
		const admitted = new AdmittedSignal(gate, caller.signal);
		const points: Array<[string, boolean, boolean]> = [];
		const look = (where: string, own: AbortSignal) => {
			const mine = observe(own);
			const theirs = observe(caller.signal);
			const agree =
				mine.aborted === theirs.aborted && mine.reason === theirs.reason && mine.thrown === theirs.thrown;
			points.push([where, mine.aborted, agree]);
		};
		const aborted = Promise.withResolvers<void>();
		const work = callThroughGate(gate, async () => {
			const own = admitted.admit()!;
			look("call", own);
			own.addEventListener("abort", () => look("listener", own));
			await Promise.resolve();
			look("continuation", own);
			await aborted.promise;
			look("after the abort", own);
		});
		await Promise.resolve();

		caller.abort({ why: "agree" });
		aborted.resolve();
		await work;
		admitted.release();

		expect(points).toEqual([
			["call", false, true],
			["continuation", false, true],
			["listener", true, true],
			["after the abort", true, true],
		]);
	});

	test("release takes the forwarding listener off the caller's signal, and a later abort reaches no author code", () => {
		const gate = sessionGate();
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);
		const admitted = new AdmittedSignal(gate, caller.signal);
		const ran: Ran[] = [];
		const own = callThroughGate(gate, () => {
			const signal = admitted.admit()!;
			signal.addEventListener("abort", () => ran.push({ inside: gate.inside, retired: gate.retired }));
			return signal;
		});
		expect(listeners.size).toBe(1);

		admitted.release();
		admitted.release();
		gate.retired = true;
		caller.abort();

		expect(listeners.size).toBe(0);
		expect(ran).toEqual([]);
		expect(own.aborted).toBe(false);
	});

	test("a call the gate refuses installs no listener, and releasing it is harmless", () => {
		const gate = sessionGate();
		gate.retired = true;
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);
		const admitted = new AdmittedSignal(gate, caller.signal);

		expect(() => callThroughGate(gate, () => admitted.admit())).toThrow("gate retired");
		admitted.release();

		expect(listeners.size).toBe(0);
	});

	test("admitting twice hands out one signal and installs one listener", () => {
		const gate = sessionGate();
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);
		const admitted = new AdmittedSignal(gate, caller.signal);

		const [first, second] = callThroughGate(gate, () => [admitted.admit(), admitted.admit()]);

		expect(second).toBe(first);
		expect(listeners.size).toBe(1);
		admitted.release();
		expect(listeners.size).toBe(0);
	});

	test("a host registration's author is handed the caller's own signal", () => {
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);
		const admitted = new AdmittedSignal(undefined, caller.signal);

		expect(callThroughGate(undefined, () => admitted.admit())).toBe(caller.signal);
		expect(listeners.size).toBe(0);
	});

	test("without a caller signal the author is handed none", () => {
		const gate = sessionGate();
		expect(callThroughGate(gate, () => new AdmittedSignal(gate, undefined).admit())).toBeUndefined();
	});
});

// ─── Host sites ─────────────────────────────────────────────────────────────────────────────────

const PROVIDER = "admitted-signal-provider";
const SOURCE = "admitted-signal-scratch";

/** What the provider's author does with the signal the host hands it, before it answers. */
type Author = (signal: AbortSignal) => Promise<void>;

/** A provider registered at one host site. */
interface Registered {
	/** Calls the provider through the host's entry point with `caller` as the caller's signal;
	 *  `fail` makes the author's work reject after `author` has run. Settles when the host's call
	 *  does, whatever the host answered: the answer is not under test here. */
	call(caller: AbortSignal, fail?: boolean): Promise<void>;
	/** The signal the host handed the provider on the last call, for `caller`: the caller's own,
	 *  or one the host derived from it. */
	handed(caller: AbortSignal): AbortSignal;
	/** The abort listeners that signal still holds, given those on the caller's. */
	listenersLeft(onCaller: Set<unknown>): number;
}

interface SignalSite {
	readonly name: string;
	/** Registers `author` at this site: as `gate`'s provider, or the host's own without a gate. */
	register(gate: SessionGate | undefined, author: Author): Promise<Registered>;
}

function memoryStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry || entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: "oat",
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		accountId: "account",
	};
	return { id: 1, provider: PROVIDER, credential, disabledCause: null };
}

function report(): UsageReport {
	return { provider: PROVIDER, fetchedAt: Date.now(), limits: [], metadata: { accountId: "account" } };
}

/** A storage whose credential rows live in memory, closed when the test ends. */
async function usageStorage(timeoutMs = 60_000): Promise<AuthStorage> {
	const storage = new AuthStorage(memoryStore([oauthRow()]), {
		usageProviderResolver: () => undefined,
		usageRequestTimeoutMs: timeoutMs,
	});
	cleanups.push(() => storage.close());
	await storage.credentials.reload();
	return storage;
}

/** A SQLite storage without refresh leases, so a refresh hands its provider the caller's signal. */
async function oauthStorage(): Promise<AuthStorage> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	Object.assign(store, { tryAcquireCredentialRefreshLease: undefined });
	const storage = new AuthStorage(store);
	cleanups.push(() => {
		unregisterOAuthProviders(SOURCE);
		store.close();
	});
	await storage.credentials.reload();
	return storage;
}

function usageProvider(author: Author, failing: () => boolean): UsageProvider {
	return {
		id: PROVIDER,
		supports: () => true,
		validatesCredentials: true,
		async fetchUsage(params) {
			await author(params.signal!);
			if (failing()) throw new Error("usage failed");
			return report();
		},
	};
}

const fresh = (): OAuthCredentials => ({ access: "fresh", refresh: "refresh", expires: Date.now() + 3_600_000 });

const healthSite: SignalSite = {
	name: "credential health fetchUsage",
	async register(gate, author) {
		const storage = await usageStorage();
		let failing = false;
		storage.usage.setProvider(
			PROVIDER,
			usageProvider(author, () => failing),
			undefined,
			gate,
		);
		// The health check hands its provider a signal it combines from the caller's and a timeout.
		const combined = recordSignalsFrom("any");
		return {
			async call(caller, fail = false) {
				failing = fail;
				await storage.health.check({ signal: caller, timeoutMs: 60_000 });
			},
			handed: () => combined.at(-1)!.signal,
			listenersLeft: () => combined.at(-1)!.listeners.size,
		};
	},
};

const refreshSite: SignalSite = {
	name: "OAuth refreshToken",
	async register(gate, author) {
		const storage = await oauthStorage();
		let failing = false;
		registerOAuthProvider(
			{
				name: "Admitted Signal",
				login: async () => fresh(),
				async refreshToken(_credentials, signal) {
					await author(signal!);
					if (failing) throw new Error("refresh failed");
					return fresh();
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);
		return {
			async call(caller, fail = false) {
				failing = fail;
				await storage.credentials.set(PROVIDER, [
					{ type: "oauth", access: "stale", refresh: "refresh", expires: Date.now() - 1_000 },
				]);
				await storage.keys.get(PROVIDER, "admitted-signal-session", { signal: caller }).catch(() => undefined);
			},
			handed: caller => caller,
			listenersLeft: onCaller => onCaller.size,
		};
	},
};

const loginSite: SignalSite = {
	name: "OAuth login",
	async register(gate, author) {
		const storage = await oauthStorage();
		let failing = false;
		registerOAuthProvider(
			{
				name: "Admitted Signal",
				async login(callbacks) {
					await author(callbacks.signal!);
					if (failing) throw new Error("login failed");
					return fresh();
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);
		return {
			async call(caller, fail = false) {
				failing = fail;
				await storage.oauth
					.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "", signal: caller })
					.catch(() => undefined);
			},
			handed: caller => caller,
			listenersLeft: onCaller => onCaller.size,
		};
	},
};

describe.each([healthSite, refreshSite, loginSite])("the signal the host hands $name", site => {
	test("an abort during the call reaches the author's listener as its session's work, with the caller's reason", async () => {
		const gate = sessionGate();
		const entered = Promise.withResolvers<void>();
		const ran: Array<Ran & { reason: unknown }> = [];
		const provider = await site.register(gate, signal => {
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener(
				"abort",
				() => {
					ran.push({ inside: gate.inside, retired: gate.retired, reason: signal.reason });
					aborted.resolve();
				},
				{ once: true },
			);
			entered.resolve();
			return aborted.promise;
		});
		const caller = new AbortController();
		const reason = new Error("caller aborted");

		const call = provider.call(caller.signal);
		await entered.promise;
		caller.abort(reason);
		await call;

		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({ inside: true, retired: false });
		expect(ran[0]!.reason).toBe(reason);
	});

	test("once the call is over and its session gone, an abort reaches no author listener", async () => {
		const gate = sessionGate();
		const ran: Ran[] = [];
		let calls = 0;
		const provider = await site.register(gate, async signal => {
			calls++;
			signal.addEventListener("abort", () => ran.push({ inside: gate.inside, retired: gate.retired }), {
				once: true,
			});
		});
		const caller = new AbortController();

		await provider.call(caller.signal);
		gate.retired = true;
		caller.abort("after the terminal");

		expect(calls).toBe(1);
		expect(ran).toEqual([]);
	});

	test("the signal it hands keeps no listener after a call, fulfilled or failed", async () => {
		const gate = sessionGate();
		let calls = 0;
		const provider = await site.register(gate, async signal => {
			calls++;
			signal.addEventListener("abort", () => {});
		});
		const caller = new AbortController();
		const onCaller = abortListeners(caller.signal);
		const left: number[] = [];

		for (let round = 0; round < 3; round++) {
			await provider.call(caller.signal);
			left.push(provider.listenersLeft(onCaller));
			await provider.call(caller.signal, true);
			left.push(provider.listenersLeft(onCaller));
		}

		expect(calls).toBe(6);
		expect(left).toEqual([0, 0, 0, 0, 0, 0]);
	});

	test("a host registration is handed the caller's own signal", async () => {
		const handed: AbortSignal[] = [];
		const provider = await site.register(undefined, async signal => {
			handed.push(signal);
		});
		const caller = new AbortController();

		await provider.call(caller.signal);

		expect(handed).toHaveLength(1);
		expect(handed[0]).toBe(provider.handed(caller.signal));
	});
});

describe("the other callbacks the host hands a login", () => {
	// Only the signal dispatches into the author from the host's side. The rest are host functions
	// the author calls; what they return, the author awaits as its own work, wherever the host
	// settles it from.
	test("a host callback's answer, settled from outside any session, resumes the author as its session's work", async () => {
		const gate = sessionGate();
		const storage = await oauthStorage();
		const prompted = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string>();
		const resumed: Ran[] = [];
		registerOAuthProvider(
			{
				name: "Prompting",
				async login(callbacks) {
					await callbacks.onPrompt({ message: "code" });
					resumed.push({ inside: gate.inside, retired: gate.retired });
					return fresh();
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);

		const login = storage.oauth.login(PROVIDER, {
			onAuth: () => {},
			onPrompt: () => {
				prompted.resolve();
				return answer.promise;
			},
		});
		await prompted.promise;
		answer.resolve("pasted");
		await login;

		expect(resumed).toEqual([{ inside: true, retired: false }]);
	});
});

describe("the timeout signal the usage service hands fetchUsage", () => {
	// The host's own timer aborts this signal, long after a quick call is over: the listener it
	// reaches is the furthest from the call site of any the host hands out.
	const TIMEOUT_MS = 20;

	test("a timeout during the call reaches the author's listener as its session's work", async () => {
		const timeouts = recordSignalsFrom("timeout");
		const gate = sessionGate();
		const storage = await usageStorage(TIMEOUT_MS);
		const ran: Array<Ran & { reason: unknown }> = [];
		storage.usage.setProvider(
			PROVIDER,
			usageProvider(
				signal => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener(
						"abort",
						() => {
							ran.push({ inside: gate.inside, retired: gate.retired, reason: signal.reason });
							aborted.resolve();
						},
						{ once: true },
					);
					return aborted.promise;
				},
				() => false,
			),
			undefined,
			gate,
		);

		await storage.usage.reports({ provider: PROVIDER });

		expect(timeouts).toHaveLength(1);
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({ inside: true, retired: false });
		expect(ran[0]!.reason).toBe(timeouts[0]!.signal.reason);
	});

	test("a timeout after the call is over and its session gone reaches no author listener", async () => {
		const timeouts = recordSignalsFrom("timeout");
		const gate = sessionGate();
		const storage = await usageStorage(TIMEOUT_MS);
		const ran: Ran[] = [];
		let calls = 0;
		storage.usage.setProvider(
			PROVIDER,
			usageProvider(
				async signal => {
					calls++;
					signal.addEventListener("abort", () => ran.push({ inside: gate.inside, retired: gate.retired }), {
						once: true,
					});
				},
				() => false,
			),
			undefined,
			gate,
		);

		await storage.usage.reports({ provider: PROVIDER });
		gate.retired = true;
		expect(timeouts).toHaveLength(1);
		// Registered after the author's, so it runs after any author listener the timeout reaches.
		await abortOf(timeouts[0]!.signal);

		expect(calls).toBe(1);
		expect(ran).toEqual([]);
	});

	test.each([false, true])("the timeout signal keeps no listener after a call (failed: %p)", async fails => {
		const timeouts = recordSignalsFrom("timeout");
		const gate = sessionGate();
		const storage = await usageStorage();
		let calls = 0;
		storage.usage.setProvider(
			PROVIDER,
			usageProvider(
				async signal => {
					calls++;
					signal.addEventListener("abort", () => {});
				},
				() => fails,
			),
			undefined,
			gate,
		);

		await storage.usage.reports({ provider: PROVIDER });

		expect(calls).toBe(1);
		expect(timeouts.map(made => made.listeners.size)).toEqual([0]);
	});

	test("a host registration is handed the host's timeout signal itself", async () => {
		const timeouts = recordSignalsFrom("timeout");
		const storage = await usageStorage();
		const handed: AbortSignal[] = [];
		storage.usage.setProvider(
			PROVIDER,
			usageProvider(
				async signal => {
					handed.push(signal);
				},
				() => false,
			),
		);

		await storage.usage.reports({ provider: PROVIDER });

		expect(timeouts).toHaveLength(1);
		expect(handed).toEqual([timeouts[0]!.signal]);
		expect(handed[0]).toBe(timeouts[0]!.signal);
	});
	// `supports` is the first author code this path reaches, and it is handed the request. The
	// bridge therefore has to exist before it, not after: built later, this one call saw the raw
	// timeout signal and a listener left on it outlived the session that registered the provider.
	test("the support check is handed the bridged signal, and its listener dies with the session", async () => {
		const timeouts = recordSignalsFrom("timeout");
		const gate = sessionGate();
		const storage = await usageStorage(TIMEOUT_MS);
		const seenBySupports: AbortSignal[] = [];
		const ran: Ran[] = [];
		storage.usage.setProvider(
			PROVIDER,
			{
				id: PROVIDER,
				supports: params => {
					if (params.signal) {
						seenBySupports.push(params.signal);
						params.signal.addEventListener(
							"abort",
							() => ran.push({ inside: gate.inside, retired: gate.retired }),
							{ once: true },
						);
					}
					return true;
				},
				fetchUsage: async () => report(),
			},
			undefined,
			gate,
		);

		await storage.usage.reports({ provider: PROVIDER });
		expect(timeouts).toHaveLength(1);
		expect(seenBySupports).toHaveLength(1);
		// Not the host's own timeout signal: the one its session answers for.
		expect(seenBySupports[0]).not.toBe(timeouts[0]!.signal);

		// The call is over and the session has gone; the host's timer fires on its own schedule.
		gate.retired = true;
		await abortOf(timeouts[0]!.signal);
		expect(ran).toEqual([]);
	});
});

describe("a refresh that outlasts the host's wait", () => {
	test("still hears the caller's abort as its session's work until the exchange itself settles", async () => {
		const gate = sessionGate();
		const storage = await oauthStorage();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const ran: Ran[] = [];
		registerOAuthProvider(
			{
				name: "Slow Refresh",
				login: async () => fresh(),
				async refreshToken(_credentials, signal) {
					signal!.addEventListener("abort", () => ran.push({ inside: gate.inside, retired: gate.retired }), {
						once: true,
					});
					entered.resolve();
					await finish.promise;
					return fresh();
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "refresh", expires: Date.now() - 1_000 },
		]);
		const caller = new AbortController();
		jest.useFakeTimers();

		const wait = storage.keys
			.get(PROVIDER, "admitted-signal-session", { signal: caller.signal })
			.catch(() => undefined);
		await entered.promise;
		// The host stops waiting at its refresh budget; the exchange it started runs on.
		jest.advanceTimersByTime(60_000);
		jest.useRealTimers();
		await wait;
		caller.abort("after the wait");
		finish.resolve();

		expect(ran).toEqual([{ inside: true, retired: false }]);
	});
});

describe("a refreshToken that throws before it returns", () => {
	test("leaves no listener on the caller's signal", async () => {
		const gate = sessionGate();
		const storage = await oauthStorage();
		let calls = 0;
		registerOAuthProvider(
			{
				name: "Throwing Refresh",
				login: async () => fresh(),
				refreshToken(_credentials, signal) {
					calls++;
					signal!.addEventListener("abort", () => {});
					throw new Error("refresh threw");
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "refresh", expires: Date.now() - 1_000 },
		]);
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);

		await storage.keys.get(PROVIDER, "admitted-signal-session", { signal: caller.signal }).catch(() => undefined);

		expect(calls).toBe(1);
		expect(listeners.size).toBe(0);
	});
});

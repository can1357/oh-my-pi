import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";

interface TestGate extends ProviderCallGate {
	retired: boolean;
	readonly inside: boolean;
}

function makeGate(): TestGate {
	let depth = 0;
	const gate: TestGate = {
		retired: false,
		run<R>(call: () => R): R {
			if (gate.retired) throw new Error("gate retired");
			depth++;
			try {
				return call();
			} finally {
				depth--;
			}
		},
		get inside() {
			return depth > 0;
		},
	};
	return gate;
}

const SOURCE = "callsite-gate-scratch";
const PROVIDER = "callsite-gate-provider";

/** An extension provider written as a frozen class instance with private fields and getters and
 *  no `id`/`sourceId`: every shape the earlier wrapping schemes broke. */
class AuthoredProvider {
	readonly #label: string;
	readonly #gate: TestGate;
	readonly #log: string[];
	constructor(label: string, gate: TestGate, log: string[]) {
		this.#label = label;
		this.#gate = gate;
		this.#log = log;
		Object.freeze(this);
	}
	#note(what: string): void {
		this.#log.push(`${this.#label}.${what}:${this.#gate.inside}`);
	}
	get name(): string {
		this.#note("name");
		return this.#label;
	}
	get storeCredentialsAs(): string | undefined {
		this.#note("storeCredentialsAs");
		return undefined;
	}
	get login() {
		this.#note("login-read");
		return async (_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
			return { access: `${this.#label}-login`, refresh: `${this.#label}-refresh`, expires: Date.now() + 3_600_000 };
		};
	}
	get refreshToken() {
		this.#note("refreshToken-read");
		return async (credentials: OAuthCredentials): Promise<OAuthCredentials> => {
			this.#note("refreshToken-call");
			return { ...credentials, access: `${this.#label}-refreshed`, expires: Date.now() + 3_600_000 };
		};
	}
	get getApiKey() {
		this.#note("getApiKey-read");
		return (credentials: OAuthCredentials): string => {
			this.#note("getApiKey-call");
			return `${this.#label}:${credentials.access}`;
		};
	}
}

/** Same shape as methods on the prototype, to prove the receiver is the provider object. */
class MethodProvider {
	readonly #secret = "method-secret";
	readonly name = "Method Provider";
	async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return { access: this.#secret, refresh: this.#secret, expires: Date.now() + 3_600_000 };
	}
	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return { ...credentials, access: `${this.#secret}-refreshed`, expires: Date.now() + 3_600_000 };
	}
	getApiKey(credentials: OAuthCredentials): string {
		return `${this.#secret}:${credentials.access}`;
	}
}

describe("custom OAuth call sites run through the gate on the author's object", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(() => {
		unregisterOAuthProviders(SOURCE);
		store.close();
	});

	test("login, refresh and getApiKey: every author read and call happens inside the gate", async () => {
		const log: string[] = [];
		const gate = makeGate();
		registerOAuthProvider(new AuthoredProvider("solo", gate, log), { id: PROVIDER, sourceId: SOURCE, gate });
		expect(log).toEqual([]);

		await storage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
		expect(log).toEqual(["solo.login-read:true", "solo.storeCredentialsAs:true", "solo.login-read:true"]);

		// Force a refresh: store an expired credential.
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);
		log.length = 0;
		const apiKey = await storage.keys.get(PROVIDER, "callsite-session");
		expect(apiKey).toBe("solo:solo-refreshed");
		expect(log.length).toBeGreaterThan(0);
		expect(log.every(entry => entry.endsWith(":true"))).toBe(true);
		expect(log).toContain("solo.refreshToken-call:true");
		expect(log).toContain("solo.getApiKey-call:true");
	});

	test("a retired child's provider never runs; the parent's earlier registration answers", async () => {
		const log: string[] = [];
		const parent = makeGate();
		const child = makeGate();
		registerOAuthProvider(new AuthoredProvider("parent", parent, log), {
			id: PROVIDER,
			sourceId: SOURCE,
			gate: parent,
		});
		registerOAuthProvider(new AuthoredProvider("child", child, log), { id: PROVIDER, sourceId: SOURCE, gate: child });
		child.retired = true;

		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);
		const apiKey = await storage.keys.get(PROVIDER, "callsite-session");
		expect(apiKey).toBe("parent:parent-refreshed");
		expect(log.some(entry => entry.startsWith("child."))).toBe(false);
		expect(log.every(entry => entry.endsWith(":true"))).toBe(true);

		log.length = 0;
		await storage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
		expect(log.some(entry => entry.startsWith("child."))).toBe(false);
	});

	test("prototype methods keep the provider as receiver (private fields work)", async () => {
		const gate = makeGate();
		registerOAuthProvider(new MethodProvider(), { id: PROVIDER, sourceId: SOURCE, gate });
		await storage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);
		expect(await storage.keys.get(PROVIDER, "callsite-session")).toBe("method-secret:method-secret-refreshed");
	});

	test("a provider without refreshToken still reports the same configuration error, read inside the gate", async () => {
		const gate = makeGate();
		let readInside: boolean | undefined;
		registerOAuthProvider(
			{
				name: "No Refresh",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
				get refreshToken() {
					readInside = gate.inside;
					return undefined;
				},
			},
			{ id: PROVIDER, sourceId: SOURCE, gate },
		);
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "stale", refresh: "stale-refresh", expires: Date.now() - 1_000 },
		]);
		await storage.keys.get(PROVIDER, "callsite-session");
		expect(readInside).toBe(true);
	});
});

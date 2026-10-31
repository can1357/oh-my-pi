/**
 * Scoped auth-gateway clients.
 *
 * A holder of the gateway token may call every served model, and recovery may
 * serve it from any broker credential. A scoped client authenticates with its
 * own bearer, configured only as a SHA-256 digest, and is limited to:
 *
 * - `models`: the served models it may call, as exact `provider/id` grants or
 *   `provider/*`. Absent allows every served model; `[]` allows none.
 * - `accounts`: per provider, the broker OAuth accounts (identity keys, as in
 *   account pools) its requests may use. A listed provider never falls back to
 *   a sibling account or an API key; an empty list allows no account. When
 *   present, it is also a provider allow-list: a provider it omits is refused,
 *   so a binding can never be bypassed through another provider's accounts.
 *
 * Account binding reuses `AuthStorage.sessions.restrict`. Each admitted
 * version of a client (its token, models and accounts) resolves a bound
 * provider's credentials under a session id of its own, restricted before the
 * token is admitted. A reload that changes any of them admits a new version
 * under a new session; requests the old version admitted keep resolving under
 * the old restriction until they finish, and only then is it lifted. A
 * version's requests share that session's account pin.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionRestrictionLease, SessionsApi } from "../auth/types";
import type { Api, Model } from "../types";

/** One scoped client. */
export interface AuthGatewayClient {
	/** Operator-chosen name, logged with the client's requests. */
	name: string;
	/** Hex SHA-256 digest of the client's bearer token. */
	tokenSha256: string;
	/** `provider/id` or `provider/*` grants; absent allows every served model, `[]` none. */
	models?: readonly string[];
	/** Provider id → OAuth identity keys the client's requests to that provider may use. */
	accounts?: Readonly<Record<string, readonly string[]>>;
}

/** An admitted scoped client, as the gateway's routes see it. */
export interface AuthGatewayClientScope {
	readonly name: string;
	/** False when the client may call every served model. */
	readonly limitsModels: boolean;
	/** Whether the client may call `model`. */
	allows(model: Model<Api>): boolean;
	/**
	 * Session id the client's credential lookups for `provider` resolve under:
	 * its own restricted session when `accounts` lists the provider, otherwise
	 * the request's `sessionId`. Throws for a provider `accounts` omits, and for
	 * a bound provider once the restriction is lifted, so a lookup can never
	 * resolve unrestricted on the client's behalf.
	 */
	credentialSessionId(provider: string, sessionId: string): string;
	/**
	 * Hold the client's account restriction while a request uses it; call the
	 * returned release once the request can no longer resolve a credential. A
	 * reload that retires the client lifts the restriction only after every
	 * hold is released. Take the first hold in the same tick as
	 * `authenticate`, before a reload can retire the client.
	 */
	retain(): () => void;
}

const CLIENT_FIELDS: Record<string, true> = { tokenSha256: true, models: true, accounts: true };
const SHA256_HEX = /^[0-9a-f]{64}$/i;
// C0 controls and DEL: a name is logged verbatim.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function invalid(where: string, problem: string): Error {
	return new Error(`Invalid auth-gateway clients: ${where}: ${problem}`);
}

/**
 * Parse a clients file: a JSON object mapping each client name to
 * `{ tokenSha256, models?, accounts? }`. Any malformed entry or unknown field
 * rejects the whole file, since a misspelled `models` would otherwise allow
 * every model. Errors name the offending field, never its value.
 */
export function parseAuthGatewayClients(text: string): AuthGatewayClient[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid auth-gateway clients: not valid JSON");
	}
	if (!isRecord(value)) {
		throw new Error("Invalid auth-gateway clients: expected an object mapping each client name to its entry");
	}
	const clients: AuthGatewayClient[] = [];
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) throw invalid(name, "expected an object");
		for (const field of Object.keys(entry)) {
			if (!Object.hasOwn(CLIENT_FIELDS, field)) throw invalid(name, `unknown field "${field}"`);
		}
		const { tokenSha256, models, accounts } = entry;
		if (typeof tokenSha256 !== "string") throw invalid(`${name}.tokenSha256`, "expected a hex SHA-256 digest");
		const client: AuthGatewayClient = { name, tokenSha256 };
		if (models !== undefined) {
			if (!Array.isArray(models) || !models.every((grant): grant is string => typeof grant === "string")) {
				throw invalid(`${name}.models`, 'expected a list of "provider/id" or "provider/*" grants');
			}
			client.models = models;
		}
		if (accounts !== undefined) {
			if (!isRecord(accounts))
				throw invalid(`${name}.accounts`, "expected an object mapping provider to identity keys");
			// Null prototype: a provider named `__proto__` stays an own entry.
			const pools: Record<string, readonly string[]> = Object.create(null);
			for (const [provider, keys] of Object.entries(accounts)) {
				if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) {
					throw invalid(`${name}.accounts.${provider}`, "expected a list of OAuth identity keys");
				}
				pools[provider] = keys;
			}
			client.accounts = pools;
		}
		clients.push(client);
	}
	// Validate every entry here too, so a bad file fails where it is read.
	compileClients(clients);
	return clients;
}

/** Hex SHA-256 digest of a bearer token, as `tokenSha256` records it. */
export function hashAuthGatewayToken(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

type RestrictionSessions = Pick<SessionsApi, "restrict" | "unrestrict">;

/** A validated client: its model grants compiled, its accounts restricted while it is admitted or still serving. */
class ClientScope implements AuthGatewayClientScope {
	readonly name: string;
	readonly tokenSha256: string;
	readonly limitsModels: boolean;
	/** Equal for the same entry read again, so a reload that leaves it unchanged keeps the scope and its pin. */
	readonly policy: string;
	/** Exact `provider/id` grants. */
	readonly #models = new Set<string>();
	/** Providers granted with `provider/*`. */
	readonly #providers = new Set<string>();
	readonly #accounts = new Map<string, readonly string[]>();
	/** Whether `models` was given; absent allows every served model `accounts` permits. */
	readonly #grantsModels: boolean;
	/** Whether `accounts` was given, which makes it a provider allow-list too. */
	readonly #bindsAccounts: boolean;
	readonly #sessionId = crypto.randomUUID();
	#leases: Array<[provider: string, lease: SessionRestrictionLease]> = [];
	#sessions: RestrictionSessions | undefined;
	#holds = 0;
	#retired = false;
	#released = false;

	constructor(client: AuthGatewayClient) {
		const { name } = client;
		if (typeof name !== "string" || name.length === 0 || CONTROL_CHARACTER.test(name)) {
			throw new Error("Invalid auth-gateway clients: a client name must be non-empty text");
		}
		if (!SHA256_HEX.test(client.tokenSha256)) throw invalid(`${name}.tokenSha256`, "expected 64 hex digits");
		this.name = name;
		this.tokenSha256 = client.tokenSha256.toLowerCase();
		this.#grantsModels = client.models !== undefined;
		this.#bindsAccounts = client.accounts !== undefined;
		this.limitsModels = this.#grantsModels || this.#bindsAccounts;
		for (const grant of client.models ?? []) {
			const slash = grant.indexOf("/");
			const provider = grant.slice(0, slash);
			const id = grant.slice(slash + 1);
			if (
				slash <= 0 ||
				id.length === 0 ||
				provider.trim() !== provider ||
				id.trim() !== id ||
				(id.includes("*") && id !== "*")
			) {
				throw invalid(`${name}.models`, 'each grant must be "provider/id" or "provider/*"');
			}
			if (id === "*") this.#providers.add(provider);
			else this.#models.add(grant);
		}
		for (const [provider, keys] of Object.entries(client.accounts ?? {})) {
			// A provider id that matches no request would leave that provider unbound, so it must be exact.
			if (provider.length === 0 || provider.trim() !== provider) {
				throw invalid(`${name}.accounts`, "a provider id must be non-empty with no surrounding whitespace");
			}
			if (!keys.every(key => key.length > 0 && key.trim() === key)) {
				throw invalid(`${name}.accounts`, 'expected identity keys such as "email:you@example.com|org:<org-id>"');
			}
			this.#accounts.set(provider, keys);
		}
		if (this.#bindsAccounts) {
			// A grant `accounts` cannot serve is a typo or a misunderstanding; refusing it at load beats a silent 404.
			const granted = [...this.#providers, ...Array.from(this.#models, grant => grant.slice(0, grant.indexOf("/")))];
			const unbound = granted.find(provider => !this.#accounts.has(provider));
			if (unbound !== undefined) {
				throw invalid(`${name}.models`, `grants provider "${unbound}", which "accounts" does not list`);
			}
		}
		this.policy = JSON.stringify([name, this.tokenSha256, client.models ?? null, client.accounts ?? null]);
	}

	allows(model: Model<Api>): boolean {
		if (this.#bindsAccounts && !this.#accounts.has(model.provider)) return false;
		if (!this.#grantsModels) return true;
		return this.#providers.has(model.provider) || this.#models.has(`${model.provider}/${model.id}`);
	}

	credentialSessionId(provider: string, sessionId: string): string {
		if (!this.#bindsAccounts) return sessionId;
		if (!this.#accounts.has(provider)) {
			throw new Error(`auth-gateway client ${this.name} is not bound to provider ${provider}`);
		}
		if (this.#released) throw new Error(`auth-gateway client ${this.name} was retired`);
		return this.#sessionId;
	}

	retain(): () => void {
		this.#holds++;
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			this.#holds--;
			this.#releaseIfDone();
		};
	}

	/** Restrict this scope's session to its accounts. */
	restrict(sessions: RestrictionSessions): void {
		this.#sessions = sessions;
		for (const [provider, keys] of this.#accounts) {
			this.#leases.push([provider, sessions.restrict(provider, this.#sessionId, keys)]);
		}
	}

	/** No longer admitted: lift the restriction once the last request holding it is done. */
	retire(): void {
		this.#retired = true;
		this.#releaseIfDone();
	}

	#releaseIfDone(): void {
		if (!this.#retired || this.#holds > 0) return;
		this.#released = true;
		for (const [provider, lease] of this.#leases) this.#sessions?.unrestrict(provider, this.#sessionId, lease);
		this.#leases = [];
	}
}

/** Validate `clients` as one table and compile it, keyed by token digest. */
function compileClients(clients: readonly AuthGatewayClient[]): Map<string, ClientScope> {
	const compiled = new Map<string, ClientScope>();
	const names = new Set<string>();
	for (const client of clients) {
		const scope = new ClientScope(client);
		if (names.has(scope.name)) throw invalid(scope.name, "duplicate client name");
		if (compiled.has(scope.tokenSha256)) throw invalid(scope.name, "another client has the same tokenSha256");
		names.add(scope.name);
		compiled.set(scope.tokenSha256, scope);
	}
	return compiled;
}

/**
 * The scoped clients one gateway admits, looked up by the digest of the
 * presented bearer.
 */
export class AuthGatewayClientTable {
	readonly #sessions: RestrictionSessions;
	/** Digests of the gateway's own tokens, which no client may claim. */
	readonly #reserved: ReadonlySet<string>;
	#byDigest = new Map<string, ClientScope>();
	#closed = false;

	constructor(sessions: RestrictionSessions, gatewayTokens: Iterable<string>) {
		this.#sessions = sessions;
		this.#reserved = new Set(Array.from(gatewayTokens, hashAuthGatewayToken));
	}

	/**
	 * Replace the admitted clients. An invalid table throws and changes
	 * nothing. An unchanged client keeps its scope; a new or changed one is
	 * restricted before its token is admitted; the scopes left out are retired.
	 * Ignored once the table is closed.
	 */
	set(clients: readonly AuthGatewayClient[]): void {
		if (this.#closed) return;
		const next = compileClients(clients);
		for (const scope of next.values()) {
			if (this.#reserved.has(scope.tokenSha256)) {
				throw invalid(scope.name, "tokenSha256 is the gateway token's digest; give the client its own token");
			}
		}
		for (const [digest, scope] of next) {
			const current = this.#byDigest.get(digest);
			if (current?.policy === scope.policy) next.set(digest, current);
			else scope.restrict(this.#sessions);
		}
		const previous = this.#byDigest;
		this.#byDigest = next;
		for (const [digest, scope] of previous) {
			if (next.get(digest) !== scope) scope.retire();
		}
	}

	/** The client `token` authenticates, if any. */
	authenticate(token: string): AuthGatewayClientScope | undefined {
		return this.#byDigest.get(hashAuthGatewayToken(token));
	}

	/** Admit no more clients and retire every scope. */
	close(): void {
		this.#closed = true;
		for (const scope of this.#byDigest.values()) scope.retire();
		this.#byDigest = new Map();
	}
}

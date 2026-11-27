import { isDeepStrictEqual } from "node:util";
import type { StoredCredentialSummary } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { isAuthDaemonCredentialId } from "./auth-daemon-contract";
import type { AuthDaemonLink } from "./auth-daemon-link";

export interface AuthDaemonProviderAvailability {
	readonly has: boolean;
	readonly hasOAuth: boolean;
	readonly hasSubscription: boolean;
	readonly keyless: boolean;
	readonly keylessCredentialIds: readonly number[];
	readonly credentials: readonly Readonly<StoredCredentialSummary>[];
}

export type AuthDaemonAvailabilityTable = Readonly<Record<string, AuthDaemonProviderAvailability>>;

interface ScopedAvailability {
	readonly sessionId: string;
	readonly providers?: readonly string[];
}

const EMPTY_SUMMARIES: AuthDaemonProviderAvailability["credentials"] = Object.freeze([]);
const EMPTY_KEYLESS_IDS: readonly number[] = Object.freeze([]);
const UNAVAILABLE: AuthDaemonProviderAvailability = Object.freeze({
	has: false,
	hasOAuth: false,
	hasSubscription: false,
	keyless: false,
	keylessCredentialIds: EMPTY_KEYLESS_IDS,
	credentials: EMPTY_SUMMARIES,
});
const REPLY_FIELDS = { providers: true } as const;
const AVAILABILITY_FIELDS = {
	has: true,
	hasOAuth: true,
	hasSubscription: true,
	keyless: true,
	keylessCredentialIds: true,
	credentials: true,
} as const;
const SUMMARY_FIELDS = { id: true, provider: true, disabled: true, type: true } as const;
const API_KEY_FIELDS = { ...SUMMARY_FIELDS, source: true } as const;
const OAUTH_TEXT_FIELDS = {
	accountId: true,
	email: true,
	projectId: true,
	orgId: true,
	orgName: true,
	enterpriseUrl: true,
	region: true,
} as const;
const OAUTH_FIELDS = {
	...SUMMARY_FIELDS,
	...OAUTH_TEXT_FIELDS,
	expires: true,
	refreshExpires: true,
	authorizedAt: true,
	inferenceRegion: true,
	accessOff: true,
	fileUploadAllowed: true,
} as const;

function invalidAvailability(): never {
	throw new Error("Invalid daemon auth availability reply");
}

function fields(value: unknown, allowed: Readonly<Record<string, true>>): Record<string, unknown> {
	if (!isRecord(value)) invalidAvailability();
	for (const key in value) {
		if (Object.hasOwn(value, key) && !Object.hasOwn(allowed, key)) invalidAvailability();
	}
	return value;
}

function optionalTimestamp(value: unknown): number | undefined {
	if (value === undefined || (typeof value === "number" && Number.isFinite(value))) return value;
	return invalidAvailability();
}

function parseSummary(value: unknown, provider: string): Readonly<StoredCredentialSummary> {
	if (!isRecord(value)) invalidAvailability();
	const { id, disabled, type } = value;
	if (!isAuthDaemonCredentialId(id) || value.provider !== provider || typeof disabled !== "boolean") {
		invalidAvailability();
	}
	if (type === "api_key") {
		const { source } = fields(value, API_KEY_FIELDS);
		if (source !== undefined && source !== "login") invalidAvailability();
		return Object.freeze({ id, provider, disabled, type, source });
	}
	if (type !== "oauth") invalidAvailability();
	const { expires, refreshExpires, authorizedAt, inferenceRegion, accessOff, fileUploadAllowed } = fields(
		value,
		OAUTH_FIELDS,
	);
	if (
		typeof accessOff !== "boolean" ||
		typeof fileUploadAllowed !== "boolean" ||
		(inferenceRegion !== undefined &&
			inferenceRegion !== "global" &&
			inferenceRegion !== "eu" &&
			inferenceRegion !== "us")
	) {
		invalidAvailability();
	}
	const summary: Extract<StoredCredentialSummary, { type: "oauth" }> = {
		id,
		provider,
		disabled,
		type,
		expires: optionalTimestamp(expires),
		refreshExpires: optionalTimestamp(refreshExpires),
		authorizedAt: optionalTimestamp(authorizedAt),
		inferenceRegion,
		accessOff,
		fileUploadAllowed,
	};
	for (const field in OAUTH_TEXT_FIELDS) {
		const key = field as keyof typeof OAUTH_TEXT_FIELDS;
		const text = value[key];
		if (text !== undefined) {
			if (typeof text !== "string") invalidAvailability();
			summary[key] = text;
		}
	}
	return Object.freeze(summary);
}

function parseAvailability(value: unknown): AuthDaemonAvailabilityTable {
	const { providers } = fields(value, REPLY_FIELDS);
	if (!isRecord(providers)) invalidAvailability();
	const table: Record<string, AuthDaemonProviderAvailability> = Object.create(null);
	for (const provider in providers) {
		if (!Object.hasOwn(providers, provider)) continue;
		const { has, hasOAuth, hasSubscription, keyless, keylessCredentialIds, credentials } = fields(
			providers[provider],
			AVAILABILITY_FIELDS,
		);
		if (
			!provider ||
			typeof has !== "boolean" ||
			typeof hasOAuth !== "boolean" ||
			typeof hasSubscription !== "boolean" ||
			typeof keyless !== "boolean" ||
			!Array.isArray(keylessCredentialIds) ||
			!Array.isArray(credentials)
		) {
			invalidAvailability();
		}
		const summaries: Readonly<StoredCredentialSummary>[] = [];
		const candidateIds = keylessCredentialIds.length > 0 ? new Set<number>() : undefined;
		for (const credential of credentials) {
			const summary = parseSummary(credential, provider);
			summaries.push(summary);
			if (summary.type === "api_key") candidateIds?.add(summary.id);
		}
		const keylessIds: number[] = [];
		for (const id of keylessCredentialIds) {
			if (typeof id !== "number" || !candidateIds?.delete(id)) invalidAvailability();
			keylessIds.push(id);
		}
		table[provider] = Object.freeze({
			has,
			hasOAuth,
			hasSubscription,
			keyless,
			keylessCredentialIds: keylessIds.length ? Object.freeze(keylessIds) : EMPTY_KEYLESS_IDS,
			credentials: summaries.length ? Object.freeze(summaries) : EMPTY_SUMMARIES,
		});
	}
	return Object.freeze(table);
}

/** Live, secret-free metadata for the daemon-managed providers on a bound link. */
export class AuthDaemonMetadata {
	readonly #link: AuthDaemonLink;
	readonly #unsubscribe: () => void;
	readonly #listeners = new Set<(generation: number) => void>();
	#table: AuthDaemonAvailabilityTable = Object.freeze(Object.create(null));
	#summaries = EMPTY_SUMMARIES;
	#generation = 0;
	#revision = 0;
	#pending: Promise<boolean> | undefined;
	#closed = false;

	private constructor(link: AuthDaemonLink) {
		this.#link = link;
		this.#unsubscribe = link.onGeneration(() => {
			if (this.#closed) return;
			const wasRefreshing = this.#pending !== undefined;
			const refreshed = this.#invalidate();
			if (!wasRefreshing) {
				void refreshed.catch(() => {
					if (!this.#closed) logger.debug("Could not refresh daemon auth metadata");
				});
			}
		});
	}

	static async open(link: AuthDaemonLink): Promise<AuthDaemonMetadata> {
		const metadata = new AuthDaemonMetadata(link);
		try {
			await metadata.refresh();
			return metadata;
		} catch (error) {
			metadata.close();
			throw error;
		}
	}

	get generation(): number {
		return this.#generation;
	}

	lookup(provider: string): AuthDaemonProviderAvailability {
		return this.#table[provider] ?? UNAVAILABLE;
	}

	providers(): Iterable<string> {
		return Object.keys(this.#table);
	}

	summaries(provider?: string): AuthDaemonProviderAvailability["credentials"] {
		return provider === undefined ? this.#summaries : this.lookup(provider).credentials;
	}

	onGeneration(listener: (generation: number) => void): () => void {
		this.#requireOpen();
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	refresh(): Promise<boolean> {
		if (this.#closed) return Promise.reject(new Error("Daemon auth metadata is closed"));
		// An explicit refresh can follow a completed mutation while an older read is still pending.
		return this.#invalidate();
	}

	poll(): Promise<boolean> {
		return this.refresh();
	}

	async revalidate(): Promise<void> {
		await this.refresh();
	}

	/** Session-filtered metadata is fetched on request and never enters the global cache. */
	async scopedSnapshot(params: ScopedAvailability): Promise<AuthDaemonAvailabilityTable> {
		this.#requireOpen();
		if (typeof params?.sessionId !== "string" || !params.sessionId) {
			throw new Error("Daemon auth metadata requires a session ID");
		}
		const value = await this.#link.request("availability", params);
		this.#requireOpen();
		return parseAvailability(value);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		this.#listeners.clear();
	}

	#requireOpen(): void {
		if (this.#closed) throw new Error("Daemon auth metadata is closed");
	}

	#invalidate(): Promise<boolean> {
		this.#revision++;
		return (this.#pending ??= Promise.resolve().then(() => this.#drainRefresh()));
	}

	async #drainRefresh(): Promise<boolean> {
		let changed = false;
		try {
			while (true) {
				this.#requireOpen();
				const revision = this.#revision;
				let value: unknown;
				try {
					value = await this.#link.request("availability");
				} catch (error) {
					if (!this.#closed && revision !== this.#revision) continue;
					throw error;
				}
				this.#requireOpen();
				if (revision !== this.#revision) continue;
				const table = parseAvailability(value);
				if (!isDeepStrictEqual(table, this.#table)) {
					this.#table = table;
					const summaries: Readonly<StoredCredentialSummary>[] = [];
					for (const provider in table) {
						for (const summary of table[provider].credentials) summaries.push(summary);
					}
					this.#summaries = Object.freeze(summaries);
					changed = true;
					const generation = ++this.#generation;
					for (const listener of [...this.#listeners]) {
						if (this.#closed) break;
						try {
							listener(generation);
						} catch {
							logger.debug("Daemon auth metadata generation listener failed");
						}
					}
				}
				if (revision === this.#revision) return changed;
			}
		} finally {
			this.#pending = undefined;
		}
	}
}

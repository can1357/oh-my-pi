import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { githubCopilotUsageProvider } from "@oh-my-pi/pi-ai/usage/github-copilot";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import {
	discoverGitHubCopilotAccount,
	parseGitHubCopilotApiKey,
	resolveCopilotTokenBilling,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** `copilot_internal/user` for an account with the given account-level billing flag. */
function quotaBody(tokenBasedBilling: boolean | undefined) {
	return {
		copilot_plan: "individual",
		quota_reset_date: "2026-12-01",
		...(tokenBasedBilling === undefined ? {} : { token_based_billing: tokenBasedBilling }),
		quota_snapshots: {
			premium_interactions: { entitlement: 300, remaining: 100, percent_remaining: 33, unlimited: false },
		},
	};
}

/** A GitHub API stub that counts `copilot_internal/user` calls; `internal` is its status. */
function githubFetch(tokenBasedBilling: boolean | undefined, internal = 200) {
	const calls = { internal: 0, urls: [] as string[] };
	const fetchImpl = Object.assign(
		async (input: string | URL | Request) => {
			calls.urls.push(String(input));
			if (!String(input).endsWith("/copilot_internal/user")) return Response.json({ login: "octocat" });
			calls.internal++;
			return internal === 200
				? Response.json(quotaBody(tokenBasedBilling))
				: new Response("nope", { status: internal });
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetchImpl, calls };
}

/** A store that announces credential rewrites, which the background billing probe makes without blocking a request. */
class WatchedStore extends SqliteAuthCredentialStore {
	readonly rewritten = Promise.withResolvers<void>();

	override tryUpdateAuthCredentialIfMatches(
		...args: Parameters<SqliteAuthCredentialStore["tryUpdateAuthCredentialIfMatches"]>
	) {
		const updated = super.tryUpdateAuthCredentialIfMatches(...args);
		this.rewritten.resolve();
		return updated;
	}
}

async function storeWithLogin(access: string, tokenBasedBilling?: boolean, dbPath = ":memory:"): Promise<WatchedStore> {
	const store = new WatchedStore(new Database(dbPath));
	await store.saveOAuth("github-copilot", {
		access,
		refresh: access,
		expires: Date.now() + YEAR_MS,
		accountId: "octocat",
		...(tokenBasedBilling === undefined ? {} : { tokenBasedBilling }),
	});
	return store;
}

function storageFor(store: SqliteAuthCredentialStore, fetchImpl: typeof fetch): AuthStorage {
	return new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "github-copilot" ? githubCopilotUsageProvider : undefined),
		usageFetch: fetchImpl,
	});
}

/** The billing mode carried by the request key the auth layer resolves right now. */
async function requestBilling(storage: AuthStorage): Promise<boolean | undefined> {
	return parseGitHubCopilotApiKey((await storage.keys.get("github-copilot", "billing-session")) ?? "")
		.tokenBasedBilling;
}

async function requestKeyAfterQuotaFetch(tokenBasedBilling: boolean | undefined): Promise<boolean | undefined> {
	const store = await storeWithLogin(`ghu_quota_${tokenBasedBilling}`);
	const storage = storageFor(store, githubFetch(tokenBasedBilling).fetchImpl);
	try {
		await storage.credentials.reload();
		await storage.usage.reports();
		return await requestBilling(storage);
	} finally {
		storage.close();
		store.close();
	}
}

describe("GitHub Copilot billing mode on the stored login", () => {
	it("records the account's billing mode from a quota fetch so request keys carry it", async () => {
		expect(await requestKeyAfterQuotaFetch(true)).toBe(true);
		expect(await requestKeyAfterQuotaFetch(false)).toBe(false);
		// GitHub omitted the flag: the mode stays unknown, so requests keep the premium estimate.
		expect(await requestKeyAfterQuotaFetch(undefined)).toBeUndefined();
	});

	it("keeps a learned mode across a credential store reload", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-billing-"));
		const dbPath = path.join(dir, "auth.db");
		const store = await storeWithLogin("ghu_reload", undefined, dbPath);
		const first = storageFor(store, githubFetch(true).fetchImpl);
		try {
			await first.credentials.reload();
			await first.usage.reports();
		} finally {
			first.close();
		}
		const { fetchImpl, calls } = githubFetch(true);
		const reopened = storageFor(new SqliteAuthCredentialStore(new Database(dbPath)), fetchImpl);
		try {
			await reopened.credentials.reload();
			expect(await requestBilling(reopened)).toBe(true);
			// Already known: resolving a request key starts no probe.
			expect(calls.internal).toBe(0);
		} finally {
			reopened.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("probes an older login's unknown mode once in the background and persists it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-billing-"));
		const dbPath = path.join(dir, "auth.db");
		const store = await storeWithLogin("ghu_lazy_probe", undefined, dbPath);
		const { fetchImpl, calls } = githubFetch(true);
		const storage = storageFor(store, fetchImpl);
		try {
			await storage.credentials.reload();
			// The request that starts the probe is not held for it.
			expect(await requestBilling(storage)).toBeUndefined();
			await store.rewritten.promise;
			expect(await requestBilling(storage)).toBe(true);
			expect(calls.internal).toBe(1);
		} finally {
			storage.close();
		}
		const reopened = storageFor(new SqliteAuthCredentialStore(new Database(dbPath)), githubFetch(true).fetchImpl);
		try {
			await reopened.credentials.reload();
			expect(await requestBilling(reopened)).toBe(true);
		} finally {
			reopened.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("serves requests through a failed probe and does not retry it", async () => {
		const store = await storeWithLogin("ghu_probe_fails");
		const { fetchImpl, calls } = githubFetch(true, 500);
		const storage = storageFor(store, fetchImpl);
		try {
			await storage.credentials.reload();
			expect(await storage.keys.get("github-copilot", "billing-session")).toBeDefined();
			expect(calls.internal).toBe(1);
			expect(await requestBilling(storage)).toBeUndefined();
			expect(calls.internal).toBe(1);
		} finally {
			storage.close();
			store.close();
		}
	});

	it("probes a GitHub Enterprise login on its own API host, never on public github.com", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("github-copilot", {
			access: "ghu_enterprise",
			refresh: "ghu_enterprise",
			expires: Date.now() + YEAR_MS,
			accountId: "octocat",
			enterpriseUrl: "ghe.example.com",
		});
		const { fetchImpl, calls } = githubFetch(true);
		const storage = storageFor(store, fetchImpl);
		try {
			await storage.credentials.reload();
			await storage.keys.get("github-copilot", "billing-session");
			expect(calls.urls).toEqual(["https://api.ghe.example.com/copilot_internal/user"]);
		} finally {
			storage.close();
			store.close();
		}
	});

	it("probes a runtime or environment token, which has no stored row, once", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const { fetchImpl, calls } = githubFetch(true);
		const storage = storageFor(store, fetchImpl);
		try {
			storage.keys.setRuntime("github-copilot", "ghu_runtime_token");
			expect(await storage.keys.get("github-copilot")).toBe("ghu_runtime_token");
			await storage.keys.get("github-copilot");
			expect(calls.internal).toBe(1);
		} finally {
			storage.close();
			store.close();
		}
	});

	it("remembers a bare token's mode from the account probe for this process", async () => {
		const apiKey = parseGitHubCopilotApiKey("ghu_env_token");
		expect(resolveCopilotTokenBilling(apiKey)).toBeUndefined();
		await discoverGitHubCopilotAccount("ghu_env_token", githubFetch(true).fetchImpl);
		expect(resolveCopilotTokenBilling(apiKey)).toBe(true);
	});

	it("keeps the model-discovery cache namespace when the mode is learned", async () => {
		const namespace = async (tokenBasedBilling: boolean | undefined) => {
			const store = await storeWithLogin("ghu_discovery", tokenBasedBilling);
			const storage = storageFor(store, githubFetch(undefined).fetchImpl);
			try {
				await storage.credentials.reload();
				return resolveModelCacheProviderId("github-copilot", { apiKey: await storage.keys.peek("github-copilot") });
			} finally {
				storage.close();
				store.close();
			}
		};
		expect(await namespace(true)).toBe(await namespace(undefined));
	});
});

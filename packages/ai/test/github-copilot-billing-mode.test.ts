import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { githubCopilotUsageProvider } from "../src/usage/github-copilot";

/** `copilot_internal/user` for an account with the given account-level billing flag. */
function quotaFetch(tokenBasedBilling: boolean | undefined): typeof fetch {
	const body = {
		copilot_plan: "individual",
		quota_reset_date: "2026-12-01",
		...(tokenBasedBilling === undefined ? {} : { token_based_billing: tokenBasedBilling }),
		quota_snapshots: {
			premium_interactions: { entitlement: 300, remaining: 100, percent_remaining: 33, unlimited: false },
		},
	};
	return Object.assign(
		async (input: string | URL | Request) =>
			String(input).endsWith("/copilot_internal/user") ? Response.json(body) : Response.json({ login: "octocat" }),
		{ preconnect: fetch.preconnect },
	);
}

async function requestKeyAfterQuotaFetch(tokenBasedBilling: boolean | undefined): Promise<string | undefined> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	await store.saveOAuth("github-copilot", {
		access: "ghu_billing",
		refresh: "ghu_billing",
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
		accountId: "octocat",
	});
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "github-copilot" ? githubCopilotUsageProvider : undefined),
		usageFetch: quotaFetch(tokenBasedBilling),
	});
	try {
		await storage.credentials.reload();
		await storage.usage.reports();
		return await storage.keys.get("github-copilot", "billing-session");
	} finally {
		storage.close();
		store.close();
	}
}

describe("GitHub Copilot billing mode on the stored login", () => {
	it("records the account's billing mode from a quota fetch so request keys carry it", async () => {
		const tokenBilled = await requestKeyAfterQuotaFetch(true);
		expect(parseGitHubCopilotApiKey(tokenBilled ?? "").tokenBasedBilling).toBe(true);
		const requestBilled = await requestKeyAfterQuotaFetch(false);
		expect(parseGitHubCopilotApiKey(requestBilled ?? "").tokenBasedBilling).toBe(false);
		// GitHub omitted the flag: the mode stays unknown, so requests keep the premium estimate.
		const unknown = await requestKeyAfterQuotaFetch(undefined);
		expect(parseGitHubCopilotApiKey(unknown ?? "").tokenBasedBilling).toBeUndefined();
	});
});

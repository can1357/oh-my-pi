import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore, type OAuthAccountSummary } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
	applyAccountPriorityAssignments,
	createAccountPriorityHost,
	pruneAccountPolicies,
} from "@oh-my-pi/pi-coding-agent/session/account-priority";

const HOUR_MS = 60 * 60 * 1000;

function anthropicCredential(accountId: string, email: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email,
	};
}

let authStorage: AuthStorage;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.set("anthropic", [
		anthropicCredential("acct-a", "a@example.com"),
		anthropicCredential("acct-b", "b@example.com"),
		anthropicCredential("acct-c", "c@example.com"),
	]);
});

afterEach(() => {
	resetSettingsForTest();
});

function accounts(): OAuthAccountSummary[] {
	return authStorage.oauth.accounts("anthropic");
}

function priorityMap(values: number[]): Map<string, number> {
	return new Map(accounts().map((account, index) => [String(account.credentialId), values[index] ?? 1]));
}

describe("account priority host", () => {
	it("lists one provider with every account at priority 1 by default", () => {
		const host = createAccountPriorityHost(authStorage, settings, id => id);
		const providers = host.providers();
		expect(providers).toHaveLength(1);
		expect(providers[0]!.id).toBe("anthropic");
		expect(providers[0]!.accounts.map(account => account.priority)).toEqual([1, 1, 1]);
	});

	it("persists priorities synchronously: settings and live policy see the write immediately", () => {
		const host = createAccountPriorityHost(authStorage, settings, id => id);
		host.save("anthropic", priorityMap([2, 1, 1]));

		const stored = cfgAuthAccountPolicies.get(settings);
		expect(stored.map(policy => policy.priority)).toEqual([2, 1, 1]);
		expect(authStorage.oauth.policy("anthropic", accounts()[0]!)?.priority).toBe(2);
		expect(authStorage.oauth.policy("anthropic", accounts()[1]!)?.priority).toBe(1);
	});

	it("keeps a hand-written reservePct and drops it only when all numbers return to 1", () => {
		cfgAuthAccountPolicies.set(settings, [
			{ provider: "anthropic", account: { email: "a@example.com" }, reservePct: 30 },
		]);
		const host = createAccountPriorityHost(authStorage, settings, id => id);

		host.save("anthropic", priorityMap([2, 1, 1]));
		const prioritized = cfgAuthAccountPolicies.get(settings);
		const reserved = prioritized.find(policy => policy.account.email === "a@example.com");
		expect(reserved?.reservePct).toBe(30);
		expect(reserved?.priority).toBe(2);

		host.save("anthropic", priorityMap([1, 1, 1]));
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { email: "a@example.com" }, reservePct: 30 },
		]);
	});

	it("rejects a save that would produce an empty selector and leaves the config untouched", async () => {
		await authStorage.credentials.set(
			"anthropic",
			accounts().map(account => ({
				type: "oauth" as const,
				access: `access-${account.credentialId}`,
				refresh: `refresh-${account.credentialId}`,
				expires: Date.now() + HOUR_MS,
			})),
		);
		const host = createAccountPriorityHost(authStorage, settings, id => id);

		expect(() => host.save("anthropic", priorityMap([2, 1, 1]))).toThrow(
			/must include at least one of email, accountId, or projectId/,
		);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
	});
});

describe("applyAccountPriorityAssignments", () => {
	const identities = [
		{ email: "a@example.com", accountId: "acct-a" },
		{ email: "b@example.com", accountId: "acct-b" },
		{ email: "c@example.com", accountId: "acct-c" },
	];

	it("drops stale entries for accounts that no longer exist", () => {
		const existing = [
			{ provider: "other", account: { email: "z@example.com" }, priority: 5 },
			{ provider: "anthropic", account: { email: "gone@example.com" }, priority: 3 },
		];
		const next = applyAccountPriorityAssignments(existing, "anthropic", [
			{ account: identities[0]!, priority: 2 },
			{ account: identities[1]!, priority: 1 },
			{ account: identities[2]!, priority: 1 },
		]);
		expect(next).toHaveLength(4);
		expect(next[0]).toBe(existing[0]);
		expect(next[1]).toEqual({ provider: "anthropic", account: identities[0]!, priority: 2 });
		expect(next[2]).toEqual({ provider: "anthropic", account: identities[1]!, priority: 1 });
		expect(next[3]).toEqual({ provider: "anthropic", account: identities[2]!, priority: 1 });
	});
});

describe("pruneAccountPolicies", () => {
	it("drops only the removed identity's entry for the provider", () => {
		const existing = [
			{ provider: "other", account: { email: "z@example.com" }, priority: 5 },
			{ provider: "anthropic", account: { email: "a@example.com" }, priority: 2 },
			{ provider: "anthropic", account: { email: "b@example.com" }, priority: 1 },
		];
		const pruned = pruneAccountPolicies(existing, "anthropic", { email: "a@example.com" });
		expect(pruned).toEqual([existing[0]!, existing[2]!]);

		expect(pruneAccountPolicies(existing, "anthropic")).toEqual([existing[0]!]);
	});
});

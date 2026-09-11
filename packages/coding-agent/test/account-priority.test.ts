import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { Settings, resetSettingsForTest, settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { handleAccountListCommand, handleAccountPriorityCommand } from "../src/slash-commands/helpers/account-priority";
import { toSessionPinAccounts } from "../src/slash-commands/helpers/session-pin";

describe("account priority slash command and settings", () => {
	let tempDir: string;
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	let mockSession: AgentSession;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acct-priority-test-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		// Seed two accounts for anthropic
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "token-1",
				refresh: "refresh-1",
				expires: Date.now() + 3600_000,
				accountId: "acct-alpha",
				email: "alpha@example.com",
			},
			{
				type: "oauth",
				access: "token-2",
				refresh: "refresh-2",
				expires: Date.now() + 3600_000,
				accountId: "acct-beta",
				email: "beta@example.com",
			},
		]);

		mockSession = {
			sessionId: "session-priority-test",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			modelRegistry: { authStorage },
		} as unknown as AgentSession;

		// Clear priority setting before each test
		settings.set("auth.accountPriority", {});
	});

	afterEach(async () => {
		resetSettingsForTest();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("lists accounts and indicates unprioritized state initially", async () => {
		const output = await handleAccountPriorityCommand("", mockSession);
		expect(output).toContain("Account priority for Anthropic (Claude Pro/Max):");
		expect(output).toContain("alpha@example.com (unprioritized)");
		expect(output).toContain("beta@example.com (unprioritized)");
		// Verifies suggestion uses provider ID, not display name with spaces
		expect(output).toContain("Set priority: /account priority anthropic <order...>");
	});

	it("updates priority by account numbers and stores id:<credentialId>", async () => {
		const output = await handleAccountPriorityCommand("anthropic 2 1", mockSession);
		expect(output).toContain("Updated account priority for Anthropic (Claude Pro/Max):");
		expect(output).toContain("beta@example.com (Priority 1)");
		expect(output).toContain("alpha@example.com (Priority 2)");

		const rows = store.listAuthCredentials("anthropic");
		const betaRow = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "acct-beta");
		const alphaRow = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "acct-alpha");

		const prioritySetting = settings.get("auth.accountPriority") as Record<string, string[]>;
		expect(prioritySetting.anthropic).toEqual([`id:${betaRow?.id}`, `id:${alphaRow?.id}`]);
	});

	it("supports current-provider textual order and clear without explicit provider", async () => {
		// Session priority call with defaultToSessionProvider: true
		const output = await handleAccountPriorityCommand("beta@example.com alpha@example.com", mockSession, {
			defaultToSessionProvider: true,
		});
		expect(output).toContain("Updated account priority for Anthropic (Claude Pro/Max):");
		expect(output).toContain("beta@example.com (Priority 1)");
		expect(output).toContain("alpha@example.com (Priority 2)");

		// Session priority clear
		const clearOutput = await handleAccountPriorityCommand("clear", mockSession, {
			defaultToSessionProvider: true,
		});
		expect(clearOutput).toContain("Reset account priority for Anthropic (Claude Pro/Max) to default order.");

		// /account priority clear (without provider name, defaulting to current session provider)
		await handleAccountPriorityCommand("2 1", mockSession);
		const acctClearOutput = await handleAccountPriorityCommand("clear", mockSession);
		expect(acctClearOutput).toContain("Reset account priority for Anthropic (Claude Pro/Max) to default order.");

		// /account priority with email selectors directly (first token not a registered provider)
		const directEmailOutput = await handleAccountPriorityCommand("beta@example.com alpha@example.com", mockSession);
		expect(directEmailOutput).toContain("Updated account priority for Anthropic (Claude Pro/Max):");
	});

	it("disambiguates same-email multi-org accounts", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "tok-personal",
				refresh: "ref-1",
				expires: Date.now() + 3600_000,
				accountId: "acct-1",
				email: "same@example.com",
				orgId: "org-personal",
				orgName: "Personal Org",
			},
			{
				type: "oauth",
				access: "tok-team",
				refresh: "ref-2",
				expires: Date.now() + 3600_000,
				accountId: "acct-2",
				email: "same@example.com",
				orgId: "org-team",
				orgName: "Team Org",
			},
		]);

		const output = await handleAccountPriorityCommand("anthropic 2 1", mockSession);
		expect(output).toContain("Priority 1");
		expect(output).toContain("Priority 2");

		const rows = store.listAuthCredentials("anthropic");
		const personalRow = rows.find(
			r => r.credential.type === "oauth" && "orgId" in r.credential && r.credential.orgId === "org-personal",
		);
		const teamRow = rows.find(
			r => r.credential.type === "oauth" && "orgId" in r.credential && r.credential.orgId === "org-team",
		);

		const prioritySetting = settings.get("auth.accountPriority") as Record<string, string[]>;
		expect(prioritySetting.anthropic).toEqual([`id:${teamRow?.id}`, `id:${personalRow?.id}`]);

		const accounts = authStorage.listOAuthAccounts("anthropic");
		const teamAcct = accounts.find(a => a.credentialId === teamRow?.id);
		const personalAcct = accounts.find(a => a.credentialId === personalRow?.id);
		expect(teamAcct?.priority).toBe(1);
		expect(personalAcct?.priority).toBe(2);
	});

	it("preserves relative priority of remaining accounts during promotion", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "t-a",
				refresh: "r-a",
				expires: Date.now() + 3600_000,
				accountId: "a",
				email: "a@example.com",
			},
			{
				type: "oauth",
				access: "t-b",
				refresh: "r-b",
				expires: Date.now() + 3600_000,
				accountId: "b",
				email: "b@example.com",
			},
			{
				type: "oauth",
				access: "t-c",
				refresh: "r-c",
				expires: Date.now() + 3600_000,
				accountId: "c",
				email: "c@example.com",
			},
		]);

		// Initial priority: C (1) -> B (2) -> A (3)
		await handleAccountPriorityCommand("anthropic 3 2 1", mockSession);
		const rawAccounts = authStorage.listOAuthAccounts("anthropic");
		const accounts = toSessionPinAccounts(rawAccounts);

		// Promote B (account at index 1)
		const targetAccount = accounts.find(a => a.email === "b@example.com")!;
		const otherAccounts = accounts
			.filter(a => a.credentialId !== targetAccount.credentialId)
			.sort((a, b) => {
				const pA = a.priority ?? Number.POSITIVE_INFINITY;
				const pB = b.priority ?? Number.POSITIVE_INFINITY;
				if (pA !== pB) return pA - pB;
				return a.position - b.position;
			});
		const reordered = [targetAccount, ...otherAccounts];

		// Expected order: B, then C (former #1), then A (former #3)
		expect(reordered.map(a => a.email)).toEqual(["b@example.com", "c@example.com", "a@example.com"]);
	});

	it("resets priority with clear subcommand", async () => {
		await handleAccountPriorityCommand("anthropic 2 1", mockSession);
		expect(authStorage.getAccountPriority("anthropic")).toBeDefined();

		const resetOutput = await handleAccountPriorityCommand("anthropic clear", mockSession);
		expect(resetOutput).toContain("Reset account priority for Anthropic (Claude Pro/Max) to default order.");

		const prioritySetting = settings.get("auth.accountPriority") as Record<string, string[]>;
		expect(prioritySetting.anthropic).toBeUndefined();
		expect(authStorage.getAccountPriority("anthropic")).toBeUndefined();
	});

	it("rejects unknown account selector with helpful message", async () => {
		const output = await handleAccountPriorityCommand("anthropic nonexistent@example.com", mockSession);
		expect(output).toContain('No Anthropic (Claude Pro/Max) account matches "nonexistent@example.com"');
	});

	it("handleAccountListCommand lists accounts with their priorities", async () => {
		await handleAccountPriorityCommand("anthropic 2 1", mockSession);
		const output = await handleAccountListCommand("anthropic", mockSession);
		expect(output).toContain("beta@example.com (Priority 1)");
		expect(output).toContain("alpha@example.com (Priority 2)");
	});
});

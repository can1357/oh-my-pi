import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { Settings, resetSettingsForTest, settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { handleAccountListCommand, handleAccountPriorityCommand } from "../src/slash-commands/helpers/account-priority";

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
	});

	it("updates priority by account numbers", async () => {
		const output = await handleAccountPriorityCommand("anthropic 2 1", mockSession);
		expect(output).toContain("Updated account priority for Anthropic (Claude Pro/Max):");
		expect(output).toContain("beta@example.com (Priority 1)");
		expect(output).toContain("alpha@example.com (Priority 2)");

		const prioritySetting = settings.get("auth.accountPriority") as Record<string, string[]>;
		expect(prioritySetting.anthropic).toEqual(["beta@example.com", "alpha@example.com"]);
	});

	it("updates priority by email selectors", async () => {
		const output = await handleAccountPriorityCommand("anthropic beta@example.com alpha@example.com", mockSession);
		expect(output).toContain("Updated account priority for Anthropic (Claude Pro/Max):");
		expect(output).toContain("beta@example.com (Priority 1)");
		expect(output).toContain("alpha@example.com (Priority 2)");

		expect(authStorage.getAccountPriority("anthropic")).toEqual(["beta@example.com", "alpha@example.com"]);
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

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getAgentDbPath, getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runAuthCommand } from "../src/cli/auth-cli";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { AgentStorage } from "../src/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";

function mintOAuthCredential(suffix: string, extra?: { orgId?: string; orgName?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

describe("omp auth (contract)", () => {
	let agentDir: TempDir;
	let projectDir: TempDir;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	let logs: string[];
	let errors: string[];

	beforeEach(async () => {
		resetSettingsForTest();
		agentDir = TempDir.createSync("@omp-auth-cli-agent-");
		projectDir = TempDir.createSync("@omp-auth-cli-project-");
		setAgentDir(agentDir.path());
		await Settings.init({ agentDir: agentDir.path(), cwd: projectDir.path() });
		logs = [];
		errors = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(Bun.stripANSI(args.map(String).join(" ")));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(Bun.stripANSI(args.map(String).join(" ")));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		resetSettingsForTest();
		process.exitCode = undefined;
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await agentDir.remove().catch(() => {});
		await projectDir.remove().catch(() => {});
	});

	/**
	 * Two Anthropic OAuth accounts sharing an email under different orgs — the
	 * exact case a naive "persist the email" implementation turns ambiguous on
	 * the next read. Seeds the same `agent.db` path `discoverAuthStorage()`
	 * (called internally by `runAuthCommand`) will open, then closes this
	 * connection so it doesn't hold a conflicting lock.
	 */
	function seedSharedEmailAccounts(): void {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path())));
		store.saveOAuth("anthropic", mintOAuthCredential("shared", { orgId: "org-a", orgName: "Org A" }));
		store.saveOAuth("anthropic", mintOAuthCredential("shared", { orgId: "org-b", orgName: "Org B" }));
		store.close();
	}

	it("persists a selector that still uniquely resolves when accounts share an email", async () => {
		seedSharedEmailAccounts();
		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "Org B" });
		expect(errors).toEqual([]);
		expect(logs.join("\n")).toContain("Pinned");

		// If the bug regresses (persisting the shared "shared@example.com"),
		// this second lookup goes ambiguous and the accounts view stops
		// marking anything [pinned].
		logs = [];
		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).toContain("2. shared@example.com (Org B) [pinned]");
		expect(output).not.toContain("1. shared@example.com (Org A) [pinned]");
	});

	it("rejects an ambiguous selector instead of guessing", async () => {
		seedSharedEmailAccounts();
		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "shared@example.com" });
		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("matches multiple");
	});

	it("does not mark an account [pinned] once its stored selector goes stale", async () => {
		seedSharedEmailAccounts();
		// Simulate a pre-fix (or hand-edited) config: the shared email, which
		// now matches both accounts.
		Settings.instance.set("auth.startupOAuthAccount", { anthropic: "shared@example.com" });
		await Settings.instance.flush();

		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).not.toContain("[pinned]");
		expect(output).toContain("ambiguous");
	});

	it("unpin clears the global layer and pin never leaks a sibling provider's project-only entry", async () => {
		// Project-level config pins a DIFFERENT provider; only the global layer
		// should ever be touched by `omp auth pin anthropic ...`.
		await Bun.write(
			path.join(projectDir.path(), ".omp", "config.yml"),
			"auth:\n  startupOAuthAccount:\n    openai: project-only-value\n",
		);
		resetSettingsForTest();
		await Settings.init({ agentDir: agentDir.path(), cwd: projectDir.path() });
		seedSharedEmailAccounts();

		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "Org A" });
		const globalRaw = Settings.instance.getGlobalSettings().auth as
			| { startupOAuthAccount?: Record<string, string> }
			| undefined;
		expect(globalRaw?.startupOAuthAccount?.anthropic).toBe("OAuth credential #1");
		expect(globalRaw?.startupOAuthAccount?.openai).toBeUndefined();

		logs = [];
		await runAuthCommand({ action: "unpin", provider: "anthropic" });
		const afterUnpin = Settings.instance.getGlobalSettings().auth as
			| { startupOAuthAccount?: Record<string, string> }
			| undefined;
		expect(afterUnpin?.startupOAuthAccount?.anthropic).toBeUndefined();
		expect(afterUnpin?.startupOAuthAccount?.openai).toBeUndefined();
	});

	it("warns when a project/overlay layer shadows the global pin it just wrote", async () => {
		await Bun.write(
			path.join(projectDir.path(), ".omp", "config.yml"),
			"auth:\n  startupOAuthAccount:\n    anthropic: shared@example.com\n",
		);
		resetSettingsForTest();
		await Settings.init({ agentDir: agentDir.path(), cwd: projectDir.path() });
		seedSharedEmailAccounts();

		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "Org A" });
		expect(logs.join("\n")).toContain("higher-precedence project or overlay config");
	});
	it("persists a durable selector that survives a sibling account being removed (/logout)", async () => {
		seedSharedEmailAccounts();
		// Pin "Org A" — position 0 at the time of pinning.
		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "Org A" });

		// Remove "Org B" the way `/logout` does: the AuthStorage-level delete.
		// If the persisted selector were the 1-based position instead of a
		// durable id, this wouldn't change anything for account 1 — but the
		// regression this guards is the reverse direction (removing an
		// EARLIER account would shift a later one into position 1). Removing
		// the sibling here is enough to prove the persisted value is not a
		// position that could have been invalidated by any removal at all.
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path()))));
		await authStorage.reload();
		const before = authStorage.listOAuthAccounts("anthropic");
		const orgB = before.find(a => a.orgName === "Org B");
		if (!orgB) throw new Error("expected Org B to be seeded");
		await authStorage.removeCredential("anthropic", orgB.credentialId);
		authStorage.close();

		logs = [];
		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).toContain("shared@example.com (Org A) [pinned]");
	});
});

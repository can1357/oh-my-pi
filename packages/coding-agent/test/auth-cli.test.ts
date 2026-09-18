import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getAgentDbPath, getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runAuthCommand } from "../src/cli/auth-cli";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { credentialStoreFingerprint } from "../src/slash-commands/helpers/session-pin";
import { AgentStorage } from "../src/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";

/** The scoped durable selector `uniqueStartupSelector` persists for a LOCAL agent dir's default store. */
function expectedDurableSelector(agentDirPath: string, credentialId: number): string {
	const fingerprint = credentialStoreFingerprint(`local ${getAgentDbPath(agentDirPath)}`);
	return fingerprint ? `OAuth credential #${fingerprint}:${credentialId}` : `OAuth credential #${credentialId}`;
}

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
		expect(globalRaw?.startupOAuthAccount?.anthropic).toBe(expectedDurableSelector(agentDir.path(), 1));
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

	it("persists a durable selector that survives an earlier sibling account being removed (/logout)", async () => {
		seedSharedEmailAccounts();
		// Pin "Org B" — position 2 at the time of pinning. A positional selector
		// would persist "2".
		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "Org B" });

		// Remove "Org A" (position 1) the way `/logout` does. Org B now slides
		// into position 1: a persisted "2" would point at nothing (or, with a
		// third account, at the wrong org), while the durable
		// `OAuth credential #<id>` form keeps resolving to Org B.
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path()))));
		await authStorage.reload();
		const orgA = authStorage.listOAuthAccounts("anthropic").find(a => a.orgName === "Org A");
		if (!orgA) throw new Error("expected Org A to be seeded");
		await authStorage.removeCredential("anthropic", orgA.credentialId);
		authStorage.close();

		logs = [];
		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).toContain("1. shared@example.com (Org B) [pinned]");
		expect(output).not.toContain("ambiguous");
		expect(output).not.toContain("no longer valid");
	});

	it("omp auth accounts reports a non-string configured value instead of crashing", async () => {
		seedSharedEmailAccounts();
		// A hand-edited `anthropic: 1` (unquoted YAML) or the generic /settings
		// record editor can store a number here; the schema is a plain record, so
		// the typed setter has to be bypassed the same way a raw config write is.
		Settings.instance.set("auth.startupOAuthAccount", { anthropic: 1 } as unknown as Record<string, string>);
		await Settings.instance.flush();

		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		expect(errors).toEqual([]);
		const output = logs.join("\n");
		expect(output).toContain("1. shared@example.com (Org A)");
		expect(output).toContain("2. shared@example.com (Org B)");
		expect(output).not.toContain("[pinned]");
		expect(output).toContain("is not a string selector");
	});

	it("omp auth unpin warns when the only pin lives in a project layer instead of claiming nothing is pinned", async () => {
		await Bun.write(
			path.join(projectDir.path(), ".omp", "config.yml"),
			'auth:\n  startupOAuthAccount:\n    anthropic: "OAuth credential #1"\n',
		);
		resetSettingsForTest();
		await Settings.init({ agentDir: agentDir.path(), cwd: projectDir.path() });

		await runAuthCommand({ action: "unpin", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).toContain("higher-precedence project or overlay config");
		expect(output).toContain('"OAuth credential #1"');
	});

	it("keeps a solo account pinned after a same-email sibling is added later via /login", async () => {
		// Seed exactly one Anthropic account and pin it by email while it is
		// the only match — the exact snapshot a naive "unique at write time"
		// implementation would persist the email for.
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path())));
		store.saveOAuth("anthropic", mintOAuthCredential("solo", { orgId: "org-a", orgName: "Org A" }));
		store.close();

		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "solo@example.com" });
		expect(errors).toEqual([]);
		const globalRaw = Settings.instance.getGlobalSettings().auth as
			| { startupOAuthAccount?: Record<string, string> }
			| undefined;
		// Persisted as the durable credential id, not the email that was only
		// unique at pin time — see `uniqueStartupSelector`'s doc comment.
		expect(globalRaw?.startupOAuthAccount?.anthropic).toBe(expectedDurableSelector(agentDir.path(), 1));

		// Simulate the same person logging into a second org under the same
		// email later via `/login` — a record that did not exist when the
		// selector above was persisted. This is the future-arriving-data
		// case (distinct from a collision already present at pin time).
		const laterStore = new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path())));
		laterStore.saveOAuth("anthropic", mintOAuthCredential("solo", { orgId: "org-b", orgName: "Org B" }));
		laterStore.close();

		logs = [];
		await runAuthCommand({ action: "accounts", provider: "anthropic" });
		const output = logs.join("\n");
		expect(output).toContain("solo@example.com (Org A) [pinned]");
		expect(output).not.toContain("ambiguous");
	});

	it("a durable selector persisted against one store never resolves against an unrelated store's same numeric id", async () => {
		// Pin against THIS test's agent dir (the "victim" store): one account,
		// so it lands at the durable credential id 1.
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir.path())));
		store.saveOAuth("anthropic", mintOAuthCredential("victim"));
		store.close();
		await runAuthCommand({ action: "pin", provider: "anthropic", selector: "victim@example.com" });
		const pinnedSelector = (
			Settings.instance.getGlobalSettings().auth as { startupOAuthAccount?: Record<string, string> } | undefined
		)?.startupOAuthAccount?.anthropic;
		if (!pinnedSelector) throw new Error("expected a persisted selector");
		expect(pinnedSelector).toBe(expectedDurableSelector(agentDir.path(), 1));

		// A completely separate agent dir/store -- an unrelated `agent.db` with
		// its own independent autoincrement, whose first Anthropic account
		// ALSO lands at credential id 1. Simulates a broker toggled off (falls
		// back to local SQLite) or a different broker URL selected: same
		// selector string, a different physical store behind it.
		const otherAgentDir = TempDir.createSync("@omp-auth-cli-other-agent-");
		try {
			const otherStore = new SqliteAuthCredentialStore(new Database(getAgentDbPath(otherAgentDir.path())));
			otherStore.saveOAuth("anthropic", mintOAuthCredential("attacker"));
			otherStore.close();

			setAgentDir(otherAgentDir.path());
			resetSettingsForTest();
			await Settings.init({ agentDir: otherAgentDir.path(), cwd: projectDir.path() });
			// Carry the victim store's persisted selector over verbatim, as if
			// config.yml itself had been copied or the broker toggled.
			Settings.instance.set("auth.startupOAuthAccount", { anthropic: pinnedSelector });
			await Settings.instance.flush();

			logs = [];
			errors = [];
			await runAuthCommand({ action: "accounts", provider: "anthropic" });
			const output = logs.join("\n");
			// Before the fix, the bare `OAuth credential #1` form would resolve
			// against THIS store's own credential id 1 -- the unrelated
			// "attacker" account -- and mark it [pinned].
			expect(output).not.toContain("[pinned]");
			expect(output).toContain("no longer valid");
		} finally {
			await otherAgentDir.remove().catch(() => {});
		}
	});
});

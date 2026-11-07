/**
 * Regression test for PR #15305.
 *
 * The `chore/tui-usage-presenter` refactor deleted ~20 imports that
 * `runUsageResetCommand` still referenced, so `omp usage reset` reached a
 * `ReferenceError` at runtime for every target it resolved. `bun run check:types`
 * was the only gate that could catch it, and the existing usage-cli tests only
 * exercised `formatUsageBreakdown`, never the reset command, so the broken code
 * path shipped red.
 *
 * These tests drive `runUsageCommand({ action: "reset" })` end to end — target
 * parsing, the account listing, the spend fence, and the redeem outcome — so a
 * dropped import is a hard failure rather than a silent typecheck skip.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type ResetCreditAccountStatus } from "@oh-my-pi/pi-ai";
import { type UsageCommandArgs, runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

const RESET_COMMAND = "omp usage reset";

let tmp: TempDir;
let authStorage: AuthStorage;

beforeEach(async () => {
	tmp = await TempDir.create("@usage-reset-");
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	// The spend fence writes its lock beside the agent database.
	vi.spyOn(utils, "getProjectDir").mockReturnValue(tmp.path());
	vi.spyOn(utils, "getAgentDbPath").mockReturnValue(tmp.join("agent.db"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	await tmp.remove();
});

function codexStatus(credentialId: number): ResetCreditAccountStatus {
	return {
		provider: "openai-codex",
		credentialId,
		accountId: "acct-1",
		email: "codex@example.test",
		orgName: "example-org",
		availableCount: 1,
		redeemableCount: 1,
		credits: [{ id: "credit-1", remainingCount: 1, usable: true }],
		active: true,
	};
}

/** Run `omp usage reset ...` and collect what the command wrote to both streams. */
async function runReset(args: Partial<UsageCommandArgs>): Promise<{
	stdout: string;
	stderr: string;
	exitCode?: number;
}> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	try {
		await runUsageCommand({ action: "reset", ...args });
	} finally {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	}
	const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
	return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

test("omp usage reset rejects a provider that holds no saved resets", async () => {
	const { stdout, stderr, exitCode } = await runReset({ provider: "openai" });
	expect(stdout).toBe("");
	expect(stderr).toContain("Saved resets exist only for Codex and Claude accounts");
	expect(stderr).toContain("--provider openai-codex or anthropic");
	expect(exitCode).toBe(1);
});

test("omp usage reset lists each stored account and the target that spends it", async () => {
	vi.spyOn(authStorage.resets, "list").mockResolvedValue([codexStatus(42)]);
	const { stdout, stderr, exitCode } = await runReset({});
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(stdout).toContain("Saved rate-limit resets:");
	expect(stdout).toContain(`Spend one with \`${RESET_COMMAND} <provider>/<credential id>\`.`);
	expect(stdout).toContain(
		"- codex@example.test · example-org [Codex · openai-codex/42]: 1 saved, 1 usable now (active)",
	);
});

test("omp usage reset spends a stated target and reports what the provider cleared", async () => {
	const list = vi.spyOn(authStorage.resets, "list").mockResolvedValue([codexStatus(42)]);
	const redeem = vi
		.spyOn(authStorage.resets, "redeem")
		.mockResolvedValue({ ok: true, code: "reset", provider: "openai-codex", cleared: ["openai-codex:5h"] });
	const { stdout, stderr, exitCode } = await runReset({ target: "openai-codex/42" });
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(stdout).toContain("Reset applied for codex@example.test · example-org (Codex)");
	expect(stdout).toContain("the covered rate-limit window has been refreshed");
	// The spend is fenced and re-checked against the provider's live balance.
	expect(redeem).toHaveBeenCalledTimes(1);
	expect(list).toHaveBeenCalledTimes(2);
});

test("omp usage reset names the credential id that matched instead of spending", async () => {
	vi.spyOn(authStorage.resets, "list").mockResolvedValue([codexStatus(42)]);
	const redeem = vi.spyOn(authStorage.resets, "redeem");
	const { stdout, stderr, exitCode } = await runReset({ target: "openai-codex/99" });
	expect(stdout).toBe("");
	expect(stderr).toContain(`No stored account matches "openai-codex/99". List choices with \`${RESET_COMMAND}\`.`);
	expect(exitCode).toBe(1);
	expect(redeem).not.toHaveBeenCalled();
});

test("omp usage reset keeps a transport failure on stderr instead of crashing", async () => {
	vi.spyOn(authStorage.resets, "list").mockResolvedValue([codexStatus(42)]);
	vi.spyOn(authStorage.resets, "redeem").mockImplementation(() => {
		throw new Error("socket closed");
	});
	const { stdout, stderr, exitCode } = await runReset({ target: "openai-codex/42" });
	expect(stdout).toBe("");
	expect(stderr).toContain("couldn't confirm whether the reset applied");
	expect(stderr).toContain("socket closed");
	expect(exitCode).toBe(1);
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = { bin: "omp", version: "test", commands: new Map() };
const PROVIDER = "paused-provider";
const REASON = "paused for testing";

let db: Database;
let authStorage: AuthStorage;
let stdout: string;
let stderr: string;

beforeEach(async () => {
	db = new Database(":memory:");
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));
	await authStorage.credentials.reload();
	// One retained OAuth login: enabled, this is the single account `--list` shows.
	await authStorage.credentials.set(PROVIDER, [
		{
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() + 3_600_000,
			email: "user@example.test",
		},
	]);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	stdout = "";
	stderr = "";
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	});
	spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
	process.exitCode = 0;
});

function pauseProvider(): void {
	vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
		provider === PROVIDER ? REASON : undefined,
	);
}

describe("`omp token` against a paused provider", () => {
	it("lists the retained account while the provider is enabled", async () => {
		expect(authStorage.oauth.accounts(PROVIDER)).toHaveLength(1);

		await new Token([PROVIDER, "--list"], TEST_CONFIG).run();

		expect(stderr).toBe("");
		expect(stdout).toContain("1. user@example.test");
		expect(process.exitCode).toBe(0);
	});

	it("fails with the pause reason instead of the misleading no-accounts message", async () => {
		pauseProvider();

		await new Token([PROVIDER, "--list"], TEST_CONFIG).run();

		expect(stdout).toBe("");
		expect(stderr).toContain(`${PROVIDER} is paused: ${REASON}`);
		expect(stderr).not.toContain("No OAuth accounts found");
		expect(stderr).not.toContain("ProviderDisabledError");
		expect(stderr).not.toMatch(/\n\s+at\s/);
		expect(process.exitCode).toBe(1);
	});
	it("blocks the default token path with the pause reason before storage loads", async () => {
		pauseProvider();
		const discoverSpy = spyOn(sdkModule, "discoverAuthStorage");

		await new Token([PROVIDER], TEST_CONFIG).run();

		expect(stdout).toBe("");
		expect(stderr).toContain(`${PROVIDER} is paused: ${REASON}`);
		expect(process.exitCode).toBe(1);
		expect(discoverSpy).not.toHaveBeenCalled();
	});

	it("blocks --account on a paused provider before resolving a credential", async () => {
		pauseProvider();
		const discoverSpy = spyOn(sdkModule, "discoverAuthStorage");

		await new Token([PROVIDER, "--account", "1"], TEST_CONFIG).run();

		expect(stdout).toBe("");
		expect(stderr).toContain(`${PROVIDER} is paused: ${REASON}`);
		expect(process.exitCode).toBe(1);
		expect(discoverSpy).not.toHaveBeenCalled();
	});
});

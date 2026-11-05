import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";

let db: Database;
let authStorage: AuthStorage;
let stdout: string;
let stderr: string;

beforeEach(async () => {
	db = new Database(":memory:");
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("groq", { type: "api_key", key: "gsk-test" });
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr += String(chunk);
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

function expectNoCredentialsError(provider: string): void {
	const message = Bun.stripANSI(stderr);
	expect(message).toContain(`"${provider}"`);
	expect(message).toContain("groq");
	expect(message).not.toContain("usage endpoint");
}

test("omp usage --provider with no stored credentials names the providers that have them", async () => {
	await runUsageCommand({ provider: "claude", noExtensions: true });
	expectNoCredentialsError("claude");
	expect(process.exitCode).toBe(1);
});

test("omp usage invalidate refuses a provider with no stored credentials", async () => {
	await runUsageCommand({ action: "invalidate", provider: "nosuch", noExtensions: true });
	expect(stdout).toBe("");
	expectNoCredentialsError("nosuch");
	expect(process.exitCode).toBe(1);
});

test("omp usage invalidate accepts a provider with stored credentials", async () => {
	await runUsageCommand({ action: "invalidate", provider: "groq", noExtensions: true });
	expect(stderr).toBe("");
	expect(stdout).toBe('Invalidated cached usage reports for provider "groq".\n');
	expect(process.exitCode).toBe(0);
});

test.each([
	// A usage provider can report through env or runtime keys with nothing stored.
	["a provider with a usage endpoint but no stored credential", "anthropic"],
	// Another process stored this credential after the snapshot was loaded.
	["a credential missing from a stale snapshot", "xai"],
])("omp usage invalidate accepts %s", async (_name, provider) => {
	const writer = new AuthStorage(new SqliteAuthCredentialStore(db));
	await writer.credentials.reload();
	await writer.credentials.set("xai", { type: "api_key", key: "xai-test" });

	await runUsageCommand({ action: "invalidate", provider, noExtensions: true });
	expect(stderr).toBe("");
	expect(stdout).toBe(`Invalidated cached usage reports for provider "${provider}".\n`);
	expect(process.exitCode).toBe(0);
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageProvider } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

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

test.each([
	["a named provider case-insensitively", "SCOPE-A", ["scope-a"]],
	["all providers when no filter is given", undefined, ["scope-a", "scope-b"]],
] satisfies Array<[string, string | undefined, string[]]>)(
	"omp usage fetches only %s",
	async (_name, provider, expected) => {
		const tmp = await TempDir.create("@usage-provider-scope-");
		try {
			vi.spyOn(utils, "getAgentDir").mockReturnValue(tmp.path());
			const fetched: string[] = [];
			const providers = new Map<string, UsageProvider>();
			for (const id of ["scope-a", "scope-b"]) {
				providers.set(id, {
					id,
					async fetchUsage() {
						fetched.push(id);
						return { provider: id, fetchedAt: Date.now(), limits: [] };
					},
				});
			}
			const scopedAuth = new AuthStorage(new SqliteAuthCredentialStore(db), {
				usageProviderResolver: id => providers.get(id),
			});
			await scopedAuth.credentials.reload();
			for (const id of providers.keys()) {
				await scopedAuth.credentials.set(id, { type: "api_key", key: "synthetic-usage-key" });
			}
			vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(scopedAuth);

			await runUsageCommand({ provider, json: true, noExtensions: true });

			expect(fetched.sort()).toEqual(expected);
			const output = JSON.parse(stdout) as { reports: Array<{ provider: string }> };
			expect(output.reports.map(report => report.provider).sort()).toEqual(expected);
		} finally {
			await tmp.remove();
		}
	},
);

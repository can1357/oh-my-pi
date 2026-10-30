/**
 * Regression test for issue #13579.
 *
 * `omp usage` never loaded extensions, so a usage provider registered via
 * `pi.registerProvider(name, { usage })` was never consulted and the account
 * landed in `accountsWithoutUsage` instead of producing a report.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as utils from "@oh-my-pi/pi-utils";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const EXTENSION_SOURCE = `export default function (pi) {
	pi.registerProvider("ext-usage", {
		usage: {
			id: "ext-usage",
			async fetchUsage() {
				return {
					provider: "ext-usage",
					fetchedAt: Date.now(),
					limits: [{
						id: "credits",
						label: "Credits",
						scope: { provider: "ext-usage" },
						amount: { used: 6, limit: 10, unit: "usd", usedFraction: 0.6 },
					}],
				};
			},
		},
	});
}
`;

class BrokerUsageStore extends SqliteAuthCredentialStore {
	async fetchUsageReports(): Promise<UsageReport[]> {
		return [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];
	}
}

let tmp: TempDir;
let extPath: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tmp = await TempDir.create("@issue-13579-");
	extPath = tmp.join("ext.ts");
	await Bun.write(extPath, EXTENSION_SOURCE);
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("ext-usage", { type: "api_key", key: "sk-test" });
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

async function usageJson(options: { extensions?: string[]; noExtensions?: boolean; provider?: string }): Promise<{
	reports: Array<{ provider: string; limits: Array<{ id: string }> }>;
	accountsWithoutUsage: Array<{ provider: string }>;
}> {
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	await runUsageCommand({ json: true, provider: "ext-usage", ...options });
	return JSON.parse(chunks.join(""));
}

test("omp usage reports accounts through an extension-registered usage provider (issue #13579)", async () => {
	const output = await usageJson({ extensions: [extPath], noExtensions: true });
	expect(output.reports.map(report => [report.provider, report.limits.map(limit => limit.id)])).toEqual([
		["ext-usage", ["credits"]],
	]);
	expect(output.accountsWithoutUsage).toEqual([]);
});

test("omp usage fetches extension usage without discovering the extension's model catalog", async () => {
	const marker = tmp.join("catalog-fetched");
	const catalogExtPath = tmp.join("catalog-ext.ts");
	await Bun.write(
		catalogExtPath,
		`export default function (pi) {
	pi.registerProvider("ext-catalog", {
		baseUrl: "http://127.0.0.1:1/v1",
		api: "openai-completions",
		apiKey: "literal-key",
		fetchDynamicModels: async () => {
			await Bun.write(${JSON.stringify(marker)}, "fetched");
			return [];
		},
		usage: {
			id: "ext-catalog",
			async fetchUsage() {
				return { provider: "ext-catalog", fetchedAt: Date.now(), limits: [] };
			},
		},
	});
}
`,
	);

	const output = await usageJson({ extensions: [catalogExtPath], noExtensions: true, provider: "ext-catalog" });
	expect(output.reports.map(report => report.provider)).toEqual(["ext-catalog"]);
	expect(await Bun.file(marker).exists()).toBe(false);
});

test("omp usage skips ambient hook factories but retains configured usage providers", async () => {
	const marker = tmp.join("hook-loaded");
	const hookPath = path.join(getProjectAgentDir(tmp.path()), "hooks", "pre", "usage-hook.ts");
	await Bun.write(hookPath, `await Bun.write(${JSON.stringify(marker)}, "loaded"); export default function () {}`);
	vi.spyOn(utils, "getProjectDir").mockReturnValue(tmp.path());
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated({ extensions: [extPath] }));

	const output = await usageJson({});
	expect(output.reports.map(report => report.provider)).toEqual(["ext-usage"]);
	expect(await Bun.file(marker).exists()).toBe(false);
});

test("omp usage combines broker reports with locally registered extension usage", async () => {
	authStorage.close();
	authStorage = new AuthStorage(new BrokerUsageStore(new Database(":memory:")));
	await authStorage.credentials.reload();
	await authStorage.credentials.set("ext-usage", { type: "api_key", key: "sk-test" });
	await authStorage.credentials.set("anthropic", { type: "api_key", key: "sk-broker" });
	const brokerProbe = vi.fn(async (): Promise<UsageReport> => ({
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [],
	}));
	authStorage.usage.setProvider("anthropic", { id: "anthropic", fetchUsage: brokerProbe });
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);

	const output = await usageJson({ extensions: [extPath], noExtensions: true, provider: undefined });
	expect(output.reports.map(report => [report.provider, report.limits.map(limit => limit.id)])).toEqual([
		["anthropic", []],
		["ext-usage", ["credits"]],
	]);
	expect(output.accountsWithoutUsage).toEqual([]);
	expect(brokerProbe).not.toHaveBeenCalled();
});

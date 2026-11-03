import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthGatewayCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { installEnvRestores, installMockRestores, testLifetime } from "../../utils/test/helpers/mock-restores";

const BROKER_TOKEN = "gateway-account-pool-token";

describe("auth-gateway account pool", () => {
	// The async afterEach can time out, and Bun then skips `onTestFinished` and the later hooks; these
	// owners still put the variables and the spies back at the next test and when the scope ends.
	// `setAgentDir()` writes PI_CODING_AGENT_DIR and clears the profile variables.
	installEnvRestores(
		[
			"OMP_AUTH_BROKER_URL",
			"OMP_AUTH_BROKER_TOKEN",
			"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
			"PI_CODING_AGENT_DIR",
			"PI_CONFIG_FILES",
			"OMP_PROFILE",
			"PI_PROFILE",
		],
		{ afterPutBack: __resetDirsFromEnvForTests },
	);
	installMockRestores();
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	beforeEach(async () => {
		const life = testLifetime();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-pool-"));
		life.assertLive();
		process.env.PI_CODING_AGENT_DIR = tempDir;
		setAgentDir(tempDir);
		resetSettingsForTest();
		brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		await brokerStore.saveOAuth("anthropic", {
			access: "allowed-access",
			refresh: "allowed-refresh",
			expires: Date.now() + 120_000,
			email: "allowed@example.com",
		});
		await brokerStore.saveOAuth("anthropic", {
			access: "excluded-access",
			refresh: "excluded-refresh",
			expires: Date.now() + 120_000,
			email: "excluded@example.com",
		});
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [BROKER_TOKEN],
			disableRefresher: true,
		});
		const poolPath = path.join(tempDir, "account-pool.json");
		await Bun.write(poolPath, JSON.stringify({ anthropic: ["email:allowed@example.com"] }));
		life.assertLive();
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = BROKER_TOKEN;
		process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE = poolPath;
	});

	afterEach(async () => {
		resetSettingsForTest();
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("check probes only credentials selected by the environment pool", async () => {
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runAuthGatewayCommand({ action: "check", flags: { json: true } });

		const result = JSON.parse(output) as { credentials: Array<{ email?: string }> };
		expect(result.credentials.map(credential => credential.email)).toEqual(["allowed@example.com"]);
	});

	test("check skips API keys and unlisted providers hidden by an allow-list pool", async () => {
		await brokerStorage!.credentials.upsert("anthropic", { type: "api_key", key: "hidden-anthropic-key" });
		await brokerStorage!.credentials.upsert("openrouter", { type: "api_key", key: "hidden-openrouter-key" });
		await Bun.write(
			process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE!,
			JSON.stringify({ "*": false, anthropic: { accounts: ["email:allowed@example.com"], apiKeys: false } }),
		);
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runAuthGatewayCommand({ action: "check", flags: { json: true } });

		const result = JSON.parse(output) as { credentials: Array<{ provider: string; type: string; email?: string }> };
		expect(result.credentials.map(({ provider, type, email }) => ({ provider, type, email }))).toEqual([
			{ provider: "anthropic", type: "oauth", email: "allowed@example.com" },
		]);
	});

	test("check uses effective PI_CONFIG_FILES account policies", async () => {
		const life = testLifetime();
		const overlayPath = path.join(tempDir, "overlay.yml");
		await Promise.all([
			Bun.write(
				path.join(tempDir, "config.yml"),
				[
					"auth:",
					"  accountPolicies:",
					"    - provider: anthropic",
					"      account:",
					"        email: stale@example.com",
					"      unsupported: true",
					"",
				].join("\n"),
			),
			Bun.write(
				overlayPath,
				[
					"auth:",
					"  accountPolicies:",
					"    - provider: anthropic",
					"      account:",
					"        email: allowed@example.com",
					"      priority: 20",
					"retry:",
					"  usageReservePct: 17",
					"",
				].join("\n"),
			),
		]);
		life.assertLive();
		process.env.PI_CONFIG_FILES = overlayPath;
		resetSettingsForTest();
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runAuthGatewayCommand({ action: "check", flags: { json: true } });

		const result = JSON.parse(output) as { credentials: Array<{ email?: string }> };
		expect(result.credentials.map(credential => credential.email)).toEqual(["allowed@example.com"]);
	});
});

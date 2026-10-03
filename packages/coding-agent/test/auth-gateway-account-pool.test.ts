import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthGatewayCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const BROKER_TOKEN = "gateway-account-pool-token";
const ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_FILES",
] as const;
const originalAgentDir = getAgentDir();

describe("auth-gateway account pool", () => {
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-pool-"));
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
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = BROKER_TOKEN;
		process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE = poolPath;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		if (tempDir) await removeWithRetries(tempDir);
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setAgentDir(originalAgentDir);
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

	test("check uses effective PI_CONFIG_FILES account policies", async () => {
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

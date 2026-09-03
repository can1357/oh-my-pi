import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthGatewayCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const BROKER_TOKEN = "gateway-account-pool-token";
const ENV_KEYS = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"] as const;

describe("auth-gateway account pool", () => {
	let tempDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-pool-"));
		brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		brokerStore.saveOAuth("anthropic", {
			access: "allowed-access",
			refresh: "allowed-refresh",
			expires: Date.now() + 120_000,
			email: "allowed@example.com",
		});
		brokerStore.saveOAuth("anthropic", {
			access: "excluded-access",
			refresh: "excluded-refresh",
			expires: Date.now() + 120_000,
			email: "excluded@example.com",
		});
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
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
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		if (tempDir) await removeWithRetries(tempDir);
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
});

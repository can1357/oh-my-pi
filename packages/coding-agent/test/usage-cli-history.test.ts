import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";

const BROKER_ENV = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
const HOUR_MS = 60 * 60 * 1000;

function snapshot(provider: string, recordedAt: number, usedFraction: number): UsageHistoryEntry {
	return {
		recordedAt,
		provider,
		accountKey: `${provider}-account`,
		limitId: `${provider}:5h`,
		label: "5 Hour",
		windowLabel: "5h",
		usedFraction,
		status: "ok",
	};
}

let brokerStore: SqliteAuthCredentialStore;
let localStore: SqliteAuthCredentialStore;
let handle: AuthBrokerServerHandle;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of BROKER_ENV) savedEnv[key] = process.env[key];
	brokerStore = new SqliteAuthCredentialStore(new Database(":memory:"));
	localStore = new SqliteAuthCredentialStore(new Database(":memory:"));
	handle = startAuthBroker({
		storage: new AuthStorage(brokerStore),
		bind: "127.0.0.1:0",
		bearerTokens: ["history-bearer"],
		disableRefresher: true,
	});
	process.env.OMP_AUTH_BROKER_URL = handle.url;
	process.env.OMP_AUTH_BROKER_TOKEN = "history-bearer";
	vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(new AuthStorage(localStore));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await handle.close();
	brokerStore.close();
	for (const key of BROKER_ENV) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

test("omp usage --history reads the broker host's record, not the client's own store", async () => {
	const now = Date.now();
	brokerStore.recordUsageSnapshots([
		snapshot("anthropic", now - 3 * HOUR_MS, 0.25),
		snapshot("anthropic", now - HOUR_MS, 0.75),
		snapshot("openai-codex", now - HOUR_MS, 0.5),
	]);
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	await runUsageCommand({ history: true, json: true, days: 1, provider: "anthropic" });

	const output = JSON.parse(chunks.join("")) as { entries: UsageHistoryEntry[] };
	expect(output.entries.map(entry => [entry.provider, entry.usedFraction])).toEqual([
		["anthropic", 0.25],
		["anthropic", 0.75],
	]);
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { installEnvRestores, installMockRestores } from "../../utils/test/helpers/mock-restores";

// The async afterEach can time out, and Bun then skips the later hooks; these owners still put
// the variables and the spies back at the next test and when the file ends.
installEnvRestores(["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"]);
installMockRestores();
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

beforeEach(() => {
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
	await handle.close();
	brokerStore.close();
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

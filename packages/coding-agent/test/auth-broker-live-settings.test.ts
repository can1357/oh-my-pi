import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { createAuthStorageSettingsSync } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cfgAuthBrokerUrl, cfgAuthUnpausedProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

const PROVIDER = "live-broker-test";
const TOKEN = "live-broker-bearer";
const BROKER_ENV = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS"] as const;

interface Broker {
	handle: AuthBrokerServerHandle;
	storage: AuthStorage;
}

async function startBroker(dir: string, apiKey: string): Promise<Broker> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, `${apiKey}.db`)));
	await storage.credentials.set(PROVIDER, { type: "api_key", key: apiKey });
	const handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	return { handle, storage };
}

describe("auth broker settings take effect live", () => {
	let tempDir: TempDir;
	const brokers: Broker[] = [];
	const cleanups: Array<() => void> = [];
	const savedEnv: Partial<Record<(typeof BROKER_ENV)[number], string>> = {};

	beforeEach(() => {
		// A settings instance an earlier file left driving effects would own the pause set.
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-auth-broker-live-");
		for (const key of BROKER_ENV) {
			const value = process.env[key];
			if (value !== undefined) savedEnv[key] = value;
			delete process.env[key];
		}
		// No snapshot cache: every connection must hit its broker.
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
		setUnpausedProviders([]);
		for (const broker of brokers.splice(0)) {
			await broker.handle.close();
			broker.storage.close();
		}
		for (const key of BROKER_ENV) {
			delete process.env[key];
			const value = savedEnv[key];
			if (value !== undefined) process.env[key] = value;
		}
		// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("resolves credentials from the new broker after auth.broker.url changes", async () => {
		const brokerA = await startBroker(tempDir.path(), "key-from-a");
		const brokerB = await startBroker(tempDir.path(), "key-from-b");
		brokers.push(brokerA, brokerB);
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`auth:\n  broker:\n    url: ${brokerA.handle.url}\n    token: ${TOKEN}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await discoverAuthStorage(agentDir, { settings });
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		expect(await authStorage.keys.get(PROVIDER)).toBe("key-from-a");

		cfgAuthBrokerUrl.set(settings, brokerB.handle.url);
		// The coalesced listener delivers the change on the next microtask.
		await Promise.resolve();
		await sync.settled();

		expect(await authStorage.keys.get(PROVIDER)).toBe("key-from-b");
	});

	it("loads a paused provider's stored login once auth.unpausedProviders lists it", async () => {
		const paused = "live-paused-test";
		vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
			provider === paused ? "paused for this test" : undefined,
		);
		const agentDir = tempDir.join("agent");
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const authStorage = await discoverAuthStorage(agentDir, { settings });
		cleanups.push(() => authStorage.close());
		const sync = createAuthStorageSettingsSync(settings, authStorage);
		cleanups.push(() => sync.stop());
		await authStorage.credentials.set(paused, { type: "api_key", key: "stored-key" });
		expect(await authStorage.keys.get(paused)).toBeUndefined();

		cfgAuthUnpausedProviders.set(settings, [paused]);
		await Promise.resolve();
		await sync.settled();

		expect(await authStorage.keys.get(paused)).toBe("stored-key");
	});

	it.each([
		{ layer: "global config", file: ["agent", "config.yml"], expected: "stored-key" },
		{ layer: "project config (a repository cannot unpause)", file: [".omp", "config.yml"], expected: undefined },
	])("discovery with $layer listing a paused provider", async ({ file, expected }) => {
		const paused = "discovery-paused-test";
		vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
			provider === paused ? "paused for this test" : undefined,
		);
		const agentDir = tempDir.join("agent");
		const seed = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db")));
		await seed.credentials.set(paused, { type: "api_key", key: "stored-key" });
		seed.close();
		await Bun.write(path.join(tempDir.path(), ...file), `auth:\n  unpausedProviders:\n    - ${paused}\n`);
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		// Both layers are read: only where the list comes from differs.
		expect(cfgAuthUnpausedProviders.get(settings)).toEqual([paused]);

		const authStorage = await discoverAuthStorage(agentDir, { settings });
		cleanups.push(() => authStorage.close());

		expect(await authStorage.keys.get(paused)).toBe(expected);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import { AuthBrokerError, type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	createAuthStorageSettingsSync,
	describeAuthBrokerStartupError,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cfgAuthBrokerUrl, cfgAuthUnpausedProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

const PROVIDER = "live-broker-test";
const TOKEN = "live-broker-bearer";
const BROKER_ENV = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	"OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
] as const;

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
		const overlay = tempDir.join("operator.yml");
		await Bun.write(overlay, "auth: { broker: { url: 'http://127.0.0.1:1' } }\n");
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir, configFiles: [overlay] });
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

	it("reuses the read-only main config without accepting mutable settings layers", async () => {
		const broker = await startBroker(tempDir.path(), "key-from-global");
		brokers.push(broker);
		const cwd = tempDir.path();
		const agentDir = tempDir.join("agent");
		const mainConfig = path.join(agentDir, "config.yaml");
		const wrongUrl = "http://127.0.0.1:1";
		await Bun.write(
			mainConfig,
			`"auth.broker.url": ${wrongUrl}\n"auth.broker.token": ${TOKEN}\nauth:\n  broker:\n    url: ${broker.handle.url}\n`,
		);
		await Bun.write(tempDir.join(".omp", "config.yml"), `auth: { broker: { url: '${wrongUrl}' } }\n`);
		const root = await Settings.loadReadOnly({ cwd, agentDir, overrides: { "auth.broker.url": wrongUrl } });
		const settings = root.overlay();
		cfgAuthBrokerUrl.set(root, wrongUrl);
		cfgAuthBrokerUrl.set(settings, wrongUrl);
		// An auth-side re-read would reject the file instead of using the loaded global layer.
		await Bun.write(mainConfig, "auth: [");

		const storage = await discoverAuthStorage(agentDir, { settings, retryUnreachableBroker: false });
		cleanups.push(() => storage.close());
		expect(await storage.keys.get(PROVIDER)).toBe("key-from-global");
	});

	it.each(["in-memory", "different agent directory"])(
		"reads the target main config when Settings is %s",
		async kind => {
			const broker = await startBroker(tempDir.path(), "key-from-target");
			brokers.push(broker);
			const target = tempDir.join("target");
			await Bun.write(
				path.join(target, "config.yml"),
				`auth: { broker: { url: '${broker.handle.url}', token: '${TOKEN}' } }\n`,
			);
			const wrongUrl = "http://127.0.0.1:1";
			const cwd = tempDir.path();
			let settings: Settings;
			if (kind === "in-memory") {
				settings = Settings.isolated({ "auth.broker.url": wrongUrl });
			} else {
				const other = tempDir.join("other");
				await Bun.write(
					path.join(other, "config.yml"),
					`auth: { broker: { url: '${wrongUrl}', token: '${TOKEN}' } }\n`,
				);
				settings = await Settings.loadReadOnly({ cwd, agentDir: other });
			}

			const storage = await discoverAuthStorage(target, { settings, retryUnreachableBroker: false });
			cleanups.push(() => storage.close());
			expect(await storage.keys.get(PROVIDER)).toBe("key-from-target");
		},
	);

	it("reports the actual rejected broker without rereading config or opening a local fallback", async () => {
		const broker = await startBroker(tempDir.path(), "key-not-served");
		brokers.push(broker);
		const agentDir = tempDir.join("agent");
		const mainConfig = path.join(agentDir, "config.yml");
		await Bun.write(mainConfig, `auth: { broker: { url: '${broker.handle.url}', token: wrong } }\n`);
		const settings = await Settings.loadReadOnly({ cwd: tempDir.path(), agentDir });
		let rejected: unknown;
		try {
			const storage = await discoverAuthStorage(agentDir, { settings, retryUnreachableBroker: false });
			storage.close();
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toBeInstanceOf(AuthBrokerError);
		expect(await Bun.file(path.join(agentDir, "agent.db")).exists()).toBe(false);
		await Bun.write(mainConfig, "auth: [");
		expect(await describeAuthBrokerStartupError(rejected)).toContain(String(broker.handle.url));
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

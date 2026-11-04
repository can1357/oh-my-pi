import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const ENDPOINT = "http://held-key.invalid";
const MODELS_URL = `${ENDPOINT}/v1/models`;
const ORIGINAL_KEY = "fake-original-key";

/**
 * A key changed in AuthStorage directly — `keys.setRuntime` (the `--api-key`
 * flag) or `keys.setConfig`/`removeConfig` — while a discovery is resolving the
 * provider's key. The registry holds none of that state, so only the key
 * store can say it changed.
 */
describe("a discovery does not send a key replaced in AuthStorage while it resolved", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let held: HeldCommand;
	let sent: Array<{ url: string; key: string | null }>;
	let registry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-auth-key-currency-"));
		modelsPath = path.join(tempDir, "models.yml");
		held = heldCommand(tempDir, ORIGINAL_KEY);
		fs.writeFileSync(modelsPath, anthropicConfig(held.command));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		sent = [];
		registry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(tempDir, "models.db"),
			fetch: async (input, init) => {
				const url = String(input);
				if (url !== MODELS_URL) throw new Error(`offline: ${url}`);
				sent.push({ url, key: new Headers(init?.headers).get("x-api-key") });
				return Response.json({ data: [{ id: "held-model", type: "model" }] });
			},
		});
	});

	afterEach(() => {
		held.release();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** Start a discovery, apply `change` once its key is being resolved, then let it finish. */
	async function changeDuringDiscovery(change: () => void | Promise<void>): Promise<void> {
		const inFlight = registry.refreshProvider("anthropic", "online");
		await held.started();
		await change();
		held.release();
		await inFlight;
	}

	/** The held discovery sent nothing and published nothing; the next one uses the current key. */
	async function expectRefusedThenCurrent(currentKey: string): Promise<void> {
		expect(sent.map(request => request.key)).not.toContain(ORIGINAL_KEY);
		expect(registry.find("anthropic", "held-model")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("anthropic")).toBe(currentKey);
		sent.length = 0;
		await registry.refreshProvider("anthropic", "online");
		expect(sent).toEqual([{ url: MODELS_URL, key: currentKey }]);
		expect(registry.find("anthropic", "held-model")).toBeDefined();
	}

	test("a runtime key set (--api-key)", async () => {
		await changeDuringDiscovery(() => authStorage.keys.setRuntime("anthropic", "fake-runtime-key"));
		await expectRefusedThenCurrent("fake-runtime-key");
	});

	test("a runtime key set and removed again", async () => {
		await changeDuringDiscovery(() => {
			authStorage.keys.setRuntime("anthropic", "fake-runtime-key");
			authStorage.keys.removeRuntime("anthropic");
		});
		// The key that resolves now is the one the held command prints, but the
		// request was assembled across a change; it is refused all the same.
		await expectRefusedThenCurrent(ORIGINAL_KEY);
	});

	test("a config key set", async () => {
		await changeDuringDiscovery(() => authStorage.keys.setConfig("anthropic", "fake-config-key"));
		await expectRefusedThenCurrent("fake-config-key");
	});

	test("a config key moved behind a stored login key", async () => {
		await changeDuringDiscovery(async () => {
			await authStorage.credentials.set("anthropic", { type: "api_key", key: "fake-login-key", source: "login" });
			authStorage.keys.setConfig("anthropic", held.command, { fallback: true });
		});
		await expectRefusedThenCurrent("fake-login-key");
	});

	test("another provider's key change does not refuse the discovery", async () => {
		await changeDuringDiscovery(() => {
			authStorage.keys.setRuntime("openai", "fake-other-runtime-key");
			authStorage.keys.setConfig("openai", "fake-other-config-key");
		});
		expect(sent).toEqual([{ url: MODELS_URL, key: ORIGINAL_KEY }]);
		expect(registry.find("anthropic", "held-model")).toBeDefined();
	});

	test("rewriting a key with its current value does not refuse the discovery", async () => {
		await changeDuringDiscovery(() => authStorage.keys.setConfig("anthropic", held.command));
		expect(sent).toEqual([{ url: MODELS_URL, key: ORIGINAL_KEY }]);
		expect(registry.find("anthropic", "held-model")).toBeDefined();
	});

	test("a models.yml reload that leaves the provider's key unchanged does not refuse the discovery", async () => {
		await changeDuringDiscovery(async () => {
			writeWithNewMtime(
				modelsPath,
				`${anthropicConfig(held.command)}  openai:\n    apiKey: fake-other-config-key\n`,
			);
			// Any refresh reloads a changed models.yml, which re-installs every
			// provider's config key.
			await registry.refreshProvider("openai", "offline");
		});
		expect(sent).toEqual([{ url: MODELS_URL, key: ORIGINAL_KEY }]);
		expect(registry.find("anthropic", "held-model")).toBeDefined();
	});

	test("a models.yml reload that drops a config key the registry did not install refuses the discovery", async () => {
		// The key reaches AuthStorage from an SDK caller, not from models.yml, so
		// the registry's own configuration never held it.
		const endpointOnly = `providers:\n  anthropic:\n    baseUrl: ${ENDPOINT}\n`;
		writeWithNewMtime(modelsPath, endpointOnly);
		await registry.refreshProvider("openai", "offline");
		authStorage.keys.setConfig("anthropic", held.command);
		await changeDuringDiscovery(async () => {
			// The reload clears every config key before reinstalling models.yml's.
			writeWithNewMtime(modelsPath, `${endpointOnly}  openai:\n    apiKey: fake-other-config-key\n`);
			await registry.refreshProvider("openai", "offline");
		});
		expect(sent.map(request => request.key)).not.toContain(ORIGINAL_KEY);
		expect(registry.find("anthropic", "held-model")).toBeUndefined();
	});
});

function anthropicConfig(apiKey: string): string {
	return `providers:\n  anthropic:\n    baseUrl: ${ENDPOINT}\n    apiKey: "${apiKey}"\n`;
}

interface HeldCommand {
	command: string;
	started(): Promise<void>;
	release(): void;
}

/** A `!command` config value that prints `output` only once released. */
function heldCommand(dir: string, output: string): HeldCommand {
	const id = Bun.hash(`${dir}${output}${Math.random()}`).toString(36);
	const startedPath = path.join(dir, `${id}.started`);
	const gatePath = path.join(dir, `${id}.gate`);
	return {
		command: `!sh -c 'touch ${startedPath}; while [ ! -f ${gatePath} ]; do sleep 0.02; done; echo ${output}'`,
		// The command runs in a child process; its marker file is its only signal.
		started: async () => {
			while (!fs.existsSync(startedPath)) await Bun.sleep(10);
		},
		release: () => fs.writeFileSync(gatePath, ""),
	};
}

/** Rewrite a file with a modification time the registry's reload check cannot miss. */
function writeWithNewMtime(file: string, content: string) {
	const previous = fs.statSync(file).mtimeMs;
	fs.writeFileSync(file, content);
	const next = new Date(Math.max(Date.now(), previous + 2000));
	fs.utimesSync(file, next, next);
}

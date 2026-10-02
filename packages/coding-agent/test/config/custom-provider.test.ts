import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	addCustomProvider,
	type CustomProviderContext,
	customProviderContext,
	getCustomProvider,
	isBuiltInProvider,
	removeCustomProvider,
	updateCustomProvider,
} from "../../src/config/custom-provider";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";

const CHANGED_ON_DISK = "models.yml changed on disk; retry";

interface Fixture {
	directory: string;
	/** Stand-in for the real agent dir for the whole test: nothing here may ever be written. */
	agentDir: string;
	authStorage: AuthStorage;
	configPath: string;
	refreshProvider: Mock<(id: string) => Promise<void>>;
	/** What the registry would report after a refresh; tests flip these to simulate a bad endpoint. */
	state: { modelsFound: boolean; discoverySucceeded: boolean };
	context: CustomProviderContext;
	restoreAgentDir(): void;
}

async function createFixture(prefix: string): Promise<Fixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}agent-`));
	const configPath = path.join(directory, "models.yml");
	const authStorage = await AuthStorage.create(":memory:");
	const refreshProvider = vi.fn(async (_id: string) => {});
	const state = { modelsFound: true, discoverySucceeded: true };

	const previousAgentDir = getAgentDir();
	const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(agentDir);

	return {
		directory,
		agentDir,
		authStorage,
		configPath,
		refreshProvider,
		state,
		context: {
			authStorage,
			config: ModelsConfigFile.relocate(configPath),
			refreshProvider,
			discoverySucceeded: () => state.discoverySucceeded,
			hasChatModels: () => state.modelsFound,
		},
		restoreAgentDir() {
			setAgentDir(previousAgentDir);
			if (previousAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
		},
	};
}

async function disposeFixture(fixture: Fixture): Promise<void> {
	vi.restoreAllMocks();
	fixture.restoreAgentDir();
	fixture.authStorage.close();
	await fs.rm(fixture.directory, { recursive: true, force: true });
	await fs.rm(fixture.agentDir, { recursive: true, force: true });
}

/**
 * Land `content` on `filePath` while the `nth` atomic write has its temp file staged: after models.yml was read
 * and validated, before the publish. Fires once, so no other write is intercepted.
 */
function editWhileStaging(filePath: string, content: string, nth = 1) {
	const realOpen = nodeFs.promises.open;
	let staged = 0;
	let fired = false;
	return vi.spyOn(nodeFs.promises, "open").mockImplementation((async (...args: Parameters<typeof realOpen>) => {
		const handle = await realOpen(...args);
		if (String(args[0]).endsWith(".tmp") && ++staged === nth && !fired) {
			fired = true;
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				await fs.writeFile(filePath, content);
				await sync();
			};
		}
		return handle;
	}) as typeof realOpen);
}

/** A discovery provider declaration, `indent` spaces per level. */
function discoveryProvider(name: string, baseUrl: string, indent = 2): string {
	const pad = (level: number) => " ".repeat(indent * level);
	return [
		`${pad(1)}${name}:`,
		`${pad(2)}baseUrl: ${baseUrl}`,
		`${pad(2)}api: openai-completions`,
		`${pad(2)}auth: none`,
		`${pad(2)}discovery:`,
		`${pad(3)}type: openai-models-list`,
		"",
	].join("\n");
}

describe("addCustomProvider", () => {
	let fixture: Fixture;
	let { directory, authStorage, configPath, refreshProvider, state, context } = {} as Fixture;

	beforeEach(async () => {
		fixture = await createFixture("omp-custom-provider-");
		({ directory, authStorage, configPath, refreshProvider, state, context } = fixture);
	});

	afterEach(() => disposeFixture(fixture));

	const input = { id: "my-gateway", baseUrl: "https://gateway.example/v1///", apiKey: "top-secret" };

	it("stores the key in AuthStorage and atomically writes a private provider config", async () => {
		await addCustomProvider(input, context);
		const config = context.config.tryLoad();
		expect(config.status).toBe("ok");
		if (config.status !== "ok") return;
		expect(config.value.providers?.[input.id]?.baseUrl).toBe("https://gateway.example/v1");
		expect(config.value.providers?.[input.id]?.apiKey).toBeUndefined();
		expect(await fs.readFile(configPath, "utf8")).not.toContain(input.apiKey);
		expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
		expect(authStorage.credentials.get(input.id)).toMatchObject({ type: "api_key", key: input.apiKey });
		expect(refreshProvider).toHaveBeenCalledWith(input.id);
	});

	it("discovers models through the registry using the stored key", async () => {
		const registry = new ModelRegistry(authStorage, configPath, {
			fetch: async (url, init) => {
				expect(String(url)).toBe("https://gateway.example/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer top-secret");
				return Response.json({ data: [{ id: "test-chat-model" }] });
			},
		});
		await addCustomProvider(input, {
			...context,
			refreshProvider: id => registry.refreshProvider(id, "online"),
			discoverySucceeded: id => registry.getProviderDiscoveryState(id)?.status === "ok",
			hasChatModels: id => registry.getAll("chat").some(model => model.provider === id),
		});
		expect(registry.find(input.id, "test-chat-model")).toBeDefined();
	});

	it("writes the file the registry reads when it was built with its own models path", async () => {
		const registry = new ModelRegistry(authStorage, configPath, {
			fetch: async () => Response.json({ data: [{ id: "test-chat-model" }] }),
		});
		const outcome = await addCustomProvider(input, customProviderContext(registry)).then(
			() => "added",
			(error: Error) => error.message,
		);
		expect(outcome).toBe("added");
		expect(await fs.readFile(configPath, "utf8")).toContain(`${input.id}:`);
		expect(registry.find(input.id, "test-chat-model")).toBeDefined();
	});

	it("preserves an invalid existing config byte for byte", async () => {
		const original = "providers: [invalid\n# keep this";
		await fs.writeFile(configPath, original);
		await expect(addCustomProvider(input, context)).rejects.toThrow();
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.has(input.id)).toBe(false);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it("keeps comments and other providers byte-for-byte when adding", async () => {
		const seed =
			"# top\nproviders:\n  # keep me\n  other:\n    baseUrl: http://o.example/v1 # inline\n    auth: none\n";
		await fs.writeFile(configPath, seed);
		await addCustomProvider(input, context);
		const written = await fs.readFile(configPath, "utf8");
		expect(written.startsWith(seed.trimEnd())).toBe(true);
		expect(written).toContain("# top");
		expect(written).toContain("# keep me");
		expect(written).toContain("# inline");
		expect(written).toContain("my-gateway:");
	});

	it("edits a flow-style providers map and stays valid", async () => {
		await fs.writeFile(configPath, 'providers: {other: {baseUrl: "http://o.example/v1", auth: none}}\n');
		await addCustomProvider(input, context);
		const loaded = ModelsConfigFile.relocate(configPath).tryLoad();
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(Object.keys(loaded.value.providers ?? {}).sort()).toEqual(["my-gateway", "other"]);
	});

	it("aborts when models.yml changes while the new file is being staged", async () => {
		const concurrent = `providers:\n${discoveryProvider("concurrent", "http://c.example/v1")}`;
		await fs.writeFile(configPath, `providers:\n${discoveryProvider("other", "http://o.example/v1")}`);
		const spy = editWhileStaging(configPath, concurrent);
		try {
			await expect(addCustomProvider(input, context)).rejects.toThrow(CHANGED_ON_DISK);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(await fs.readdir(directory)).toEqual(["models.yml"]);
		expect(authStorage.credentials.has(input.id)).toBe(false);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it.each([
		[{ ...input, id: "Invalid ID" }, "Provider ID"],
		[{ ...input, baseUrl: "not a url" }, "valid provider endpoint"],
		[{ ...input, baseUrl: "file:///tmp/models" }, "HTTP or HTTPS"],
		[{ ...input, baseUrl: "https://gateway.example/v1?token=x" }, "query"],
		[{ ...input, baseUrl: "https://gateway.example/v1#models" }, "fragment"],
		[{ ...input, baseUrl: "https://user:pass@gateway.example/v1" }, "credentials"],
	])("rejects invalid input before writing: %j", async (candidate, message) => {
		await expect(addCustomProvider(candidate, context)).rejects.toThrow(message);
		expect(authStorage.credentials.has(input.id)).toBe(false);
		await expect(fs.stat(configPath)).rejects.toThrow();
	});

	it("rejects duplicate provider IDs without replacing saved credentials", async () => {
		await addCustomProvider(input, context);
		const original = await fs.readFile(configPath, "utf8");
		await expect(addCustomProvider({ ...input, apiKey: "replacement" }, context)).rejects.toThrow(
			"already configured",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.get(input.id)).toMatchObject({ key: input.apiKey });
	});

	it("rejects an ID declared in models.yml even when no credential is stored for it", async () => {
		const seed = `providers:\n${discoveryProvider(input.id, "http://hand.example/v1")}`;
		await fs.writeFile(configPath, seed);
		await expect(addCustomProvider(input, context)).rejects.toThrow("already configured");
		expect(await fs.readFile(configPath, "utf8")).toBe(seed);
		expect(authStorage.credentials.has(input.id)).toBe(false);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it("accepts a keyless endpoint", async () => {
		const registry = new ModelRegistry(authStorage, configPath, {
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("Authorization")).toBeNull();
				return Response.json({ data: [{ id: "local-chat-model" }] });
			},
		});
		await addCustomProvider(
			{ ...input, apiKey: "" },
			{
				...context,
				refreshProvider: id => registry.refreshProvider(id, "online"),
				discoverySucceeded: id => registry.getProviderDiscoveryState(id)?.status === "ok",
				hasChatModels: id => registry.getAll("chat").some(model => model.provider === id),
			},
		);
		expect(authStorage.credentials.has(input.id)).toBe(false);
		const config = context.config.tryLoad();
		expect(config.status).toBe("ok");
		if (config.status === "ok") expect(config.value.providers?.[input.id]?.auth).toBe("none");
		expect(registry.getAvailable().some(model => model.provider === input.id)).toBe(true);
	});

	it("rolls back the file and key when discovery yields no chat models", async () => {
		state.modelsFound = false;
		await expect(addCustomProvider(input, context)).rejects.toThrow("No chat models were discovered");
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.has(input.id)).toBe(false);
		// Once for the attempt, once to re-sync the registry with the restored file.
		expect(refreshProvider).toHaveBeenCalledTimes(2);
	});

	it("a failed setup keeps a key another login stored meanwhile", async () => {
		state.modelsFound = false;
		const racing: CustomProviderContext = {
			...context,
			refreshProvider: async () => {
				await authStorage.credentials.set(input.id, { type: "api_key", key: "newer", source: "login" });
			},
		};
		await expect(addCustomProvider(input, racing)).rejects.toThrow("credentials changed during provider editing");
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.get(input.id)).toMatchObject({ key: "newer" });
	});

	it("rejects cached chat models when the online discovery failed", async () => {
		state.modelsFound = true;
		state.discoverySucceeded = false;
		await expect(addCustomProvider(input, context)).rejects.toThrow("No chat models were discovered");
		expect(refreshProvider).toHaveBeenCalledWith(input.id);
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.has(input.id)).toBe(false);
	});

	it("keeps the provider and its key when a hand edit blocks the undo of a failed setup", async () => {
		state.modelsFound = false;
		let handEdited = false;
		const handEdit = vi.fn(async (_id: string) => {
			if (handEdited) return;
			handEdited = true;
			await fs.appendFile(configPath, "# hand edit\n");
		});
		const error = await addCustomProvider(input, { ...context, refreshProvider: handEdit }).catch(
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Could not undo failed provider setup");
		expect((error as Error).message).toContain(CHANGED_ON_DISK);
		expect(((error as Error).cause as Error).message).toContain("No chat models were discovered");
		// File and credential still agree: the provider is in the file and its key is stored.
		expect(await fs.readFile(configPath, "utf8")).toContain(`${input.id}:`);
		expect(authStorage.credentials.get(input.id)).toMatchObject({ key: input.apiKey });
	});

	it("does not overwrite a hand edit that lands while the undo of a failed setup is being staged", async () => {
		state.modelsFound = false;
		await fs.writeFile(configPath, `providers:\n${discoveryProvider("other", "http://o.example/v1")}`);
		const concurrent = `# edited during the undo\nproviders:\n${discoveryProvider("concurrent", "http://c.example/v1")}`;
		// Write 1 publishes the provider; write 2 is the undo.
		const spy = editWhileStaging(configPath, concurrent, 2);
		try {
			await expect(addCustomProvider(input, context)).rejects.toThrow("Could not undo failed provider setup");
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(input.id)).toMatchObject({ key: input.apiKey });
	});

	it("stores the key before it writes the file, and writes nothing when the key cannot be stored", async () => {
		let fileExistedWhenKeyStored: boolean | undefined;
		vi.spyOn(authStorage.credentials, "set").mockImplementation(async () => {
			fileExistedWhenKeyStored = nodeFs.existsSync(configPath);
			throw new Error("credential store locked");
		});
		await expect(addCustomProvider(input, context)).rejects.toThrow("credential store locked");
		expect(fileExistedWhenKeyStored).toBe(false);
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it("refuses a result the load pipeline would reject, before anything is written", async () => {
		const strict = ModelsConfigFile.relocate(configPath).withValidation("test", config => {
			if (config.providers?.[input.id]) throw new Error("gateway providers are not allowed");
		});
		await expect(addCustomProvider(input, { ...context, config: strict })).rejects.toThrow(
			/Invalid provider configuration:.*gateway providers are not allowed/s,
		);
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.has(input.id)).toBe(false);
		expect(refreshProvider).not.toHaveBeenCalled();
	});
});

describe("editing and removing custom providers", () => {
	let fixture: Fixture;
	let { authStorage, configPath, refreshProvider, state, context } = {} as Fixture;

	beforeEach(async () => {
		fixture = await createFixture("omp-custom-provider-edit-");
		({ authStorage, configPath, refreshProvider, state, context } = fixture);
	});

	afterEach(() => disposeFixture(fixture));

	const id = "my-gateway";
	const seeded = [
		"# keep this comment",
		"providers:",
		`  ${id}:`,
		"    baseUrl: https://old.example/v1",
		"    api: openai-completions",
		"    auth: none",
		"    discovery:",
		"      type: openai-models-list",
		"    models:",
		"      - id: m1",
		"    compat:",
		"      supportsStore: false",
		"    headers:",
		"      X-A: b",
		"",
	].join("\n");

	function loadProvider(name = id) {
		const loaded = context.config.tryLoad();
		if (loaded.status !== "ok") throw new Error(`models.yml did not load: ${loaded.status}`);
		return loaded.value.providers?.[name];
	}

	it("update changes only baseUrl and keeps models, compat, headers", async () => {
		await fs.writeFile(configPath, seeded);
		const before = loadProvider();
		await updateCustomProvider(id, { baseUrl: "https://new.example/v1/" }, context);
		const after = loadProvider();
		expect(after?.baseUrl).toBe("https://new.example/v1");
		expect(after?.models).toEqual(before?.models);
		expect(after?.compat).toEqual(before?.compat);
		expect(after?.headers).toEqual(before?.headers);
		expect(await fs.readFile(configPath, "utf8")).toContain("# keep this comment");
		expect(refreshProvider).toHaveBeenCalledWith(id);
	});

	it("update with blank key keeps the stored credential", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		await updateCustomProvider(id, { baseUrl: "https://new.example/v1" }, context);
		expect(authStorage.credentials.get(id)).toMatchObject({ type: "api_key", key: "k1" });
	});

	// Providers that define custom `models` must keep `apiKey` or `auth: none|oauth` in models.yml.
	const discoveryOnly = seeded.split("    models:")[0];

	it("update moves a new key out of models.yml", async () => {
		await fs.writeFile(configPath, discoveryOnly.replace("    auth: none", "    apiKey: inline-secret"));
		await updateCustomProvider(id, { apiKey: "k2" }, context);
		expect(await fs.readFile(configPath, "utf8")).not.toContain("inline-secret");
		expect(loadProvider()?.apiKey).toBeUndefined();
		expect(authStorage.credentials.get(id)).toMatchObject({ type: "api_key", key: "k2" });
	});

	it("a new key on a keyless provider drops auth none", async () => {
		await fs.writeFile(configPath, discoveryOnly);
		await updateCustomProvider(id, { apiKey: "k2" }, context);
		expect(loadProvider()?.auth).toBeUndefined();
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k2" });
	});

	it("refuses a new key on a provider that defines its own models, before touching credential or file", async () => {
		await fs.writeFile(configPath, seeded);
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		await expect(updateCustomProvider(id, { apiKey: "k2" }, context)).rejects.toThrow(
			`Provider "${id}" defines its own models, so its API key must stay in models.yml. Edit the file directly.`,
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(seeded);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it("clearApiKey still works on a provider that defines its own models", async () => {
		await fs.writeFile(configPath, seeded.replace("    auth: none", "    apiKey: inline-secret"));
		await updateCustomProvider(id, { clearApiKey: true }, context);
		expect(loadProvider()?.auth).toBe("none");
		expect(loadProvider()?.apiKey).toBeUndefined();
		expect(loadProvider()?.models).toHaveLength(1);
	});

	it("does not treat inherited object keys as providers", async () => {
		await fs.writeFile(configPath, seeded);
		expect(getCustomProvider("constructor", context.config, authStorage)).toBeUndefined();
		await expect(updateCustomProvider("constructor", { apiKey: "k2" }, context)).rejects.toThrow(
			'Provider "constructor" is not defined in models.yml.',
		);
		expect(authStorage.credentials.has("constructor")).toBe(false);
		expect(await fs.readFile(configPath, "utf8")).toBe(seeded);
	});

	it("clearApiKey removes the credential and sets auth none", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		await updateCustomProvider(id, { clearApiKey: true }, context);
		expect(authStorage.credentials.has(id)).toBe(false);
		expect(loadProvider()?.auth).toBe("none");
		expect(loadProvider()?.apiKey).toBeUndefined();
	});

	it("rejects setting and clearing the key together", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const original = await fs.readFile(configPath, "utf8");
		await expect(updateCustomProvider(id, { apiKey: "k2", clearApiKey: true }, context)).rejects.toThrow(
			"both set and clear",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("update rolls back file and key when rediscovery fails", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const original = await fs.readFile(configPath, "utf8");
		state.modelsFound = false;
		refreshProvider.mockClear();
		await expect(
			updateCustomProvider(id, { baseUrl: "https://new.example/v1", apiKey: "k2" }, context),
		).rejects.toThrow("No chat models were discovered");
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		// Once for the attempt, once to re-sync the registry with the restored file.
		expect(refreshProvider).toHaveBeenCalledTimes(2);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it.each(["logout", "rotation"] as const)("failed edits do not overwrite a concurrent %s", async action => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const original = await fs.readFile(configPath, "utf8");
		state.modelsFound = false;
		let changed = false;
		const concurrentContext: CustomProviderContext = {
			...context,
			refreshProvider: async () => {
				if (changed) return;
				changed = true;
				if (action === "logout") await authStorage.credentials.remove(id);
				else await authStorage.credentials.set(id, { type: "api_key", key: "rotated", source: "login" });
			},
		};
		await expect(updateCustomProvider(id, { apiKey: "k2" }, concurrentContext)).rejects.toThrow(
			"credentials changed during provider editing",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		if (action === "logout") expect(authStorage.credentials.has(id)).toBe(false);
		else expect(authStorage.credentials.get(id)).toMatchObject({ key: "rotated" });
	});

	it("a failed edit does not overwrite a key another process rotated meanwhile", async () => {
		const dbPath = path.join(fixture.directory, "agent.db");
		const ours = await AuthStorage.create(dbPath);
		const theirs = await AuthStorage.create(dbPath);
		try {
			const shared: CustomProviderContext = { ...context, authStorage: ours };
			await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, shared);
			const original = await fs.readFile(configPath, "utf8");
			state.modelsFound = false;
			let rotated = false;
			const racing: CustomProviderContext = {
				...shared,
				refreshProvider: async () => {
					if (rotated) return;
					rotated = true;
					await theirs.credentials.set(id, { type: "api_key", key: "rotated", source: "login" });
				},
			};
			await expect(updateCustomProvider(id, { apiKey: "k2" }, racing)).rejects.toThrow(
				"credentials changed during provider editing",
			);
			expect(await fs.readFile(configPath, "utf8")).toBe(original);
			await ours.credentials.poll();
			expect(ours.credentials.get(id)).toMatchObject({ key: "rotated" });
		} finally {
			ours.close();
			theirs.close();
		}
	});

	it("update restores a cleared key when rediscovery fails", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const original = await fs.readFile(configPath, "utf8");
		state.modelsFound = false;
		await expect(updateCustomProvider(id, { clearApiKey: true }, context)).rejects.toThrow("No chat models");
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("update restores every stored key, not just the first, when rediscovery fails", async () => {
		await fs.writeFile(configPath, discoveryOnly);
		await authStorage.credentials.set(id, [
			{ type: "api_key", key: "k-A", source: "login" },
			{ type: "api_key", key: "k-B", source: "login" },
		]);
		state.modelsFound = false;
		await expect(
			updateCustomProvider(id, { baseUrl: "https://new.example/v1", apiKey: "k-C" }, context),
		).rejects.toThrow("No chat models were discovered");
		const restored = authStorage.credentials
			.list(id)
			.map(row => (row.credential.type === "api_key" ? row.credential.key : undefined));
		expect(restored.sort()).toEqual(["k-A", "k-B"]);
	});

	it("update rolls back when the file changes while the new one is being staged", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const concurrent = `${await fs.readFile(configPath, "utf8")}# edited elsewhere\n`;
		const spy = editWhileStaging(configPath, concurrent);
		try {
			await expect(
				updateCustomProvider(id, { baseUrl: "https://new.example/v1", apiKey: "k2" }, context),
			).rejects.toThrow(CHANGED_ON_DISK);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	describe("when a hand edit blocks the undo of a failed update", () => {
		/** Lands `# hand edit` on models.yml during the first rediscovery, and makes every rediscovery fail. */
		function handEditDuringDiscovery(): CustomProviderContext {
			state.modelsFound = false;
			let handEdited = false;
			return {
				...context,
				refreshProvider: async () => {
					if (handEdited) return;
					handEdited = true;
					await fs.appendFile(configPath, "# hand edit\n");
				},
			};
		}

		async function failure(run: Promise<void>): Promise<Error> {
			const error = await run.then(
				() => undefined,
				(caught: Error) => caught,
			);
			expect(error).toBeInstanceOf(Error);
			return error as Error;
		}

		it("keeps the new key that a keyless-to-key update published, so file and credential agree", async () => {
			await fs.writeFile(configPath, discoveryOnly);
			const error = await failure(updateCustomProvider(id, { apiKey: "k2" }, handEditDuringDiscovery()));

			expect(error.message).toContain("Could not undo failed provider update");
			expect(error.message).toContain(CHANGED_ON_DISK);
			expect((error.cause as Error).message).toContain("No chat models were discovered");
			const text = await fs.readFile(configPath, "utf8");
			expect(text).toContain("# hand edit");
			expect(text).not.toContain("auth: none");
			expect(authStorage.credentials.get(id)).toMatchObject({ key: "k2" });
		});

		it("keeps the key cleared that a clear published, so file and credential agree", async () => {
			await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
			const error = await failure(updateCustomProvider(id, { clearApiKey: true }, handEditDuringDiscovery()));

			expect(error.message).toContain("Could not undo failed provider update");
			const text = await fs.readFile(configPath, "utf8");
			expect(text).toContain("# hand edit");
			expect(text).toContain("auth: none");
			expect(authStorage.credentials.has(id)).toBe(false);
		});
	});

	it("remove deletes the node and the stored key, keeping comments", async () => {
		await fs.writeFile(configPath, `${seeded}${discoveryProvider("other", "http://o.example/v1")}`);
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		await removeCustomProvider(id, context);
		const text = await fs.readFile(configPath, "utf8");
		expect(text).toContain("# keep this comment");
		expect(text).toContain("other:");
		expect(text).not.toContain(id);
		expect(authStorage.credentials.has(id)).toBe(false);
		expect(refreshProvider).toHaveBeenCalledWith(id);
	});

	it("remove keeps the provider and its key when the file changed concurrently", async () => {
		await fs.writeFile(configPath, seeded);
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		const concurrent = `${seeded}# edited elsewhere\n`;
		const spy = editWhileStaging(configPath, concurrent);
		try {
			await expect(removeCustomProvider(id, context)).rejects.toThrow(CHANGED_ON_DISK);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("remove puts the provider back when its credential cannot be deleted", async () => {
		await fs.writeFile(configPath, seeded);
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		vi.spyOn(authStorage.credentials, "remove").mockRejectedValue(new Error("credential store locked"));
		await expect(removeCustomProvider(id, context)).rejects.toThrow("credential store locked");
		expect(await fs.readFile(configPath, "utf8")).toBe(seeded);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("getCustomProvider reports the endpoint, whether a key is stored, and whether removal keeps it", async () => {
		expect(getCustomProvider(id, context.config, authStorage)).toBeUndefined();
		await fs.writeFile(configPath, seeded);
		context.config.invalidate();
		expect(getCustomProvider(id, context.config, authStorage)).toEqual({
			id,
			baseUrl: "https://old.example/v1",
			hasKey: false,
			keepsKeyOnRemove: false,
		});
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		expect(getCustomProvider(id, context.config, authStorage)?.hasKey).toBe(true);
		expect(getCustomProvider("absent", context.config, authStorage)).toBeUndefined();
	});

	it("isBuiltInProvider counts login-only and bundled-only providers as built in, custom ones not", () => {
		expect(isBuiltInProvider("litellm")).toBe(true);
		expect(isBuiltInProvider("minimax-cn")).toBe(true);
		expect(isBuiltInProvider("custom-gateway")).toBe(false);
	});

	it("getCustomProvider returns undefined for an unloadable models.yml", async () => {
		await fs.writeFile(configPath, "providers: [invalid\n");
		expect(getCustomProvider(id, context.config, authStorage)).toBeUndefined();
	});

	it.each([
		[
			"updateCustomProvider",
			(c: CustomProviderContext) => updateCustomProvider("ghost", { baseUrl: "http://x/v1" }, c),
		],
		["removeCustomProvider", (c: CustomProviderContext) => removeCustomProvider("ghost", c)],
	])("%s rejects IDs not in models.yml", async (_name, run) => {
		await expect(run(context)).rejects.toThrow('Provider "ghost" is not defined in models.yml.');
		await expect(fs.stat(configPath)).rejects.toThrow();
		await fs.writeFile(configPath, seeded);
		await expect(run(context)).rejects.toThrow('Provider "ghost" is not defined in models.yml.');
		expect(await fs.readFile(configPath, "utf8")).toBe(seeded);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	describe("providers without discovery", () => {
		const handWritten = [
			"providers:",
			"  handmade:",
			"    baseUrl: http://old.example/v1",
			"    api: openai-completions",
			"    apiKey: inline-secret",
			"    models:",
			"      - id: m1",
			"",
		].join("\n");

		it("edits a static provider without requiring a discovery result", async () => {
			await fs.writeFile(configPath, handWritten);
			state.discoverySucceeded = false; // nothing was discovered because nothing is discoverable
			await updateCustomProvider("handmade", { baseUrl: "http://new.example/v1" }, context);
			expect(loadProvider("handmade")?.baseUrl).toBe("http://new.example/v1");
		});

		it("edits a built-in provider's endpoint override without requiring a discovery result", async () => {
			await fs.writeFile(configPath, "providers:\n  anthropic:\n    baseUrl: https://proxy.example/v1\n");
			state.discoverySucceeded = false;
			await updateCustomProvider("anthropic", { baseUrl: "https://proxy2.example/v1" }, context);
			expect(loadProvider("anthropic")?.baseUrl).toBe("https://proxy2.example/v1");
		});

		it("still rolls a static provider back when it has no chat models afterwards", async () => {
			await fs.writeFile(configPath, handWritten);
			state.modelsFound = false;
			await expect(updateCustomProvider("handmade", { baseUrl: "http://new.example/v1" }, context)).rejects.toThrow(
				"No chat models were discovered",
			);
			expect(await fs.readFile(configPath, "utf8")).toBe(handWritten);
		});

		it("still requires a successful discovery for a provider that declares it", async () => {
			await fs.writeFile(configPath, discoveryOnly);
			state.discoverySucceeded = false;
			await expect(updateCustomProvider(id, { baseUrl: "http://new.example/v1" }, context)).rejects.toThrow(
				"No chat models were discovered",
			);
			expect(await fs.readFile(configPath, "utf8")).toBe(discoveryOnly);
		});
	});

	describe("no-op updates", () => {
		it("an update with nothing to change neither rewrites the file nor rediscovers", async () => {
			const crlf = `${discoveryOnly.replaceAll("  ", "    ").replaceAll("\n", "\r\n")}`;
			await fs.writeFile(configPath, crlf);
			await updateCustomProvider(id, {}, context);
			expect(await fs.readFile(configPath, "utf8")).toBe(crlf);
			expect(refreshProvider).not.toHaveBeenCalled();
		});

		it("an update to the endpoint it already has does not rewrite the file", async () => {
			await fs.writeFile(configPath, discoveryOnly);
			const open = vi.spyOn(nodeFs.promises, "open");
			await updateCustomProvider(id, { baseUrl: "https://old.example/v1" }, context);
			expect(open).not.toHaveBeenCalled();
			expect(await fs.readFile(configPath, "utf8")).toBe(discoveryOnly);
		});
	});

	describe("stored OAuth logins", () => {
		const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } as const;
		const proxyOverride = "providers:\n  anthropic:\n    baseUrl: https://proxy.example/v1\n";

		it.each([
			["clearing", { clearApiKey: true }],
			["replacing", { apiKey: "sk-new" }],
		])("refuses %s the OAuth credential of a provider", async (_verb, change) => {
			await fs.writeFile(configPath, proxyOverride);
			await authStorage.credentials.set("anthropic", oauth);
			await expect(updateCustomProvider("anthropic", change, context)).rejects.toThrow("/login or /logout");
			expect(await fs.readFile(configPath, "utf8")).toBe(proxyOverride);
			expect(authStorage.credentials.get("anthropic")).toMatchObject({ type: "oauth", access: "a" });
			expect(refreshProvider).not.toHaveBeenCalled();
		});

		it("refuses to clear the key of a provider declared with auth: oauth", async () => {
			const declared = `${discoveryOnly.replace("auth: none", "auth: oauth")}`;
			await fs.writeFile(configPath, declared);
			await expect(updateCustomProvider(id, { clearApiKey: true }, context)).rejects.toThrow("/login or /logout");
			expect(await fs.readFile(configPath, "utf8")).toBe(declared);
		});

		it("still changes the endpoint of an OAuth provider", async () => {
			await fs.writeFile(configPath, proxyOverride);
			await authStorage.credentials.set("anthropic", oauth);
			await updateCustomProvider("anthropic", { baseUrl: "https://proxy2.example/v1" }, context);
			expect(loadProvider("anthropic")?.baseUrl).toBe("https://proxy2.example/v1");
			expect(authStorage.credentials.get("anthropic")).toMatchObject({ type: "oauth" });
		});

		it("removing a built-in provider's override keeps its stored credential", async () => {
			await fs.writeFile(configPath, proxyOverride);
			await authStorage.credentials.set("anthropic", { type: "api_key", key: "sk-own", source: "login" });
			expect(getCustomProvider("anthropic", context.config, authStorage)?.keepsKeyOnRemove).toBe(true);
			await removeCustomProvider("anthropic", context);
			expect(await fs.readFile(configPath, "utf8")).not.toContain("anthropic");
			expect(authStorage.credentials.get("anthropic")).toMatchObject({ key: "sk-own" });
		});

		it("removing a discovery-only built-in provider's override keeps its stored credential", async () => {
			const litellmOverride = "providers:\n  litellm:\n    baseUrl: http://127.0.0.1:4000\n";
			await fs.writeFile(configPath, litellmOverride);
			await authStorage.credentials.set("litellm", { type: "api_key", key: "sk-litellm-master", source: "login" });
			expect(getCustomProvider("litellm", context.config, authStorage)?.keepsKeyOnRemove).toBe(true);
			await removeCustomProvider("litellm", context);
			expect(await fs.readFile(configPath, "utf8")).not.toContain("litellm");
			expect(authStorage.credentials.get("litellm")).toMatchObject({ key: "sk-litellm-master" });
		});
	});
});

describe("models.yml integrity", () => {
	let fixture: Fixture;
	let { directory, authStorage, configPath, refreshProvider, context } = {} as Fixture;

	beforeEach(async () => {
		fixture = await createFixture("omp-custom-provider-integrity-");
		({ directory, authStorage, configPath, refreshProvider, context } = fixture);
	});

	afterEach(() => disposeFixture(fixture));

	const newUrl = "https://new.example/v1";

	/** Changing one URL must change exactly that text, whatever the file's line endings, BOM and indentation. */
	async function expectOnlyUrlChanges(seed: string): Promise<void> {
		await fs.writeFile(configPath, seed);
		await updateCustomProvider("target", { baseUrl: newUrl }, context);
		expect(await fs.readFile(configPath, "utf8")).toBe(seed.replace("https://old.example/v1", newUrl));
	}

	const twoProviders = (indent: number) =>
		`# top comment\nproviders:\n${discoveryProvider("other", "http://o.example/v1", indent)}${discoveryProvider("target", "https://old.example/v1", indent)}`;

	it("keeps 4-space indentation", async () => {
		await expectOnlyUrlChanges(twoProviders(4));
	});

	it("keeps CRLF line endings", async () => {
		await expectOnlyUrlChanges(twoProviders(2).replaceAll("\n", "\r\n"));
	});

	it("keeps a byte-order mark", async () => {
		await expectOnlyUrlChanges(`\uFEFF${twoProviders(2)}`);
	});

	it("keeps CRLF, indentation and BOM when adding a provider", async () => {
		const seed = `\uFEFF${twoProviders(4).replaceAll("\n", "\r\n")}`;
		await fs.writeFile(configPath, seed);
		await addCustomProvider({ id: "added", baseUrl: newUrl, apiKey: "k" }, context);
		const written = await fs.readFile(configPath, "utf8");
		expect(written.startsWith(seed.trimEnd())).toBe(true);
		expect(written).toContain("\r\n        baseUrl: https://new.example/v1");
		expect(written).not.toMatch(/(?<!\r)\n/);
	});

	it("refuses to write when serialization would change another provider or a root key", async () => {
		const seed = `notes: [a, b]\nproviders:\n${discoveryProvider("other", "http://o.example/v1")}${discoveryProvider("target", "https://old.example/v1")}`;
		await fs.writeFile(configPath, seed);
		const realParse = YAML.parse.bind(YAML);
		for (const tamper of [
			(root: Record<string, unknown>) => ({
				...root,
				providers: { ...(root.providers as Record<string, unknown>), other: { auth: "none" } },
			}),
			(root: Record<string, unknown>) => ({ ...root, notes: ["a"] }),
		]) {
			// Simulate a serializer that reads back differently only once the edit is applied.
			const spy = vi.spyOn(YAML, "parse").mockImplementation(text => {
				const root = realParse(text) as Record<string, unknown>;
				return String(text).includes(newUrl) ? tamper(root) : root;
			});
			try {
				await expect(updateCustomProvider("target", { baseUrl: newUrl }, context)).rejects.toThrow(
					'Refusing to write models.yml: the edit would change more than provider "target".',
				);
			} finally {
				spy.mockRestore();
			}
			expect(await fs.readFile(configPath, "utf8")).toBe(seed);
		}
	});

	it("refuses to edit a file whose provider IDs collapse into one entry when loaded", async () => {
		const seed = `providers:\n${discoveryProvider("123", "http://a.example/v1")}${discoveryProvider('"123"', "http://b.example/v1")}`;
		await fs.writeFile(configPath, seed);
		await expect(addCustomProvider({ id: "other", baseUrl: newUrl, apiKey: "" }, context)).rejects.toThrow(
			"collapse into one entry",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(seed);
		expect(refreshProvider).not.toHaveBeenCalled();
	});

	it.each(["123", "true", "null"])("treats the non-string YAML key %s as a provider ID", async key => {
		const seed = `providers:\n${discoveryProvider(key, "https://old.example/v1")}`;
		await fs.writeFile(configPath, seed);

		await expect(addCustomProvider({ id: key, baseUrl: newUrl, apiKey: "k" }, context)).rejects.toThrow(
			"already configured",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(seed);

		await updateCustomProvider(key, { baseUrl: newUrl }, context);
		expect(await fs.readFile(configPath, "utf8")).toBe(seed.replace("https://old.example/v1", newUrl));

		await removeCustomProvider(key, context);
		expect(await fs.readFile(configPath, "utf8")).not.toContain("baseUrl");
		expect(authStorage.credentials.has(key)).toBe(false);
	});

	it("explains a YAML alias that deleting a provider would break, and leaves the file alone", async () => {
		const seed = `providers:\n  a: &shared\n    baseUrl: http://a.example/v1\n    api: openai-completions\n    auth: none\n    discovery:\n      type: openai-models-list\n  b: *shared\n`;
		await fs.writeFile(configPath, seed);
		await expect(removeCustomProvider("a", context)).rejects.toThrow("YAML alias");
		expect(await fs.readFile(configPath, "utf8")).toBe(seed);
	});

	it("writes through a symlinked models.yml, and an undo keeps the link too", async () => {
		const realPath = path.join(directory, "dotfiles", "models.real.yml");
		await fs.mkdir(path.dirname(realPath));
		const seed = `providers:\n${discoveryProvider("target", "https://old.example/v1")}`;
		await fs.writeFile(realPath, seed);
		await fs.symlink(realPath, configPath);

		await updateCustomProvider("target", { baseUrl: newUrl }, context);
		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(realPath, "utf8")).toBe(seed.replace("https://old.example/v1", newUrl));

		fixture.state.modelsFound = false;
		await expect(updateCustomProvider("target", { baseUrl: "https://again.example/v1" }, context)).rejects.toThrow(
			"No chat models were discovered",
		);
		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(realPath, "utf8")).toBe(seed.replace("https://old.example/v1", newUrl));
	});

	it("keeps the permissions of an existing models.yml through an edit and an undo", async () => {
		await fs.writeFile(configPath, `providers:\n${discoveryProvider("target", "https://old.example/v1")}`);
		await fs.chmod(configPath, 0o640);
		const mode = async () => (await fs.stat(configPath)).mode & 0o777;

		await updateCustomProvider("target", { baseUrl: newUrl }, context);
		expect(await mode()).toBe(0o640);

		fixture.state.modelsFound = false;
		await expect(updateCustomProvider("target", { baseUrl: "https://again.example/v1" }, context)).rejects.toThrow(
			"No chat models were discovered",
		);
		expect(await mode()).toBe(0o640);
	});
});

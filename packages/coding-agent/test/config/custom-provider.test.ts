import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	addCustomProvider,
	type CustomProviderContext,
	getCustomProvider,
	removeCustomProvider,
	updateCustomProvider,
} from "../../src/config/custom-provider";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";

/** Make the second file read write `content` to `filePath` first, simulating a concurrent editor. */
function editOnSecondRead(filePath: string, content: string) {
	const realReadFile = fs.readFile;
	let reads = 0;
	return vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
		reads += 1;
		if (reads === 2) await fs.writeFile(filePath, content);
		return realReadFile(...args);
	}) as typeof fs.readFile);
}

describe("addCustomProvider", () => {
	let directory: string;
	let authStorage: AuthStorage;
	let context: CustomProviderContext;
	let configPath: string;
	let refreshProvider: (id: string) => Promise<void>;
	let modelsFound: boolean;
	let discoverySucceeded: boolean;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-provider-"));
		configPath = path.join(directory, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
		refreshProvider = vi.fn(async () => {});
		modelsFound = true;
		discoverySucceeded = true;
		context = {
			authStorage,
			config: ModelsConfigFile.relocate(configPath),
			refreshProvider,
			discoverySucceeded: () => discoverySucceeded,
			hasChatModels: () => modelsFound,
		};
	});

	afterEach(async () => {
		authStorage.close();
		await fs.rm(directory, { recursive: true, force: true });
	});

	const input = { id: "my-gateway", baseUrl: "https://gateway.example/v1///", apiKey: "top-secret" };

	it("stores the key in AuthStorage and atomically writes a private provider config", async () => {
		await addCustomProvider(input, context);
		const config = context.config!.tryLoad();
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

	it("aborts when models.yml changes between read and publish", async () => {
		const concurrent = "providers:\n  concurrent:\n    baseUrl: http://c.example/v1\n    auth: none\n";
		await fs.writeFile(configPath, "providers:\n  other:\n    baseUrl: http://o.example/v1\n    auth: none\n");
		const spy = editOnSecondRead(configPath, concurrent);
		try {
			await expect(addCustomProvider(input, context)).rejects.toThrow("models.yml changed on disk; retry");
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
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
		const config = context.config!.tryLoad();
		expect(config.status).toBe("ok");
		if (config.status === "ok") expect(config.value.providers?.[input.id]?.auth).toBe("none");
		expect(registry.getAvailable().some(model => model.provider === input.id)).toBe(true);
	});

	it("rolls back the file and key when discovery yields no chat models", async () => {
		modelsFound = false;
		await expect(addCustomProvider(input, context)).rejects.toThrow("No chat models were discovered");
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.has(input.id)).toBe(false);
	});

	it("rejects cached chat models when the online discovery failed", async () => {
		modelsFound = true;
		discoverySucceeded = false;
		await expect(addCustomProvider(input, context)).rejects.toThrow("No chat models were discovered");
		expect(refreshProvider).toHaveBeenCalledWith(input.id);
		await expect(fs.stat(configPath)).rejects.toThrow();
		expect(authStorage.credentials.has(input.id)).toBe(false);
	});
});

describe("editing and removing custom providers", () => {
	let directory: string;
	let authStorage: AuthStorage;
	let context: CustomProviderContext;
	let configPath: string;
	let refreshProvider: (id: string) => Promise<void>;
	let modelsFound: boolean;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-provider-edit-"));
		configPath = path.join(directory, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
		refreshProvider = vi.fn(async () => {});
		modelsFound = true;
		context = {
			authStorage,
			config: ModelsConfigFile.relocate(configPath),
			refreshProvider,
			discoverySucceeded: () => true,
			hasChatModels: () => modelsFound,
		};
	});

	afterEach(async () => {
		authStorage.close();
		await fs.rm(directory, { recursive: true, force: true });
	});

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

	function loadProvider() {
		const loaded = context.config!.tryLoad();
		if (loaded.status !== "ok") throw new Error(`models.yml did not load: ${loaded.status}`);
		return loaded.value.providers?.[id];
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
		modelsFound = false;
		await expect(
			updateCustomProvider(id, { baseUrl: "https://new.example/v1", apiKey: "k2" }, context),
		).rejects.toThrow("No chat models were discovered");
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("update restores a cleared key when rediscovery fails", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const original = await fs.readFile(configPath, "utf8");
		modelsFound = false;
		await expect(updateCustomProvider(id, { clearApiKey: true }, context)).rejects.toThrow("No chat models");
		expect(await fs.readFile(configPath, "utf8")).toBe(original);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("update restores the key when models.yml changes between read and publish", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const concurrent = `${await fs.readFile(configPath, "utf8")}# edited elsewhere\n`;
		const spy = editOnSecondRead(configPath, concurrent);
		try {
			await expect(updateCustomProvider(id, { apiKey: "k2" }, context)).rejects.toThrow(
				"models.yml changed on disk; retry",
			);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("update still restores the key when the file cannot be restored, and reports both", async () => {
		await addCustomProvider({ id, baseUrl: "https://gateway.example/v1", apiKey: "k1" }, context);
		const concurrent = `${await fs.readFile(configPath, "utf8")}# edited elsewhere\n`;
		refreshProvider = vi.fn(async () => {
			await fs.writeFile(configPath, concurrent);
		});
		modelsFound = false;
		await expect(updateCustomProvider(id, { apiKey: "k2" }, { ...context, refreshProvider })).rejects.toThrow(
			"Could not undo",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("remove deletes the node and the stored key, keeping comments", async () => {
		await fs.writeFile(
			configPath,
			`${seeded}  other:\n    baseUrl: http://o.example/v1\n    api: openai-completions\n    auth: none\n    discovery:\n      type: openai-models-list\n`,
		);
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
		const spy = editOnSecondRead(configPath, concurrent);
		try {
			await expect(removeCustomProvider(id, context)).rejects.toThrow("models.yml changed on disk; retry");
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
		expect(authStorage.credentials.get(id)).toMatchObject({ key: "k1" });
	});

	it("getCustomProvider reports the endpoint and whether a key is stored", async () => {
		expect(getCustomProvider(id, context.config, authStorage)).toBeUndefined();
		await fs.writeFile(configPath, seeded);
		context.config!.invalidate();
		expect(getCustomProvider(id, context.config, authStorage)).toEqual({
			id,
			baseUrl: "https://old.example/v1",
			hasKey: false,
		});
		await authStorage.credentials.set(id, { type: "api_key", key: "k1", source: "login" });
		expect(getCustomProvider(id, context.config, authStorage)?.hasKey).toBe(true);
		expect(getCustomProvider("absent", context.config, authStorage)).toBeUndefined();
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
});

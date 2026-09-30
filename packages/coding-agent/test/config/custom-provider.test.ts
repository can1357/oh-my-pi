import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { addCustomProvider, type CustomProviderContext } from "../../src/config/custom-provider";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";

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
		const realReadFile = fs.readFile;
		let reads = 0;
		const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
			reads += 1;
			if (reads === 2) await fs.writeFile(configPath, concurrent);
			return realReadFile(...args);
		});
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

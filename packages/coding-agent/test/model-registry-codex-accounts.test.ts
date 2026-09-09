import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { writeModelCache } from "@pk-nerdsaver-ai/pi-catalog/model-cache";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-catalog/types";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

describe("Codex account discovery in the registry", () => {
	let directory: string;
	let auth: AuthStorage;
	let modelsPath: string;
	let transport: FetchImpl;
	let server: Bun.Server<undefined>;
	const requests: string[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		directory = await mkdtemp(join(tmpdir(), "registry-codex-accounts-"));
		modelsPath = join(directory, "models.json");
		auth = await AuthStorage.create(join(directory, "agent.db"));
		await auth.set(
			"openai-codex",
			["first", "second"].map(accountId => ({
				type: "oauth" as const,
				accountId,
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 3_600_000,
			})),
		);
		requests.length = 0;
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/version") return Response.json({ version: "0.153.4" });
				const account = request.headers.get("chatgpt-account-id") ?? "";
				requests.push(account);
				if (request.headers.get("authorization") !== `Bearer access-${account}`)
					return new Response(null, { status: 401 });
				return Response.json({
					models: (account === "second" ? ["gpt-5.5", "gpt-6-astra"] : ["gpt-5.5"]).map(slug => ({
						slug,
						supported_in_api: true,
					})),
				});
			},
		});
		transport = (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "registry.npmjs.org") return fetch(new URL("/version", server.url), init);
			if (url.hostname === "chatgpt.com") return fetch(new URL(`${url.pathname}${url.search}`, server.url), init);
			return Promise.reject(new Error("Unexpected provider discovery"));
		};
	});

	afterEach(async () => {
		auth.close();
		await server.stop(true);
		resetSettingsForTest();
		await removeWithRetries(directory);
	});

	it("ignores a fresh provider-wide cache and loads the union of both accounts", async () => {
		writeModelCache(
			"openai-codex",
			Date.now(),
			[
				buildModel({
					id: "legacy-only",
					name: "Legacy",
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				}),
			],
			true,
			"",
			join(directory, "models.db"),
		);
		const registry = new ModelRegistry(auth, modelsPath, { fetch: transport });
		expect(registry.find("openai-codex", "legacy-only")).toBeUndefined();
		await registry.refreshProvider("openai-codex");
		expect(registry.find("openai-codex", "gpt-6-astra")).toBeDefined();
		expect(
			registry
				.getAll()
				.filter(model => model.provider === "openai-codex")
				.map(model => model.id)
				.toSorted(),
		).toEqual(["gpt-5.5", "gpt-6-astra"]);
		expect(requests.toSorted()).toEqual(["first", "second"]);
		const astra = registry.find("openai-codex", "gpt-6-astra");
		if (!astra) throw new Error("Astra was not discovered");
		const resolver = registry.resolver(astra, "inference-selection");
		expect(await resolver({ lastChance: false, error: undefined })).toBe("access-second");
		await expect(
			Promise.resolve(
				resolver({
					lastChance: false,
					error: undefined,
					signal: AbortSignal.abort(),
				}),
			),
		).rejects.toThrow("aborted");
	}, 20000);

	it("restores the same account union at cold startup without refetching", async () => {
		const registry = new ModelRegistry(auth, modelsPath, { fetch: transport });
		await registry.refreshProvider("openai-codex");
		const restarted = new ModelRegistry(auth, modelsPath, { fetch: transport });
		expect(restarted.find("openai-codex", "gpt-6-astra")).toBeDefined();
		expect(restarted.getAll().filter(model => model.provider === "openai-codex")).toHaveLength(2);
		await restarted.refreshProvider("openai-codex", "online-if-uncached");
		expect(requests).toHaveLength(2);
	}, 20000);

	it("does not restore a removed account's Astra catalog", async () => {
		const registry = new ModelRegistry(auth, modelsPath, { fetch: transport });
		await registry.refreshProvider("openai-codex");
		await auth.set("openai-codex", {
			type: "oauth",
			accountId: "first",
			access: "access-first",
			refresh: "refresh-first",
			expires: Date.now() + 3_600_000,
		});
		const restarted = new ModelRegistry(auth, modelsPath, { fetch: transport });
		expect(restarted.find("openai-codex", "gpt-6-astra")).toBeUndefined();
		await restarted.refreshProvider("openai-codex");
		expect(
			restarted
				.getAll()
				.filter(model => model.provider === "openai-codex")
				.map(model => model.id),
		).toEqual(["gpt-5.5"]);
	}, 20000);
});

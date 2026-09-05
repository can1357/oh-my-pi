import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, streamSimple } from "@pk-nerdsaver-ai/pi-ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";
import { FastStreamRouter } from "../../src/routing/fast-stream-router";
import { handleRouteSlashCommand } from "../../src/slash-commands/helpers/route";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const providers = {
	"route-test-primary": {
		baseUrl: "https://primary.invalid/v1",
		api: "openai-completions",
		apiKey: "FAKE_PRIMARY_KEY",
		models: [{ id: "shared" }],
	},
	"route-test-secondary": {
		baseUrl: "https://secondary.invalid/v1",
		api: "openai-completions",
		apiKey: "FAKE_SECONDARY_KEY",
		models: [{ id: "shared" }],
	},
};
const initialConfig = {
	providers,
	routing: {
		enabled: true,
		pools: { manual: { members: ["route-test-primary/shared", "route-test-secondary/shared"] } },
	},
};

describe("/route configuration lifecycle", () => {
	let directory: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let outputs: string[];
	let runtime: SlashCommandRuntime;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "route-command-"));
		modelsPath = join(directory, "models.json");
		await Bun.write(modelsPath, JSON.stringify(initialConfig));
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsPath);
		outputs = [];
		// The command's model registry and disk lifecycle are real. Only the UI
		// output sink is supplied by this headless command host.
		runtime = {
			output: async (text: string) => {
				outputs.push(text);
			},
			session: { modelRegistry: registry },
		} as unknown as SlashCommandRuntime;
	});

	afterEach(async () => {
		authStorage.close();
		await rm(directory, { recursive: true, force: true });
	});

	async function run(args: string) {
		return handleRouteSlashCommand({ name: "route", args, text: `/route ${args}` }, runtime);
	}

	it("reports the active relocated configuration without changing it", async () => {
		const before = await Bun.file(modelsPath).text();
		await run("status");
		expect(outputs[0]).toContain("ENABLED");
		expect(outputs[0]).toContain("manual");
		expect(await Bun.file(modelsPath).text()).toBe(before);
	});

	it("persists off/on, refreshes the registry, and preserves providers and pools", async () => {
		const primary = registry.find("route-test-primary", "shared")!;
		expect(registry.resolvePool(primary)?.candidates).toHaveLength(2);
		await run("off");
		expect(registry.poolManager.isEnabled).toBe(false);
		expect(registry.resolvePool(primary)).toBeNull();
		const disabled = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(disabled.status).toBe("ok");
		expect(disabled.value?.providers).toMatchObject(providers);
		expect(disabled.value?.routing?.pools).toEqual(initialConfig.routing.pools);
		expect(disabled.value?.routing?.enabled).toBe(false);
		await run("on");
		expect(registry.resolvePool(primary)?.candidates).toHaveLength(2);
	});

	it.each([
		["syntax", '{"providers":'],
		["schema", JSON.stringify({ ...initialConfig, routing: { enabled: "yes" } })],
		["provider validation", JSON.stringify({ providers: { invalid: { models: [{ id: "no-endpoint" }] } } })],
	])("refuses all mutations after a %s error without overwriting the file", async (_label, invalid) => {
		// Registry startup already cached a valid file. Commands must re-read it.
		await Bun.write(modelsPath, invalid);
		for (const args of ["on", "off", "pool a b custom", "veto a b", "unpool manual"]) {
			expect(await run(args)).toEqual({ consumed: true });
			expect(outputs.at(-1)).toContain("Models configuration was not changed");
			expect(await Bun.file(modelsPath).text()).toBe(invalid);
		}
		expect(registry.poolManager.isEnabled).toBe(true);
	});

	it("refuses writes after a read error", async () => {
		await rm(modelsPath);
		await mkdir(modelsPath);
		await run("off");
		expect(outputs[0]).toContain("Models configuration was not changed");
		expect((await stat(modelsPath)).isDirectory()).toBe(true);
		expect(registry.poolManager.isEnabled).toBe(true);
	});

	it("can initialize a genuinely missing configuration", async () => {
		await rm(modelsPath);
		await run("on");
		expect(ModelsConfigFile.relocate(modelsPath).tryLoad().value?.routing?.enabled).toBe(true);
		expect(registry.poolManager.isEnabled).toBe(true);
	});

	it("applies pool, veto, and unpool mutations without discarding provider definitions", async () => {
		await run("pool route-test-primary/shared route-test-secondary/shared added");
		await run("veto route-test-primary/shared route-test-secondary/shared");
		await run("unpool added");
		const config = ModelsConfigFile.relocate(modelsPath).tryLoad().value;
		expect(config?.providers).toMatchObject(providers);
		expect(config?.routing?.pools?.added).toBeUndefined();
		expect(config?.routing?.pools?.manual).toBeDefined();
		expect(registry.resolvePool(registry.find("route-test-primary", "shared")!)).toBeNull();
	});

	it("resets real provider cooldowns without writing configuration", async () => {
		const before = await Bun.file(modelsPath).text();
		registry.poolManager.markFailure(
			registry.find("route-test-primary", "shared")!,
			new Error("429 Too Many Requests"),
		);
		expect(registry.poolManager.getHealthSnapshot().size).toBe(1);
		await run("reset");
		expect(registry.poolManager.getHealthSnapshot().size).toBe(0);
		expect(await Bun.file(modelsPath).text()).toBe(before);
	});

	it("uses the actual target's registry credential at the HTTP boundary", async () => {
		const requests: Headers[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				requests.push(new Headers(request.headers));
				return new Response(
					'data: {"id":"response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		try {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					...initialConfig,
					providers: {
						...providers,
						"route-test-secondary": {
							...providers["route-test-secondary"],
							baseUrl: `${server.url}v1`,
							headers: { "X-Target": "secondary" },
						},
					},
				}),
			);
			await registry.refresh("offline");
			const primary = registry.find("route-test-primary", "shared")!;
			registry.poolManager.markFailure(primary, new Error("429 Too Many Requests"));
			const router = new FastStreamRouter(registry.poolManager, target => registry.resolver(target, "route-test"));
			for (const apiKey of ["FAKE_PRIMARY_KEY", registry.resolver(primary, "route-test")]) {
				const output = router.streamWithRouting(
					primary,
					{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
					{ apiKey, headers: { Authorization: "Bearer FAKE_PRIMARY_HEADER", "X-Primary-Secret": "private" } },
					registry.resolvePool(primary),
					streamSimple,
					"route-test",
				);
				const result = await output.result();
				expect(result.stopReason).toBe("stop");
				expect(result.provider).toBe("route-test-secondary");
			}
			expect(requests).toHaveLength(2);
			for (const headers of requests) {
				expect(headers.get("authorization")).toBe("Bearer FAKE_SECONDARY_KEY");
				expect(headers.get("x-primary-secret")).toBeNull();
				expect(headers.get("x-target")).toBe("secondary");
			}
		} finally {
			await server.stop(true);
		}
	});
});

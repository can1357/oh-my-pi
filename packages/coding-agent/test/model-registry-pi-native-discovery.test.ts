import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("pi-native gateway discovery", () => {
	let dir: string;
	let auth: AuthStorage;
	let configPath: string;
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-roster-"));
		configPath = path.join(dir, "models.json");
		auth = await AuthStorage.create(":memory:");
	});
	afterEach(() => {
		auth.close();
		removeSyncWithRetries(dir);
	});
	const configure = async (config: Record<string, unknown>) => {
		await Bun.write(
			configPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						baseUrl: "https://gateway.example",
						transport: "pi-native",
						...config,
					},
				},
			}),
		);
	};

	test("discovers only its gateway chat rows and never forwards a bearer upstream", async () => {
		await configure({ apiKey: "gateway-secret", headers: { "X-Team": "team" } });
		const requests: string[] = [];
		const registry = new ModelRegistry(auth, configPath, {
			fetch: async (input, init) => {
				requests.push(String(input));
				expect(init?.redirect).toBe("manual");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-secret");
				expect(new Headers(init?.headers).get("x-team")).toBe("team");
				return Response.json({
					data: [
						{
							id: "openai-codex/gpt-6.2-sol",
							api: "openai-codex-responses",
							display_name: "GPT 6.2 Sol",
							context_length: 200000,
							max_output_tokens: 32000,
							supports_tools: false,
						},
						{ id: "other/gpt-6.2-sol" },
						{ id: "openai-codex/gpt-image-2", kind: "image" },
					],
				});
			},
		});
		const bundledChat = registry
			.getAll("chat")
			.find(candidate => candidate.provider === "openai-codex" && candidate.id !== "gpt-6.2-sol");
		if (!bundledChat) throw new Error("expected a bundled Codex chat model");
		await registry.refreshProvider("openai-codex", "online");
		expect(requests).toEqual(["https://gateway.example/v1/models"]);
		const model = registry.find("openai-codex", "gpt-6.2-sol");
		expect(model?.id).toBe("gpt-6.2-sol");
		expect(model?.baseUrl).toBe("https://gateway.example");
		expect(model?.transport).toBe("pi-native");
		expect(model?.supportsTools).toBe(false);
		expect(model?.contextWindow).toBe(200000);
		expect(registry.find(bundledChat.provider, bundledChat.id)).toBeUndefined();
		expect(registry.find("openai-codex", "openai-codex/gpt-6.2-sol")).toBeUndefined();
		expect(registry.find("openai-codex", "gpt-image-2")?.kind).toBe("image");
	});

	test("skips discovery without a configured gateway key", async () => {
		await configure({});
		let calls = 0;
		const registry = new ModelRegistry(auth, configPath, {
			fetch: async () => {
				calls++;
				throw Error("unexpected request");
			},
		});
		await registry.refreshProvider("openai-codex", "online");
		expect(calls).toBe(0);
	});

	test("retains cached roster on gateway failure and scopes cache to configured key", async () => {
		await configure({ apiKey: "key-one" });
		const first = new ModelRegistry(auth, configPath, {
			fetch: async () => Response.json({ data: [{ id: "openai-codex/gpt-6.2-sol" }] }),
		});
		const bundledChat = first
			.getAll("chat")
			.find(candidate => candidate.provider === "openai-codex" && candidate.id !== "gpt-6.2-sol");
		if (!bundledChat) throw new Error("expected a bundled Codex chat model");
		await first.refreshProvider("openai-codex", "online");
		const failed = new ModelRegistry(auth, configPath, {
			fetch: async () => new Response("unavailable", { status: 503 }),
		});
		await failed.refreshProvider("openai-codex", "online");
		expect(failed.find("openai-codex", "gpt-6.2-sol")).toBeDefined();
		expect(failed.find(bundledChat.provider, bundledChat.id)).toBeUndefined();
		await configure({ apiKey: "key-two" });
		const other = new ModelRegistry(auth, configPath, {
			fetch: async () => new Response("unavailable", { status: 503 }),
		});
		expect(other.find("openai-codex", "gpt-6.2-sol")).toBeUndefined();
	});
});

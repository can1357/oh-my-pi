import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Issue #1528: auto-discovered OpenAI-compatible models defaulted to
 * `maxTokens: 8192`, which made providers (DeepSeek, etc.) drop the streaming
 * connection mid-response on large `write`/`edit` tool calls and surfaced as
 * Bun's opaque "socket connection was closed unexpectedly". The cap is now
 * `DISCOVERY_DEFAULT_MAX_TOKENS = 32_768` (`packages/coding-agent/src/config/
 * model-registry.ts`). These tests pin the externally observable default for
 * every discovery branch that previously hardcoded 8192.
 */
describe("issue #1528 discovery maxTokens default", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-1528-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("openai-models-list discovery returns maxTokens=32768 when API advertises no output limit", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  deepseek-compat:",
				"    baseUrl: https://api.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url !== "https://api.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "vllm-lab-fork-a1" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("deepseek-compat");

		const model = registry.find("deepseek-compat", "vllm-lab-fork-a1");
		expect(model?.maxTokens).toBe(32_768);
	});

	test("proxy (anthropic+openai) discovery returns maxTokens=32768 for openai-routed models without bundled limits", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  newapi-proxy:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: proxy",
			].join("\n"),
		);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url !== "https://proxy.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(
				JSON.stringify({
					data: [{ id: "newapi-private-openai-model", supported_endpoint_types: ["openai"] }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("newapi-proxy");

		const model = registry.find("newapi-proxy", "newapi-private-openai-model");
		expect(model?.maxTokens).toBe(32_768);
	});

	test("proxy discovery keeps anthropic-routed models at the 8192 default to stay under Claude 3.x output caps", async () => {
		// Anthropic's stream converter sends `max_tokens` as
		// `(model.maxTokens / 3) | 0`. The raised 32K discovery cap would
		// surface as 10,922 — above the 8,192 hard cap on classic Claude 3.x
		// models — so the proxy branch keeps the conservative 8K default on
		// the anthropic route.
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  newapi-proxy:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKey: sk-test",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: proxy",
			].join("\n"),
		);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url !== "https://proxy.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-3-5-sonnet", supported_endpoint_types: ["anthropic"] },
						{ id: "claude-3-5-haiku", supported_endpoint_types: ["anthropic", "openai"] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("newapi-proxy");

		const sonnet = registry.find("newapi-proxy", "claude-3-5-sonnet");
		expect(sonnet?.api).toBe("anthropic-messages");
		expect(sonnet?.maxTokens).toBe(8192);

		// Dual-endpoint advertisements prefer the anthropic route in the proxy
		// branch, so they also stay capped at 8K.
		const haiku = registry.find("newapi-proxy", "claude-3-5-haiku");
		expect(haiku?.api).toBe("anthropic-messages");
		expect(haiku?.maxTokens).toBe(8192);
	});

	test("openai-models-list discovery keeps anthropic-messages providers at the 8192 default", async () => {
		// The validator allows `api: anthropic-messages` with a bare
		// openai-models-list discovery (e.g. third-party Anthropic catalogs
		// served behind a `/v1/models` endpoint). Same divisor reasoning as
		// the proxy branch applies: 32K would surface as 10,922 requested
		// output tokens, above the Claude 3.x hard cap.
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  third-party-anthropic:",
				"    baseUrl: https://anthropic-reseller.example.com/v1",
				"    apiKey: sk-test",
				"    api: anthropic-messages",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url !== "https://anthropic-reseller.example.com/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("third-party-anthropic");

		const sonnet = registry.find("third-party-anthropic", "claude-3-5-sonnet");
		expect(sonnet?.api).toBe("anthropic-messages");
		expect(sonnet?.maxTokens).toBe(8192);
	});
});

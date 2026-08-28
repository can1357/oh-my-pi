/**
 * Regression: issue #6162.
 *
 * `modelRoles.default` set to a `models.yml` discovery provider model
 * (a custom OpenAI-compatible endpoint with `discovery.type: openai-models-list`)
 * was silently replaced on a cache-cold interactive launch by an unrelated
 * authenticated provider's default. The configured provider ships no static
 * models, so the static+cached catalog the SDK resolves against at startup is
 * empty; the online discovery pass in `main.ts` runs only AFTER
 * `createAgentSession` returns. Unlike issue #6114 (no other authed provider, so
 * the fallback resolved nothing and the later discovery-retry gate fired), here
 * a competing bundled provider key resolves `pickDefaultAvailableModel` first,
 * so the `!model` discovery-retry gate never runs and the configured default is
 * lost. The SDK now runs the discovery pass whenever the configured default role
 * is still unresolved and discoverable providers exist, before accepting the
 * bundled-provider fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("issue #6162 fresh launch default role from models.yml discovery provider", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-config-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const baseUrl = "https://example.com/v1";

	/** Custom provider `/v1/models` (openai-models-list discovery). */
	function mockDiscovery(models: string[]): FetchImpl {
		return async input => {
			const url = String(input);
			if (url === `${baseUrl}/models`) {
				return Response.json({ data: models.map(id => ({ id })) });
			}
			return new Response("not found", { status: 404 });
		};
	}

	test("selects the configured models.yml default over a competing bundled provider on cold cache", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-provider:",
				`    baseUrl: ${baseUrl}`,
				"    api: openai-completions",
				"    apiKey: MY_API_KEY",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// The configured provider's key resolves the role model; a competing
		// bundled provider key would otherwise win the startup fallback via
		// `pickDefaultAvailableModel`.
		authStorage.setRuntimeApiKey("my-provider", "test-provider-key");
		authStorage.setRuntimeApiKey("openai", "test-openai-key");

		// Fresh registry: no cached my-provider catalog on disk, so the static
		// catalog the SDK resolves against at startup is empty for the provider.
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: mockDiscovery(["some-model"]),
		});

		const settings = Settings.isolated();
		settings.setModelRole("default", "my-provider/some-model");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("my-provider");
			expect(session.model?.id).toBe("some-model");
		} finally {
			await session.dispose();
		}
	});
});

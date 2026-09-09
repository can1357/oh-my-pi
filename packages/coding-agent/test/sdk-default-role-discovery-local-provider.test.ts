/**
 * Regression: issue #6114.
 *
 * `modelRoles.default` set to a discovery-only local provider model (LM Studio,
 * Ollama, llama.cpp) was ignored on fresh interactive launches, surfacing as
 * "No models available". Those providers ship no bundled models, so the
 * static+cached catalog the SDK resolves against at startup is empty on a
 * cache-cold boot; the online discovery pass in `main.ts` runs only AFTER
 * `createAgentSession` returns. `omp models` (which awaits discovery) listed the
 * models, but the interactive session degraded. The SDK now awaits one
 * cache-aware discovery pass and retries resolution when the initial fallback
 * fails and discoverable providers exist.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("issue #6114 fresh launch default role from discovery-only local provider", () => {
	let tempDir: string;
	let originalLmStudioBaseUrl: string | undefined;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-local-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		originalLmStudioBaseUrl = Bun.env.LM_STUDIO_BASE_URL;
		delete Bun.env.LM_STUDIO_BASE_URL;
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (originalLmStudioBaseUrl === undefined) {
			delete Bun.env.LM_STUDIO_BASE_URL;
		} else {
			Bun.env.LM_STUDIO_BASE_URL = originalLmStudioBaseUrl;
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/** LM Studio `/v1/models`; native metadata probe (`/api/v0/models`) 404s. */
	function mockLmStudio(models: string[], baseUrl = "http://127.0.0.1:1234/v1"): FetchImpl {
		return async input => {
			const url = String(input);
			if (url === `${baseUrl}/models`) {
				return Response.json({ data: models.map(id => ({ id })) });
			}
			return new Response("not found", { status: 404 });
		};
	}

	test("prefers the configured LM Studio default over an authenticated bundled fallback on cache-cold boot", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStoragesToClose.push(authStorage);
		// Mirrors #6114 comment (pmatos): a stray key for a bundled provider makes
		// `pickDefaultAvailableModel` fill `model` with that provider's default,
		// masking the still-unresolved configured local default. Without the retry
		// the session silently starts on the bundled fallback and never switches.
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			fetch: mockLmStudio(["qwen3-coder-30b"]),
		});

		const settings = Settings.isolated();
		settings.setModelRole("default", "lm-studio/qwen3-coder-30b");

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
		});

		try {
			expect(session.model?.provider).toBe("lm-studio");
			expect(session.model?.id).toBe("qwen3-coder-30b");
		} finally {
			await session.dispose();
		}
	});
});

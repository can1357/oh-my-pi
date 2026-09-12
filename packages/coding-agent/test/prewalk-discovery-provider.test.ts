/**
 * Regression: issue #11820.
 *
 * Prewalk never armed for a hand-off target served by a `models.yml`
 * `discovery:` provider (a custom OpenAI-compatible endpoint with
 * `discovery.type: openai-models-list`). The configured provider ships no
 * static models, so the catalog `buildSessionOptions` resolves the prewalk
 * target against at startup is empty; the online discovery pass runs only
 * later. The main `--model` path already defers to post-discovery resolution,
 * but the prewalk block gave up synchronously and printed
 * `prewalk disabled — Model "…" not found` for ids `omp models` lists. It now
 * runs a cache-aware discovery pass and retries when the target is unresolved
 * and discoverable providers exist, matching the main model resolution.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("issue #11820 prewalk into a models.yml discovery provider target", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-prewalk-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const storage of authStoragesToClose) storage.close();
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
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

	function writeDiscoveryConfig(): string {
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
		return modelsPath;
	}

	function registry(): ModelRegistry {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("my-provider", "test-provider-key");
		return new ModelRegistry(authStorage, writeDiscoveryConfig(), {
			fetch: mockDiscovery(["some-model"]),
		});
	}

	test("arms prewalk for the configured smol role after discovery", async () => {
		const modelRegistry = registry();
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", "my-provider/some-model");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe("my-provider");
		expect(options.prewalk?.target.id).toBe("some-model");
	});

	test("arms prewalk for an explicit --prewalk-into discovery selector", async () => {
		const modelRegistry = registry();
		const settings = Settings.isolated();

		const options = await buildSessionOptions(
			parseArgs(["--prewalk-into", "my-provider/some-model"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe("my-provider");
		expect(options.prewalk?.target.id).toBe("some-model");
	});
});

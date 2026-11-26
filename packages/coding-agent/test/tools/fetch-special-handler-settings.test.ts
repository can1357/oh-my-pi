import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as parallelModule from "@oh-my-pi/pi-coding-agent/web/parallel";
import { handleTwitter } from "@oh-my-pi/pi-coding-agent/web/scrapers/twitter";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

const authStorages: AuthStorage[] = [];

function createSession(settings: Settings, modelRegistry?: ModelRegistry): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		modelRegistry,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function createXaiRegistry(settings: Settings): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	authStorages.push(authStorage);
	authStorage.keys.setRuntime("xai", "test-xai-key");
	return new ModelRegistry(authStorage, undefined, { settings });
}

function mockXaiResponse(onModel?: (model: string) => void): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { model: string };
			onModel?.(body.model);
			return Response.json({ output_text: "## Post\nhello" });
		}),
	);
}

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
});

describe("URL special handlers use their session settings", () => {
	it("forwards an isolated session's YouTube fetch preference through URL reads", async () => {
		const settings = Settings.isolated({ "providers.fetch": "native" });
		vi.spyOn(parallelModule, "findParallelApiKey").mockReturnValue("test-parallel-key");
		const extractSpy = vi.spyOn(parallelModule, "extractWithParallel");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => Response.json({ videoDetails: { title: "Example video" } })),
		);

		const result = await fetchReadUrl(createSession(settings), {
			path: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		});

		expect(result.details.method).toBe("youtube");
		expect(extractSpy).not.toHaveBeenCalled();
	});

	it("forwards an isolated session's web model role through X URL reads", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("web", "xai/grok-4.7");
		cfgRetryFallbackChains.set(settings, { web: [] });
		const modelRegistry = createXaiRegistry(settings);
		let requestedModel: string | undefined;
		mockXaiResponse(model => {
			requestedModel = model;
		});

		const result = await fetchReadUrl(createSession(settings, modelRegistry), {
			path: "https://x.com/jack/status/20",
		});

		expect(result.details.method).toBe("x-search");
		expect(requestedModel).toBe("grok-4.7");
	});

	it("uses safe defaults for a direct YouTube scrape without initialized global settings", async () => {
		vi.spyOn(parallelModule, "findParallelApiKey").mockReturnValue(null);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => Response.json({ videoDetails: { title: "Example video" } })),
		);

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10);

		expect(result?.method).toBe("youtube");
	});

	it("uses safe defaults for a direct X scrape without initialized global settings", async () => {
		const modelRegistry = createXaiRegistry(Settings.isolated());
		mockXaiResponse();

		const result = await handleTwitter("https://x.com/jack/status/20", 10, undefined, null, modelRegistry);

		expect(result?.method).toBe("x-search");
		expect(result?.content).toContain("## Post\nhello");
	});
});

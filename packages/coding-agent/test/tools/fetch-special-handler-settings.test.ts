import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import * as reader from "@oh-my-pi/pi-coding-agent/web/read";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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

function stubReader() {
	return vi.spyOn(reader, "readUrl").mockImplementation(async url => ({
		kind: "page",
		url,
		content: "Example page",
		contentType: "text/plain",
		notes: [],
		responseHeaders: [],
	}));
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
});

describe("URL site handlers use their session settings", () => {
	it("forwards the session's YouTube fetch preference without disabling site handling", async () => {
		const readUrl = stubReader();
		const settings = Settings.isolated({ "providers.fetch": "local" });
		const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

		await fetchReadUrl(createSession(settings), { path: url });

		expect(readUrl).toHaveBeenCalledWith(
			url,
			expect.objectContaining({
				sites: true,
				siteSettings: expect.arrayContaining([{ key: "providers.fetch", value: "local" }]),
			}),
		);
	});

	it("forwards the session's web model role to the native X reader", async () => {
		const readUrl = stubReader();
		const settings = Settings.isolated();
		settings.setModelRole("web", "xai/grok-4.7");
		cfgRetryFallbackChains.set(settings, { web: [] });
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("xai", "test-xai-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const url = "https://x.com/jack/status/20";

		await fetchReadUrl(createSession(settings, modelRegistry), { path: url });

		expect(readUrl).toHaveBeenCalledWith(
			url,
			expect.objectContaining({
				siteCredentials: expect.arrayContaining([{ site: "x", token: "test-xai-key" }]),
				siteSettings: expect.arrayContaining([{ key: "x.model", value: "grok-4.7" }]),
			}),
		);
	});

	it("disables site handlers for raw URL reads", async () => {
		const readUrl = stubReader();
		const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

		await fetchReadUrl(createSession(Settings.isolated()), { path: url, raw: true });

		expect(readUrl).toHaveBeenCalledWith(url, expect.objectContaining({ sites: false }));
	});
});

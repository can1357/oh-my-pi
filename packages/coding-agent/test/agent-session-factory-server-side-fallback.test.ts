import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	factoryModel,
	WORKOS_TOKEN,
} from "../../ai/test/helpers/factory-droid";
import { asGlobalFetch } from "./helpers/fetch-mock";

describe("createAgentSession Factory server-side fallback", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([false, true])("preserves the Factory wire opt-out: %p", async disabled => {
		using tempDir = TempDir.createSync("@pi-factory-server-side-fallback-");
		const model = factoryModel("claude-fable-5", ["anthropic"]);
		const chunks = anthropicChunks("OK").map(chunk => {
			const frame = JSON.parse(chunk) as { type?: string; message?: { model?: string } };
			if (frame.type === "message_start" && frame.message) frame.message.model = model.id;
			return JSON.stringify(frame);
		});
		const captured: CapturedRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(captureFetch(captured, chunks)));
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("factory-droid", WORKOS_TOKEN);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableServerSideFallback: disabled,
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
			await session.prompt("hello");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const requests = captured.filter(request => new URL(request.url).pathname === "/api/llm/a/v1/messages");
		expect(requests).toHaveLength(1);
		const request = requests[0]!;
		expect(request.body.fallbacks).toEqual(disabled ? undefined : [{ model: "claude-opus-5" }]);
		const betas = request.headers["anthropic-beta"] ?? "";
		expect(betas.includes("server-side-fallback-2026-06-01")).toBe(!disabled);
		expect(betas.includes("fallback-credit-2026-06-01")).toBe(!disabled);
	});
});

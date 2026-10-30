import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function sseDone(): Response {
	const chunk = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek-v4-1-flash",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("session image replacement on a wire that strips images", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it("replaces history images with text before the provider transforms run", async () => {
		using tempDir = TempDir.createSync("@pi-wire-stripped-images-");
		// Declares image input; `compat.stripImageInput` drops images on the wire.
		const model = getBundledModel("venice", "deepseek-v4-1-flash");
		const bodies: string[] = [];
		const fetchStub = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				bodies.push(String(init?.body ?? ""));
				return sseDone();
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "earlier screenshot" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		await session.sendUserMessage("next");

		const request = bodies.find(body => body.includes("earlier screenshot"));
		expect(request).toBeDefined();
		// The session's own text-only replacement ran, not the wire's last-resort strip.
		expect(request).toContain("[image omitted: the active model does not support image input]");
		expect(request).not.toContain("model does not support vision");
		expect(request).not.toContain(PNG_1X1);
	});
});

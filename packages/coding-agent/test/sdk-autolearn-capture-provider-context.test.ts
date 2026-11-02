import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SnapcompactInlineTransformer } from "@oh-my-pi/pi-coding-agent/session/snapcompact-inline";
import { TempDir } from "@oh-my-pi/pi-utils";

// The auto-learn capture turn replays the primary conversation to keep its prompt cache. The provider-context
// transforms (snapcompact among them) rewrite that conversation per request, so the capture must run the
// primary's chain: a capture that skipped snapcompact sent as text what the primary sent as image frames, and
// diverged from the cached prompt at the first frame.
const MARK = "snapcompact-ran";

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

describe("auto-learn capture provider context", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it("runs the primary's snapcompact transform on the capture request", async () => {
		using tempDir = TempDir.createSync("@pi-autolearn-capture-context-");
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
		// Stand in for snapcompact's rewrite: mark the system prompt of every request it transforms.
		vi.spyOn(SnapcompactInlineTransformer.prototype, "transform").mockImplementation(
			async (context: Context): Promise<Context> => ({
				...context,
				systemPrompt: [...(context.systemPrompt ?? []), MARK],
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"autolearn.enabled": true,
				"autolearn.autoContinue": true,
				"autolearn.minToolCalls": 0,
			}),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		await session.sendUserMessage("hello");
		// The capture starts after the primary turn ends and runs in the background.
		for (let i = 0; i < 200 && bodies.length < 2; i++) await Bun.sleep(10);

		expect(bodies.length).toBeGreaterThanOrEqual(2);
		const [primary, capture] = bodies;
		expect(primary).toContain(MARK);
		expect(capture).toContain(MARK);
	});
});

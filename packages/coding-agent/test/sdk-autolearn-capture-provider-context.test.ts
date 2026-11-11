import { afterEach, expect, it, vi } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SnapcompactInlineTransformer } from "@oh-my-pi/pi-coding-agent/session/snapcompact-inline";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

it("runs the primary's snapcompact transform on the auto-learn capture request", async () => {
	using tempDir = TempDir.createSync("@pi-autolearn-capture-context-");
	const model = getBundledModel("venice", "deepseek-v4-1-flash");
	const chunk = {
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	const bodies: string[] = [];
	const fetchStub = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	vi.spyOn(SnapcompactInlineTransformer.prototype, "transform").mockImplementation(
		async (context: Context): Promise<Context> => ({
			...context,
			systemPrompt: [...(context.systemPrompt ?? []), "snapcompact-ran"],
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
	try {
		await session.sendUserMessage("hello");
		// The capture runs in the background after the primary turn ends.
		for (let i = 0; i < 200 && bodies.length < 2; i++) await Bun.sleep(10);

		const [primary, capture] = bodies;
		expect(primary).toContain("snapcompact-ran");
		expect(capture).toContain("snapcompact-ran");
	} finally {
		await session.dispose();
	}
});

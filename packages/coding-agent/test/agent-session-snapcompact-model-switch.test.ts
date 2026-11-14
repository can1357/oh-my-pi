import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { rejectionOf } from "./helpers/rejection";

/**
 * Snapcompact yields to the event loop between its preflight (shape resolution and
 * renderability scan) and the render. A model switch that lands in that yield must
 * not pair the shape scanned for one model with frames and budgets sized for another.
 */
describe("AgentSession snapcompact model switch during preflight", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	function bundled(provider: string, id: string): Model {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
		return model;
	}

	it("refuses to render when the active model changed after the preflight", async () => {
		const scannedModel = bundled("anthropic", "claude-sonnet-4-5");
		const switchedModel = bundled("openai-codex", "gpt-6.1-sol");

		tempDir = TempDir.createSync("@pi-snapcompact-model-switch-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const agent = new Agent({
			initialState: { model: scannedModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: scannedModel.api,
				provider: scannedModel.provider,
				model: scannedModel.id,
				stopReason: "stop",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.methodOrder": ["snapcompact", "soft"],
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry: new ModelRegistry(authStorage) });

		const resolveShapeAndScan = snapcompact.resolveShapeAndScan;
		vi.spyOn(snapcompact, "resolveShapeAndScan").mockImplementation((...args) => {
			// Runs at the first await after the synchronous preflight: the yield before the render.
			queueMicrotask(() => agent.setModel(switchedModel));
			return resolveShapeAndScan(...args);
		});
		const renderSpy = vi.spyOn(snapcompact, "compact");

		const error = String(await rejectionOf(session.compact(undefined, { mode: "snapcompact" })));

		expect(error).toContain("the active model changed while it was preparing");
		expect(renderSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});
});

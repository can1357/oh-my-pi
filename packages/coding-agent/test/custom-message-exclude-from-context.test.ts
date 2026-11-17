import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getMessageFromEntry } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("custom message excludeFromContext", () => {
	it("restores an excluded row for display but never sends it to the model", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendCustomMessageEntry("plugin-stats", "[stats]", true, { tokens: 42 }, "agent", 2, true);
		session.appendCustomMessageEntry("plugin-note", "kept", true, undefined, "agent", 3);

		const { messages } = buildSessionContext(session.getBranch());

		expect(messages.map(message => message.role)).toEqual(["user", "custom", "custom"]);
		expect(messages[1]).toMatchObject({
			customType: "plugin-stats",
			details: { tokens: 42 },
			excludeFromContext: true,
		});
		expect(messages[2]).not.toHaveProperty("excludeFromContext");
		const sent = JSON.stringify(convertToLlm(messages));
		expect(sent).not.toContain("[stats]");
		expect(sent).toContain("kept");

		// Compaction and branch summaries rebuild messages from entries: the flag must survive there too.
		const rebuilt = session.getBranch().map(getMessageFromEntry);
		expect(JSON.stringify(convertToLlm(rebuilt.filter(message => message !== undefined)))).not.toContain("[stats]");
	});

	describe("delivery", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let session: AgentSession | undefined;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-exclude-from-context-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.keys.setRuntime("openai", "openai-test-key");
		});

		afterEach(async () => {
			await session?.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		it("never starts a turn for a row the model would not see", async () => {
			const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
			const contexts: Context[] = [];
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					contexts.push(context);
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			});
			const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry: new ModelRegistry(authStorage),
				toolRegistry: new Map(),
			});

			const row = { customType: "plugin-stats", content: "[stats]", display: true, excludeFromContext: true };
			expect(await session.sendCustomMessage(row, { triggerTurn: true })).toBe(false);
			expect(await session.sendCustomMessage(row, { deliverAs: "aside" })).toBe(false);
			await session.waitForIdle();

			expect(contexts).toHaveLength(0);
			const entries = sessionManager.getBranch().filter(entry => entry.type === "custom_message");
			expect(entries.map(entry => entry.excludeFromContext)).toEqual([true, true]);
		});
	});
});

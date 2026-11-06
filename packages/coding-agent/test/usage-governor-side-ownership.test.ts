import { describe, expect, test } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { currentUsageAdmission } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("side request admission ownership", () => {
	test("concurrent direct sessions scope custom side streams to their own governor", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled model");
		const dir = TempDir.createSync("@pi-side-governor-");
		const storages = [createInMemoryAuthStorage(), createInMemoryAuthStorage()];
		const sessions: AgentSession[] = [];
		const observed: unknown[] = [];
		let entered = 0;
		const { promise: bothEntered, resolve: release } = Promise.withResolvers<void>();
		try {
			for (const [index, storage] of storages.entries()) {
				storage.keys.setRuntime("openai", "test-key");
				const registry = new ModelRegistry(storage, dir.join(`models-${index}.yml`), {
					cacheDbPath: dir.join(`models-${index}.db`),
				});
				const sideStreamFn: StreamFn = async () => {
					if (++entered === 2) release();
					await bothEntered;
					observed[index] = currentUsageAdmission();
					const stream = new AssistantMessageEventStream();
					const message = createAssistantMessage(`answer-${index}`);
					stream.push({ type: "text_delta", contentIndex: 0, delta: `answer-${index}`, partial: message });
					stream.push({ type: "done", reason: "stop", message });
					return stream;
				};
				sessions.push(
					new AgentSession({
						agent: new Agent({ initialState: { model, systemPrompt: [], tools: [] } }),
						sessionManager: SessionManager.inMemory(),
						settings: Settings.isolated({ "compaction.enabled": false }),
						modelRegistry: registry,
						sideStreamFn,
					}),
				);
			}
			const results = await Promise.all(
				sessions.map(session => session.runEphemeralTurn({ promptText: "Question?" })),
			);
			expect(results.map(result => result.replyText)).toEqual(["answer-0", "answer-1"]);
			expect(observed).toEqual(storages.map(storage => storage.governor));
			expect(observed[0]).not.toBe(observed[1]);
		} finally {
			for (const session of sessions) await session.dispose();
			for (const storage of storages) storage.close();
			closeModelCache();
			await dir.remove();
		}
	});
});

import { describe, expect, test } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { currentUsageAdmission } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("advisor admission ownership", () => {
	test("concurrent advisors use their own session governor with custom streams", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const dir = TempDir.createSync("@pi-advisor-governor-");
		const storages = [createInMemoryAuthStorage(), createInMemoryAuthStorage()];
		const sessions: AgentSession[] = [];
		const observed: unknown[] = [];
		try {
			for (const [index, storage] of storages.entries()) {
				storage.keys.setRuntime("anthropic", "test-key");
				const registry = new ModelRegistry(storage, dir.join(`models-${index}.yml`), {
					cacheDbPath: dir.join(`models-${index}.db`),
				});
				const advisorStreamFn: StreamFn = () => {
					observed[index] = currentUsageAdmission();
					throw new Error("capture-stop");
				};
				const settings = Settings.isolated({ "compaction.enabled": false });
				settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
				const session = new AgentSession({
					agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
					sessionManager: SessionManager.create(dir.path(), dir.path()),
					settings,
					modelRegistry: registry,
					advisorTools: [],
					advisorStreamFn,
				});
				sessions.push(session);
				expect(session.setAdvisorEnabled(true)).toBe(true);
			}
			const advisors = sessions.map(session => session.getAdvisorAgent());
			if (!advisors[0] || !advisors[1]) throw new Error("Expected both advisors");
			await Promise.all(advisors.map(advisor => advisor!.prompt("ping").catch(() => {})));
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

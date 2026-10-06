import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SKILL_BODY = "Demo skill body: count the widgets.";

describe("AgentSession.sendUserMessage expandPromptTemplates", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	/** Set by a test to hold the next model turn open until it resolves `release`. */
	let heldTurn: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	const observedTurns: string[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-send-user-message-expand-");
		observedTurns.length = 0;
		heldTurn = undefined;
		const skillDir = path.join(tempDir.path(), "demo");
		const skillPath = path.join(skillDir, "SKILL.md");
		await Bun.write(skillPath, `---\nname: demo\ndescription: Demo skill\n---\n\n${SKILL_BODY}\n`);

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const last = context.messages.at(-1);
				const content = last?.content;
				observedTurns.push(
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content.map(block => (block.type === "text" ? block.text : "")).join("\n")
							: "",
				);
				const stream = new AssistantMessageEventStream();
				const finish = () => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				};
				const hold = heldTurn;
				heldTurn = undefined;
				if (hold) {
					hold.release.promise.then(finish);
					hold.started.resolve();
				} else queueMicrotask(finish);
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			skills: [{ name: "demo", description: "Demo skill", filePath: skillPath, baseDir: skillDir, source: "test" }],
			skillsSettings: { enableSkillCommands: true },
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("keeps extension text literal by default and expands a /skill: command on opt-in", async () => {
		await session.sendUserMessage("/skill:demo first");
		await session.waitForIdle();
		await session.sendUserMessage("/skill:demo second", { expandPromptTemplates: true });
		await session.waitForIdle();

		expect(observedTurns[0]).toBe("/skill:demo first");
		expect(observedTurns[1]).toContain(SKILL_BODY);
		expect(observedTurns[1]).toContain("second");
	});

	it("expands a /skill: command queued as a follow-up while the agent is streaming", async () => {
		const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		heldTurn = hold;
		const first = session.sendUserMessage("start");
		await hold.started.promise;
		await session.sendUserMessage("/skill:demo queued", { expandPromptTemplates: true, deliverAs: "followUp" });
		hold.release.resolve();
		await first;
		await session.waitForIdle();

		expect(observedTurns).toHaveLength(2);
		expect(observedTurns[1]).toContain(SKILL_BODY);
		expect(observedTurns[1]).toContain("queued");
	});
});

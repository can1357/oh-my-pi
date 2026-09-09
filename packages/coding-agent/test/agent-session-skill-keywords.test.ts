import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedSkillTurn = {
	texts: string[];
};

// Workflowz requires active `task` and `eval` tools; keep both active so
// keyword steering exercises the notice path.
const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockEvalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Mock eval tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

describe("AgentSession skill prompt keyword steering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	const observedTurns: ObservedSkillTurn[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-skill-keywords-");
		observedTurns.length = 0;

		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [mockTaskTool, mockEvalTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				observedTurns.push({
					texts: context.messages.map(message => {
						const content = message.content;
						if (typeof content === "string") return content;
						if (!Array.isArray(content)) return "";
						const text: string[] = [];
						for (const block of content) {
							if (block.type === "text") text.push(block.text);
						}
						return text.join("\n");
					}),
				});
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("injects magic keyword notices and turn budgets from user-authored skill args", async () => {
		const skillPath = path.join(tempDir.path(), "deep-research.md");
		const details: SkillPromptDetails = {
			name: "deep-research",
			path: skillPath,
			args: "workflowz +500k! compare these approaches",
			lineCount: 1,
		};
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: `Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`,
			display: true,
			details,
			attribution: "user",
		});

		expect(observedTurns).toHaveLength(1);
		const observedTurn = observedTurns[0];
		if (!observedTurn) throw new Error("Expected prompt context to be captured");
		expect(observedTurn.texts).toContain(`Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`);
		expect(observedTurn.texts).toContain(WORKFLOW_NOTICE);
		expect(session.sessionManager.getTurnBudget()).toEqual({ total: 500_000, spent: 0, hard: true });
	});
});

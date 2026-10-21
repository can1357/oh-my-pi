/**
 * A todo failure remains actionable until its own retry succeeds. Later,
 * unrelated mutations must not discard it or replay its old list snapshot.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const REMINDER_MARKER = "todo failed, so todo progress is not visible to the user.";

function todoCall(id: string, args: Record<string, unknown>): MockResponse {
	const call: ToolCall = { type: "toolCall", id, name: "todo", arguments: args };
	return { content: [call] };
}

describe("AgentSession todo-error reminder", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-todo-error-reminder-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	/** Runs one scripted prompt plus a follow-up prompt; returns reminders delivered to the model. */
	async function runTwoPrompts(firstRun: MockResponse[]): Promise<string[]> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const mock = createMockModel({ responses: [...firstRun, { content: ["Next answer"] }] });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.reminders": false,
			"tools.xdev": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const todo = new TodoTool({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => session?.getTodoPhases() ?? [],
			setTodoPhases: phases => session?.setTodoPhases(phases),
		});
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [todo], messages: [] },
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
			convertToLlm,
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setTodoPhases([
			{ name: "Build", tasks: [{ content: "Write code", status: "in_progress" }] },
			{ name: "Ship", tasks: [{ content: "Release", status: "pending" }] },
		]);

		await session.prompt("Plan more work");
		await session.waitForIdle();
		await session.prompt("Next request");
		await session.waitForIdle();

		const lastCall = mock.calls.at(-1);
		if (!lastCall) throw new Error("Expected the mock model to be called");
		return lastCall.context.messages.flatMap(message => {
			if (message.role !== "developer") return [];
			const content = message.content;
			if (typeof content === "string") return content.includes(REMINDER_MARKER) ? [content] : [];
			return content
				.filter((part): part is TextContent => part.type === "text" && part.text.includes(REMINDER_MARKER))
				.map(part => part.text);
		});
	}

	it("drops the reminder only after its append retry succeeds", async () => {
		const reminders = await runTwoPrompts([
			todoCall("todo-fail", { op: "append", items: ["Add tests"] }),
			todoCall("todo-retry", { op: "append", phase: "Build", items: ["Add tests"] }),
			{ content: ["Appended"] },
		]);

		expect(session?.getTodoPhases()[0]?.tasks.map(task => task.content)).toEqual(["Write code", "Add tests"]);
		expect(reminders).toEqual([]);
	});

	it("preserves an uncorrected failure across a view", async () => {
		const reminders = await runTwoPrompts([
			todoCall("todo-fail", { op: "append", items: ["Add tests"] }),
			todoCall("todo-view", { op: "view" }),
			{ content: ["Gave up"] },
		]);

		expect(reminders).toHaveLength(1);
	});

	it("preserves an uncorrected failure after an unrelated mutation without a stale list", async () => {
		const reminders = await runTwoPrompts([
			todoCall("todo-fail", { op: "append", items: ["Add tests"] }),
			todoCall("todo-unrelated", { op: "done", task: "Release" }),
			{ content: ["Completed release"] },
		]);

		expect(session?.getTodoPhases()[1]?.tasks[0]?.status).toBe("completed");
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("Missing phase name for append operation");
		expect(reminders[0]).not.toContain("Remaining items");
	});

	it("keeps only the failed operation that has not been retried", async () => {
		const reminders = await runTwoPrompts([
			todoCall("todo-missing-phase", { op: "append", items: ["Add tests"] }),
			todoCall("todo-duplicate", { op: "append", phase: "Ship", items: ["Write code"] }),
			todoCall("todo-retry", { op: "append", phase: "Build", items: ["Add tests"] }),
			{ content: ["Appended"] },
		]);

		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain('Task "Write code" already exists');
		expect(reminders[0]).not.toContain("Missing phase name for append operation");
		expect(reminders[0]).not.toContain("Remaining items");
	});

	it("drops reminders when retries correct other invalid arguments", async () => {
		const reminders = await runTwoPrompts([
			todoCall("todo-missing-items", { op: "append", phase: "Build" }),
			todoCall("todo-placeholder", { op: "done", task: "task-1" }),
			todoCall("todo-items-retry", { op: "append", phase: "Build", items: ["Add tests"] }),
			todoCall("todo-task-retry", { op: "done", task: "Release" }),
			{ content: ["Corrected both"] },
		]);

		expect(session?.getTodoPhases()[1]?.tasks[0]?.status).toBe("completed");
		expect(reminders).toEqual([]);
	});
});

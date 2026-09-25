import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import submitReminderTemplate from "../src/prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const roots: TempDir[] = [];
const stores: ModelRegistry[] = [];

function reminder(budgetStop = false): AgentMessage {
	return {
		role: "developer",
		content: prompt.render(submitReminderTemplate, { retryCount: 1, maxRetries: 3, budgetStop }),
		timestamp: Date.now(),
	};
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const registry of stores.splice(0)) registry.authStorage.close();
	for (const root of roots.splice(0)) root.removeSync();
});

async function harness(
	doneOnly: boolean,
	delayed: boolean,
	options: { input?: Record<string, unknown>; outputSchema?: unknown; text?: string } = {},
) {
	const root = TempDir.createSync("@pi-yield-report-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(auth);
	stores.push(modelRegistry);
	const input = options.input ?? { type: "result" };
	const call = { type: "toolCall" as const, id: "yield-report", name: "yield", arguments: input };
	const content = options.text === undefined ? [call] : [{ type: "text" as const, text: options.text }, call];
	const mock = createMockModel({ responses: [{ content, stopReason: "toolUse" }] });
	const pendingUpdate = Promise.withResolvers<void>();
	const releaseUpdate = Promise.withResolvers<void>();
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry,
		model: mock,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		requireYieldTool: true,
		toolNames: ["yield"],
		parentTaskPrefix: "report-child",
		agentId: "report-child",
		taskDepth: 1,
		outputSchema: options.outputSchema,
		extensions: delayed
			? [
					pi => {
						pi.on("message_update", async () => {
							pendingUpdate.resolve();
							await releaseUpdate.promise;
						});
						pi.on("tool_call", async () => {
							await pendingUpdate.promise;
						});
					},
				]
			: [],
	});
	sessions.push(session);
	if (doneOnly) {
		session.agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			const message = createAssistantMessage("");
			message.content = content;
			message.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		};
	} else session.agent.streamFn = mock.stream;
	return { session, releaseUpdate };
}

describe("SDK data-less yield report", () => {
	for (const [doneOnly, delayed, budgetStop] of [
		[false, false, false],
		[true, false, false],
		[false, true, false],
		[false, false, true],
	]) {
		it(`submits preceding prose through the real loop (done-only=${doneOnly}, delayed=${delayed}, budget-stop=${budgetStop})`, async () => {
			const { session, releaseUpdate } = await harness(doneOnly, delayed);
			const report = "# Review\nNo confirmed defects.\n";
			const history: AgentMessage[] = [
				{ role: "user", content: "Review the source", timestamp: Date.now() },
				createAssistantMessage(report),
				reminder(budgetStop),
			];
			session.agent.replaceMessages(history);
			try {
				await session.agent.continue();
				const result = session.messages.find(
					message => message.role === "toolResult" && message.toolCallId === "yield-report",
				);
				expect(result).toMatchObject({
					role: "toolResult",
					isError: false,
					details: { status: "success", data: report },
				});
			} finally {
				releaseUpdate.resolve();
			}
		});
	}

	for (const [name, boundary] of [
		["new user task", { role: "user", content: "A different task", timestamp: Date.now() }],
		[
			"new tool evidence",
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "read",
				content: [{ type: "text", text: "Evidence" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
		["unrelated developer instruction", { role: "developer", content: "Revise the answer", timestamp: Date.now() }],
		[
			"thinking-only assistant",
			{ ...createAssistantMessage(""), content: [{ type: "thinking", thinking: "Private reasoning" }] },
		],
		["failed assistant report", { ...createAssistantMessage("Failed report"), stopReason: "error" }],
		[
			"report that starts more work",
			{
				...createAssistantMessage("Still checking"),
				content: [
					{ type: "text", text: "Still checking" },
					{ type: "toolCall", name: "read", id: "read", arguments: {} },
				],
				stopReason: "toolUse",
			},
		],
	] as const) {
		it(`refuses preceding prose across ${name}`, async () => {
			const { session } = await harness(false, false);
			session.agent.replaceMessages([createAssistantMessage("Stale report"), boundary as AgentMessage, reminder()]);
			await session.agent.continue();
			const result = session.messages.find(
				message => message.role === "toolResult" && message.toolCallId === "yield-report",
			);
			expect(result).toMatchObject({ role: "toolResult", isError: true });
			expect(JSON.stringify(result)).not.toContain("Stale report");
		});
	}

	it("prefers report prose beside yield over a previous report", async () => {
		const { session } = await harness(true, false, { text: "Current report" });
		session.agent.replaceMessages([createAssistantMessage("Superseded report"), reminder()]);
		await session.agent.continue();
		const result = session.messages.find(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: false, details: { data: "Current report" } });
	});

	it("never borrows another child's report", async () => {
		const { session: other } = await harness(false, false);
		other.agent.replaceMessages([createAssistantMessage("Other child's report")]);
		const { session } = await harness(false, false);
		session.agent.replaceMessages([{ role: "user", content: "Work", timestamp: Date.now() }]);
		await session.agent.continue();
		const result = session.messages.find(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).not.toContain("Other child's report");
	});

	it("does not reuse preceding prose for incremental sections", async () => {
		const { session } = await harness(false, false, { input: { type: ["notes"] } });
		session.agent.replaceMessages([createAssistantMessage("Earlier report"), reminder()]);
		await session.agent.continue();
		const result = session.messages.find(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).not.toContain("Earlier report");
	});

	it("retains strict-mode null-as-omitted semantics", async () => {
		const { session } = await harness(false, false, { input: { type: "result", data: null, error: null } });
		session.agent.replaceMessages([createAssistantMessage("Strict-mode report"), reminder()]);
		await session.agent.continue();
		const result = session.messages.find(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: false, details: { data: "Strict-mode report" } });
	});

	for (const [input, details] of [
		[
			{ type: "result", data: "Explicit report" },
			{ status: "success", data: "Explicit report" },
		],
		[
			{ type: "result", error: "Named failure" },
			{ status: "aborted", error: "Named failure" },
		],
	] as const) {
		it(`preserves explicit ${Object.hasOwn(input, "error") ? "error" : "data"}`, async () => {
			const { session } = await harness(false, false, { input });
			session.agent.replaceMessages([createAssistantMessage("Earlier report"), reminder()]);
			await session.agent.continue();
			const result = session.messages.find(message => message.role === "toolResult");
			expect(result).toMatchObject({ isError: false, details });
		});
	}

	it("preserves structured last-turn refusal before any retry downgrade", async () => {
		const { session } = await harness(false, false, {
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		const current = createAssistantMessage("");
		current.stopReason = "toolUse";
		current.content = [{ type: "toolCall", id: "yield-report", name: "yield", arguments: { type: "result" } }];
		session.agent.replaceMessages([createAssistantMessage("Wrong schema report"), current]);
		const tool = session.getToolByName("yield");
		if (!tool) throw new Error("Missing yield tool");
		for (let attempt = 0; attempt < 5; attempt++) {
			await expect(tool.execute("yield-report", { type: "result" })).rejects.toThrow(
				"structured output matching the declared schema",
			);
		}
	});
});

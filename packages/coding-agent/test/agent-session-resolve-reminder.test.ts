import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, isSoftToolRequirement } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { queueResolveHandler, ResolveTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/resolve";
import { buildNamedToolChoice } from "@pk-nerdsaver-ai/pi-coding-agent/utils/tool-choice";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let toolSession: ToolSession;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-resolve-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		mock = createMockModel({ handler: () => ({ content: ["Done"] }) });

		toolSession = {
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: (name: string) => buildNamedToolChoice(name, session.model!),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekStandingResolveHandler: () => session.peekStandingResolveHandler(),
		} as unknown as ToolSession;

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			getToolChoice: () => session.nextToolChoiceDirective(),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("delivers the resolve reminder via a non-forcing soft requirement, not a steer or a forced tool_choice", () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		// Forcing was removed — staging a preview never queues a hard tool_choice.
		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();

		// The reminder now rides an agent-level soft requirement (delivered once by
		// the agent loop) instead of a host-side steer that churned the prefix.
		const directive = session.nextToolChoiceDirective();
		expect(isSoftToolRequirement(directive)).toBe(true);
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		expect(directive.toolName).toBe("resolve");
		const reminder = directive.reminder[0];
		expect(reminder?.role).toBe("custom");
		if (reminder?.role === "custom") {
			expect(reminder.customType).toBe("resolve-reminder");
		}

		// Nothing was steered into the conversation — no prefix churn.
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("dispatches a staged preview through the production toolSession wiring and drains the gate", async () => {
		let applyRuns = 0;
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => {
				applyRuns++;
				return { content: [{ type: "text", text: "Applied" }] };
			},
		});

		// Gate armed before resolve runs.
		expect(isSoftToolRequirement(session.nextToolChoiceDirective())).toBe(true);

		const tool = new ResolveTool(toolSession);
		await tool.execute("call-apply", { action: "apply", reason: "looks correct" });

		// Apply ran (forwarding works) AND the gate cleared (no phantom pending).
		expect(applyRuns).toBe(1);
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("drains a phantom pending gate when resolve cannot dispatch", async () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});
		expect(isSoftToolRequirement(session.nextToolChoiceDirective())).toBe(true);

		// Mirror the production deadlock: the queue still reports a pending head, but
		// every dispatch peek returns undefined (the original loop-trigger).
		const facade = {
			...toolSession,
			peekQueueInvoker: () => undefined,
			peekPendingInvoker: () => undefined,
			peekStandingResolveHandler: () => undefined,
		} as ToolSession;
		const tool = new ResolveTool(facade);

		// `discard` with no invoker now drains the gate instead of leaving a phantom.
		const result = await tool.execute("call-discard", { action: "discard", reason: "drain stale gate" });
		expect(result.isError ?? false).toBe(false);
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});
});

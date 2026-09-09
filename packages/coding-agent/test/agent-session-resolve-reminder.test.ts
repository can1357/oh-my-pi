import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, isSoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { dispatchResolutionDevice, queueResolveHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let toolSession: ToolSession;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	const transitions: Array<"new" | "switch" | "branch"> = ["new", "switch", "branch"];
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
			peekPlanProposalHandler: () => session.peekPlanProposalHandler(),
		} as unknown as ToolSession;

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			getToolChoice: () => session.nextToolChoiceDirective(),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "sessions")),
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

	async function changeLogicalSession(transition: "new" | "switch" | "branch"): Promise<void> {
		if (transition === "new") {
			expect(await session.newSession()).toBe(true);
			return;
		}
		if (transition === "branch") {
			session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
			const [target] = session.getUserMessagesForBranching();
			if (!target) throw new Error("Expected a branchable user message");
			const result = await session.branch(target.entryId);
			expect(result.cancelled).toBe(false);
			return;
		}
		const targetId = `target-${Snowflake.next()}`;
		const targetPath = path.join(tempDir, `${targetId}.jsonl`);
		await Bun.write(
			targetPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: targetId,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
		);
		expect(await session.switchSession(targetPath)).toBe(true);
	}

	it("delivers the resolve reminder via a non-forcing soft requirement, not a steer or a forced tool_choice", () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();

		const directive = session.nextToolChoiceDirective();
		expect(isSoftToolRequirement(directive)).toBe(true);
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		expect(directive.toolName).toBe("write");
		expect(directive.satisfies?.({ name: "write", arguments: { path: "xd://resolve" } })).toBe(true);
		expect(directive.satisfies?.({ name: "write", arguments: { path: "xd://reject" } })).toBe(true);
		expect(directive.satisfies?.({ name: "write", arguments: { path: "/tmp/out.md" } })).toBe(false);
		const reminder = directive.reminder[0];
		expect(reminder?.role).toBe("custom");
		if (reminder?.role === "custom") {
			expect(reminder.customType).toBe("resolve-reminder");
		}
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it.each(transitions)("clears a staged preview after a successful %s session boundary", async transition => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});
		expect(session.peekPendingInvoker()).toBeDefined();
		expect(isSoftToolRequirement(session.nextToolChoiceDirective())).toBe(true);

		await changeLogicalSession(transition);

		expect(session.peekPendingInvoker()).toBeUndefined();
		expect(session.nextToolChoiceDirective()).toBeUndefined();
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

		expect(isSoftToolRequirement(session.nextToolChoiceDirective())).toBe(true);
		await dispatchResolutionDevice(toolSession, "resolve", "looks correct");

		expect(applyRuns).toBe(1);
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("drains a phantom pending gate when reject cannot dispatch", async () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});
		expect(isSoftToolRequirement(session.nextToolChoiceDirective())).toBe(true);

		const facade = {
			...toolSession,
			peekQueueInvoker: () => undefined,
			peekPendingInvoker: () => undefined,
			peekPlanProposalHandler: () => undefined,
		} as ToolSession;

		const { result } = await dispatchResolutionDevice(facade, "reject", "drain stale gate");
		expect(result.isError ?? false).toBe(false);
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});
});

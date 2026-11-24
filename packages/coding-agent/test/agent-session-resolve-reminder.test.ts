import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, isSoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { queueResolveHandler, specialToolCommands } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import { REJECT_COMMAND_NAME, RESOLVE_COMMAND_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let toolSession: ToolSession;
	let tempDir: string;

	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	const transitions: Array<"new" | "switch" | "branch"> = ["new", "switch", "branch"];

	async function buildFixture(options: { toolCommands?: boolean } = {}): Promise<{
		session: AgentSession;
		toolSession: ToolSession;
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		const auth = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		auth.keys.setRuntime("anthropic", "test-key");
		authStorages.push(auth);
		const modelRegistry = new ModelRegistry(auth, path.join(tempDir, `models-${Snowflake.next()}.yml`));

		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type("object"),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};
		const toolRegistry = new Map<string, AgentTool>([[bashTool.name, bashTool]]);
		const toolCommands: ToolCommandState | undefined = options.toolCommands
			? {
					tools: toolRegistry,
					mountedNames: new Set(),
					builtInNames: new Set(["bash"]),
					isActive: name => name === "bash",
				}
			: undefined;

		const sessionRef: { current?: AgentSession } = {};
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: options.toolCommands ? [bashTool] : [],
				messages: [],
			},
			streamFn: mock.stream,
			getToolChoice: () => sessionRef.current?.nextToolChoiceDirective(),
		});

		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "sessions")),
			settings: Settings.isolated(),
			modelRegistry,
			toolRegistry: options.toolCommands ? toolRegistry : undefined,
			builtInToolNames: options.toolCommands ? ["bash"] : undefined,
			toolCommands,
		});
		sessionRef.current = created;
		sessions.push(created);
		if (options.toolCommands) {
			await created.setActiveToolsByName(["bash"]);
		}

		const proxy: ToolSession = {
			settings: created.settings,
			getToolChoiceQueue: () => created.toolChoiceQueue,
			buildToolChoice: (name: string) => buildNamedToolChoice(name, created.model!),
			peekQueueInvoker: () => created.peekQueueInvoker(),
			peekPendingInvoker: () => created.peekPendingInvoker(),
			clearPendingInvokers: () => created.clearPendingInvokers(),
			peekPlanProposalHandler: () => created.peekPlanProposalHandler(),
		} as unknown as ToolSession;

		return { session: created, toolSession: proxy };
	}

	function command(session: ToolSession, name: string): Tool {
		const tool = specialToolCommands(session).find(candidate => candidate.name === name);
		if (!tool) throw new Error(`Missing ${name} tool command`);
		return tool;
	}

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-resolve-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const fixture = await buildFixture();
		session = fixture.session;
		toolSession = fixture.toolSession;
	});

	afterEach(async () => {
		for (const item of sessions) await item.dispose();
		sessions.length = 0;
		for (const auth of authStorages) auth.close();
		authStorages.length = 0;
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

	it("queues the resolve reminder as a non-forcing soft requirement instead of a steer or a forced tool_choice", () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();

		const directive = session.nextToolChoiceDirective();
		expect(isSoftToolRequirement(directive)).toBe(true);
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		// No bash tool in this session, so a non-compliant turn falls back to the recoverable `reject`.
		expect(directive.toolName).toBe(REJECT_COMMAND_NAME);
		expect(directive.satisfies?.({ name: RESOLVE_COMMAND_NAME })).toBe(true);
		expect(directive.satisfies?.({ name: "bash", arguments: { command: "resolve looks right" } })).toBe(true);
		expect(directive.satisfies?.({ name: "bash", arguments: { command: "reject wrong" } })).toBe(true);
		expect(directive.satisfies?.({ name: "bash", arguments: { command: "echo resolve" } })).toBe(false);
		expect(directive.satisfies?.({ name: "write", arguments: { path: "/tmp/out.md" } })).toBe(false);
		const reminder = directive.reminder[0];
		expect(reminder?.role).toBe("custom");
		if (reminder?.role === "custom") {
			expect(reminder.customType).toBe("resolve-reminder");
		}
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("escalates to bash instead of reject while tool commands are active", async () => {
		const fixture = await buildFixture({ toolCommands: true });
		queueResolveHandler(fixture.toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		const directive = fixture.session.nextToolChoiceDirective();
		expect(isSoftToolRequirement(directive)).toBe(true);
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		expect(directive.toolName).toBe("bash");
		expect(directive.satisfies?.({ name: "bash", arguments: { command: "resolve looks right" } })).toBe(true);
	});

	it("tells a bash call that runs another command to finalize the pending preview with resolve or reject", async () => {
		const fixture = await buildFixture({ toolCommands: true });
		queueResolveHandler(fixture.toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		const directive = fixture.session.nextToolChoiceDirective();
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		// Calls `bash`, the required tool, but runs `ast_edit` with `resolve` as its argument.
		const call = { name: "bash", arguments: { command: 'ast_edit resolve "looks right"' } };
		expect(directive.satisfies?.(call)).toBe(false);
		const notice = directive.unsatisfiedNotice?.(call) ?? "";
		expect(notice).toContain("runs `ast_edit`");
		expect(notice).toMatch(/`resolve "/);
		expect(notice).toMatch(/`reject "/);

		// `resolve` behind a `cd` prefix does not run as the leading command, so it finalizes nothing either.
		const prefixed = { name: "bash", arguments: { command: 'cd /repo && resolve "looks right"' } };
		expect(directive.satisfies?.(prefixed)).toBe(false);
		expect(directive.unsatisfiedNotice?.(prefixed)).toContain("with nothing before it");
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
		await command(toolSession, RESOLVE_COMMAND_NAME).execute("resolve-call", { reason: "looks correct" });

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

		const result = await command(facade, REJECT_COMMAND_NAME).execute("reject-call", { reason: "drain stale gate" });
		expect(result.isError ?? false).toBe(false);
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});
});

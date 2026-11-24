/**
 * Contract: plan mode converges on `ask`/`propose` regardless of how a turn
 * ends, and non-user producers cannot keep it spinning.
 *
 *  T1. An advisor concern in plan mode is recorded as a visible card but never
 *      wakes an autonomous primary turn.
 *  T2. An idle IRC message in plan mode is folded into context ("injected"),
 *      not woken.
 *  T3. A plan-mode turn that stops without a decision tool call is reminded at the
 *      terminal settle, bounded by PLAN_MODE_REMINDER_MAX (then yields to the
 *      user), and either decision tool resets the counter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
	type ToolApproval,
	type ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/irc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { TempDir } from "@oh-my-pi/pi-utils";
import planModeReminderPrompt from "../src/prompts/system/plan-mode-tool-decision-reminder.md" with { type: "text" };

/** A stable, literal (non-templated) line of the reminder prompt, so the test
 *  pins the reminder by its real content rather than a hardcoded copy. */
function deriveReminderFragment(template: string): string {
	const line = template
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 20 && !l.includes("{{"));
	if (!line) throw new Error("plan-mode reminder template is missing a stable marker line");
	return line;
}
const REMINDER_FRAGMENT = deriveReminderFragment(planModeReminderPrompt);

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

/** The plan-submission tool: a call that leaves plan details on its result, so
 *  a submission is observable as a convergence-counter reset. */
function makeProposeTool(): AgentTool {
	return {
		name: "propose",
		label: "propose",
		description: "Submit the plan for approval",
		parameters: type({}),
		approval: "read",
		async execute() {
			return {
				content: [{ type: "text" as const, text: "Plan ready for approval." }],
				details: { planFilePath: "local://test-reset-plan.md", title: "test-reset", planExists: true },
			};
		},
	};
}

function makeMcpTool(name: string, loadMode: ToolLoadMode, approval: ToolApproval = "read"): CustomTool {
	return {
		name,
		label: name,
		description: `Test MCP tool ${name}`,
		parameters: type({}),
		loadMode,
		approval,
		mcpServerName: name.split("__")[1] ?? "test-mcp",
		mcpToolName: name.split("__").at(-1) ?? name,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** Concatenate the text blocks of a message (string or content-array). */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const block of content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join("\n");
}

function countReminders(messages: readonly AgentMessage[]): number {
	return messages.filter(m => m.role === "developer" && messageText(m).includes(REMINDER_FRAGMENT)).length;
}

interface PlanHarness {
	session: AgentSession;
	mock: MockModel;
	advisorMock?: MockModel;
	sideMock?: MockModel;
}

describe("AgentSession plan-mode convergence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-plan-converge-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-converge-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			await tempDir?.remove();
		}
	});

	async function createPlanSession(
		responses: MockResponse[],
		options?: {
			advisorResponses?: MockResponse[];
			sideResponses?: MockResponse[];
			planYolo?: boolean;
			initialPlanTools?: string[];
			toolCommands?: boolean;
			rebuildGate?: { fail: boolean };
		},
	): Promise<PlanHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const askTool = makeTool("ask");
		const writeTool = makeTool("write");
		const readTool = makeTool("read");
		const proposeTool = makeProposeTool();
		const bashTool = makeTool("bash");
		const toolRegistry = new Map<string, AgentTool>([
			["ask", askTool],
			["write", writeTool],
			["read", readTool],
			["propose", proposeTool],
			["bash", bashTool],
		]);
		const baseInitialTools = options?.planYolo
			? options.initialPlanTools?.includes("write")
				? [readTool, writeTool]
				: [readTool]
			: [askTool, writeTool, readTool];
		// `propose` presents top-level while plan mode is on, and `bash` carries
		// the tool-command transport, so a discoverable tool mounts only while it
		// is active in the session.
		const initialTools = options?.toolCommands
			? [...baseInitialTools, proposeTool, bashTool]
			: [...baseInitialTools, proposeTool];
		const builtInToolNames = options?.toolCommands ? ["ask", "write", "read", "bash"] : ["ask", "write", "read"];
		const toolCommands: ToolCommandState | undefined = options?.toolCommands
			? {
					tools: toolRegistry,
					mountedNames: new Set<string>(),
					builtInNames: new Set(["ask", "write", "read", "bash"]),
					isActive: name => currentAgent?.state.tools.some(tool => tool.name === name) ?? false,
				}
			: undefined;

		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
			streamFn: mock.stream,
		});
		const currentAgent = agent;

		let advisorMock: MockModel | undefined;
		let advisorStreamFn: StreamFn | undefined;
		if (options?.advisorResponses) {
			advisorMock = createMockModel({ responses: options.advisorResponses });
			advisorStreamFn = advisorMock.stream;
		}

		let sideMock: MockModel | undefined;
		let sideStreamFn: StreamFn | undefined;
		if (options?.sideResponses) {
			sideMock = createMockModel({ responses: options.sideResponses });
			sideStreamFn = sideMock.stream;
		}

		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			toolRegistry,
			builtInToolNames,
			advisorStreamFn,
			sideStreamFn,
			planYolo: options?.planYolo ? { target: model } : undefined,
			toolCommands,
			rebuildSystemPrompt: options?.rebuildGate
				? async () => {
						if (options.rebuildGate?.fail) throw new Error("rebuild failed");
						return { systemPrompt: ["Test"] };
					}
				: undefined,
		});
		if (!options?.planYolo) created.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		session = created;
		return {
			session: created,
			mock,
			advisorMock,
			sideMock,
		};
	}

	it("T1: an advisor concern does not wake the primary in plan mode", async () => {
		const harness = await createPlanSession([], {
			advisorResponses: [
				{
					content: [
						{ type: "toolCall", name: "advise", arguments: { note: "tighten the plan", severity: "concern" } },
					],
				},
			],
		});
		harness.session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(harness.session.setAdvisorEnabled(true)).toBe(true);
		const advisor = harness.session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect current turn").catch(() => {});
		await harness.session.waitForIdle();

		const advisorCards = harness.session.agent.state.messages.filter(
			m => m.role === "custom" && m.customType === "advisor",
		);
		expect(advisorCards.length).toBeGreaterThanOrEqual(1);
		expect(harness.mock.calls.length).toBe(0);
		expect(harness.advisorMock?.calls.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("accepts a proposal while plan mode is active without an installed handler", async () => {
		const harness = await createPlanSession([]);
		const planPath = resolveLocalUrlToPath("local://handlerless-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Handlerless plan\n\nDo it.\n");
		const handler = harness.session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected a proposal handler while plan mode is active");
		const result = await handler("handlerless");
		expect(result.details).toMatchObject({ planFilePath: "local://handlerless-plan.md", planExists: true });
	});

	it("T2: an idle IRC message does not wake an autonomous turn in plan mode", async () => {
		const harness = await createPlanSession([]);
		const msg: IrcMessage = { id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() };

		const outcome = await harness.session.deliverIrcMessage(msg);

		expect(outcome).toBe("injected");
		const sawIrc = harness.session.agent.state.messages.some(
			m => m.role === "custom" && m.customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(harness.mock.calls.length).toBe(0);
	});

	it("T3a: convergence reminders are bounded by the cap, then yield to the user", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
			{ content: ["planning B"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "b" } }] },
			{ content: ["planning C"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "c" } }] },
			{ content: ["planning D"] },
		]);

		harness.session.setTodoPhases([{ name: "Plan", tasks: [{ content: "draft the plan", status: "pending" }] }]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(3);
		expect(harness.mock.calls.length).toBe(7);
		expect(harness.session.getPlanModeState()?.enabled).toBe(true);
	});

	it("T3b: a propose call resets the convergence counter", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{
				content: [
					{
						type: "toolCall",
						name: "propose",
						arguments: { title: "test-reset" },
					},
				],
			},
			{ content: ["planning B"] },
			{ content: ["planning C"] },
		]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(2);
		expect(harness.mock.calls.length).toBe(4);
	});

	it("T3c: an ask call resets the convergence counter", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{
				content: [
					{
						type: "toolCall",
						name: "ask",
						arguments: {
							html: '<form><p>which?</p><label><input type="radio" name="q" value="a" checked> a</label><label><input type="radio" name="q" value="b"> b</label></form>',
						},
					},
				],
			},
			{ content: ["planning B"] },
			{ content: ["planning C"] },
		]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(2);
		expect(harness.mock.calls.length).toBe(4);
	});

	it("rolls PlanYolo state back when the plan-phase prompt rebuild fails", async () => {
		const rebuildGate = { fail: true };
		const harness = await createPlanSession([{ content: ["planning"] }], {
			planYolo: true,
			toolCommands: true,
			rebuildGate,
		});

		await expect(harness.session.prompt("make a plan")).rejects.toThrow("rebuild failed");
		expect(harness.session.getPlanModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).not.toContain("write");

		rebuildGate.fail = false;
		await harness.session.prompt("retry the plan");
		await harness.session.waitForIdle();
		expect(harness.session.getPlanModeState()?.enabled).toBe(true);
		expect(harness.session.getActiveToolNames()).toContain("write");
	});

	it("restores the pre-plan tool set after PlanYolo approval", async () => {
		const harness = await createPlanSession(
			[
				{ content: ["planning A"] },
				{ content: ["planning B"] },
				{ content: ["planning C"] },
				{ content: ["planning D"] },
			],
			{ planYolo: true },
		);
		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();
		expect(harness.session.getPlanModeState()?.enabled).toBe(true);
		expect(harness.session.getActiveToolNames()).toContain("write");

		const planPath = resolveLocalUrlToPath("local://demo-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Demo plan\n\nImplement it.\n");
		const handler = harness.session.peekPlanProposalHandler();
		expect(handler).toBeDefined();
		await handler!("demo");

		expect(harness.session.getPlanModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
	});

	it("retains MCP tools discovered while PlanYolo is active", async () => {
		const harness = await createPlanSession(
			[{ content: ["planning A"] }, { content: ["planning B"] }, { content: ["planning C"] }],
			{ planYolo: true, initialPlanTools: ["read", "write"], toolCommands: true },
		);
		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		const chromeTool = makeMcpTool("mcp__chrome_devtools_list_pages", "discoverable");
		const contextTool = makeMcpTool("mcp__context_query_docs", "essential");
		await harness.session.refreshMCPTools([chromeTool, contextTool]);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([
			"mcp__context_query_docs",
			"mcp__chrome_devtools_list_pages",
		]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__context_query_docs");
		expect(harness.session.getMountedToolCommandNames()).toContain("mcp__chrome_devtools_list_pages");

		const planPath = resolveLocalUrlToPath("local://mcp-tools-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# MCP tools plan\n\nKeep the connected tools.\n");
		const handler = harness.session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected PlanYolo proposal handler");
		await handler("mcp-tools");

		expect(harness.session.getPlanModeState()).toBeUndefined();
		const restoredActive = harness.session.getActiveToolNames();
		expect(restoredActive).toContain("read");
		expect(restoredActive).toContain("write");
		expect(restoredActive).toContain("mcp__context_query_docs");
		expect(harness.session.getMountedToolCommandNames()).toEqual(["mcp__chrome_devtools_list_pages"]);
		expect(harness.session.getSelectedMCPToolNames()).toEqual([
			"mcp__context_query_docs",
			"mcp__chrome_devtools_list_pages",
		]);
	});

	it("serializes PlanYolo restoration after a pending MCP refresh", async () => {
		const harness = await createPlanSession(
			[{ content: ["planning A"] }, { content: ["planning B"] }, { content: ["planning C"] }],
			{ planYolo: true, initialPlanTools: ["read", "write"], toolCommands: true },
		);
		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = harness.session.runToolRegistryMutation(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;

		const chromeTool = makeMcpTool("mcp__chrome_devtools_list_pages", "discoverable");
		const refresh = harness.session.refreshMCPTools([chromeTool]);
		const planPath = resolveLocalUrlToPath("local://queued-mcp-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Queued MCP plan\n\nKeep the connected tool.\n");
		const handler = harness.session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected PlanYolo proposal handler");
		const approval = handler("queued-mcp");
		release.resolve();
		await Promise.all([blocker, refresh, approval]);

		expect(harness.session.getPlanModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("read");
		expect(harness.session.getActiveToolNames()).toContain("write");
		expect(harness.session.getMountedToolCommandNames()).toEqual(["mcp__chrome_devtools_list_pages"]);
		expect(harness.session.getSelectedMCPToolNames()).toContain("mcp__chrome_devtools_list_pages");
	});

	it("preserves late MCP selection without leaking plan-only write", async () => {
		const harness = await createPlanSession(
			[{ content: ["planning A"] }, { content: ["planning B"] }, { content: ["planning C"] }],
			{ planYolo: true, toolCommands: true },
		);
		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		const chromeTool = makeMcpTool("mcp__chrome_devtools_list_pages", "discoverable", "write");
		await harness.session.refreshMCPTools([chromeTool]);
		const registeredTool = harness.session.getToolByName("mcp__chrome_devtools_list_pages");
		expect(registeredTool).toBeDefined();

		const planPath = resolveLocalUrlToPath("local://read-only-mcp-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Read-only MCP plan\n\nKeep the selected tool.\n");
		const handler = harness.session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected PlanYolo proposal handler");
		await handler("read-only-mcp");

		expect(harness.session.getPlanModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("read");
		expect(harness.session.getActiveToolNames()).not.toContain("write");
		expect(harness.session.getMountedToolCommandNames()).toEqual(["mcp__chrome_devtools_list_pages"]);
		expect(harness.session.getSelectedMCPToolNames()).toEqual(["mcp__chrome_devtools_list_pages"]);
		expect(harness.session.getToolByName("mcp__chrome_devtools_list_pages")).toBe(registeredTool);
	});

	it("keeps PlanYolo retryable when pre-plan tool restoration fails", async () => {
		const rebuildGate = { fail: false };
		const harness = await createPlanSession([{ content: ["planning"] }], { planYolo: true, rebuildGate });
		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();
		const planPath = resolveLocalUrlToPath("local://retry-plan.md", {
			getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
			getSessionId: () => harness.session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Retry plan\n\nImplement it.\n");
		const handler = harness.session.peekPlanProposalHandler();
		expect(handler).toBeDefined();
		const activeBefore = harness.session.getActiveToolNames();
		const mountedBefore = harness.session.getMountedToolCommandNames();
		rebuildGate.fail = true;

		await expect(handler!("retry")).rejects.toThrow("rebuild failed");
		expect(harness.session.getPlanModeState()?.enabled).toBe(true);
		expect(harness.session.peekPlanProposalHandler()).toBe(handler);
		expect(harness.session.getActiveToolNames()).toEqual(activeBefore);
		expect(harness.session.getMountedToolCommandNames()).toEqual(mountedBefore);
		rebuildGate.fail = false;
		await handler!("retry");
		expect(harness.session.getPlanModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_TEAMS_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-teams";
import { HandbackTool } from "@oh-my-pi/pi-coding-agent/task/handback";
import { teamRuntime, type TeamIdentity } from "@oh-my-pi/pi-coding-agent/task/team-runtime";
import type { TeamDefinition } from "@oh-my-pi/pi-coding-agent/task/teams";
import { getTeamClient } from "@oh-my-pi/pi-coding-agent/thread/services/team-client";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

const required = "plan approval required: send it via write team://audit/plan";
const sessions: AgentSession[] = [];
let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-team-plan-"));
	AgentRegistry.resetGlobalForTests();
	teamRuntime.resetForTests();
	IrcBus.resetGlobalForTests();
	InternalUrlRouter.resetForTests();
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	await fs.rm(cwd, { recursive: true, force: true });
});

function basicTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function makeSession(
	options: {
		coordinationOnlyWrite?: boolean;
		xdev?: boolean;
		extensionRunner?: ExtensionRunner;
		requireYieldTool?: boolean;
	} = {},
) {
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "team.enabled": true });
	const toolSession: ToolSession = {
		cwd,
		settings,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionInstanceKey: () => session.instanceKey,
		coordinationOnlyWrite: options.coordinationOnlyWrite,
		requireYieldTool: options.requireYieldTool,
		taskDepth: 1,
		getToolByName: name => registry.get(name),
	};
	const write = new WriteTool(toolSession);
	const registry = new Map<string, Tool>(
		[
			"read",
			"grep",
			"glob",
			"lsp",
			"web_search",
			"wait",
			"bash",
			"edit",
			"task",
			"todo",
			"Read",
			"read_file",
			"mcp__read",
		].map(name => [name, basicTool(name)]),
	);
	registry.set("write", write);
	if (options.requireYieldTool) {
		registry.set("yield", new YieldTool(toolSession));
		registry.set("handback", new HandbackTool(toolSession));
	}
	if (options.xdev) {
		const xdev: XdevState = {
			tools: registry,
			mountedNames: new Set(["bash"]),
			builtInNames: new Set(registry.keys()),
			isActive: () => true,
			resolve: name => resolveXdevTool(xdev, name),
		};
		toolSession.xdev = xdev;
	}
	const model = createMockModel().model;
	const agent = new Agent({
		initialState: { model, systemPrompt: ["test"], tools: [...registry.values()], messages: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		settings,
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry: {} as never,
		evalToolSession: toolSession,
		toolRegistry: registry,
		xdev: toolSession.xdev,
		extensionRunner: options.extensionRunner,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["rebuilt"] }),
	});
	sessions.push(session);
	return { session, toolSession, registry, write };
}

async function fixture(
	options: {
		planApproval?: boolean;
		coordinationOnlyWrite?: boolean;
		xdev?: boolean;
		extensionRunner?: ExtensionRunner;
		requireYieldTool?: boolean;
	} = {},
) {
	const lead = makeSession();
	const member = makeSession(options);
	const registry = AgentRegistry.global();
	const leadMessages: IrcMessage[] = [];
	const memberMessages: IrcMessage[] = [];
	vi.spyOn(lead.session, "deliverIrcMessage").mockImplementation(async message => {
		leadMessages.push(message);
		return "injected";
	});
	vi.spyOn(member.session, "deliverIrcMessage").mockImplementation(async message => {
		memberMessages.push(message);
		return "injected";
	});
	IrcBus.installGlobal(new IrcBus(registry, undefined, { settings: member.session.settings }));
	registry.register({ id: "Lead", displayName: "Lead", kind: "main", session: lead.session });
	const team: TeamDefinition = {
		name: "audit",
		description: "audit",
		workspace: path.join(cwd, "workspace"),
		members: [{ agent: "task", handle: "Scout" }],
		body: "audit",
		source: "project",
		filePath: path.join(cwd, "audit.md"),
		planApproval: options.planApproval ?? true,
	};
	const client = getTeamClient();
	const started = await client.start(lead.session.instanceKey, team);
	const ref = registry.register({ id: "Scout", displayName: "Scout", kind: "sub", session: member.session });
	expect(
		await client.putMember(lead.session.instanceKey, "audit", started.generation, "Scout", null, {
			id: ref.id,
			ref,
			reservation: "scout-reservation",
		}),
	).toBe(true);
	member.toolSession.teamIdentity = await client.memberIdentity(
		lead.session.instanceKey,
		"audit",
		started.generation,
		"Scout",
	);
	return { ...member, lead: lead.session, client, leadMessages, memberMessages };
}

// Exercise the hook installed by the real AgentSession, not a copy of its policy.
async function before(
	session: AgentSession,
	name: string,
	args: Record<string, unknown> = {},
): Promise<BeforeToolCallResult | undefined> {
	const tool = session.getToolByName(name) ?? basicTool(name);
	const model = session.agent.state.model!;
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return session.agent.beforeToolCall!({
		tool,
		args,
		assistantMessage,
		context: session.agent.state,
		toolCall: { type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
	});
}
async function dispatchWrite(session: AgentSession, args: { path: string; content: string }) {
	const gate = await before(session, "write", args);
	if (gate?.block) return gate;
	return session.getToolByName("write")!.execute("write-test", gate?.args ?? args);
}

async function teamCommand(lead: AgentSession, args: string) {
	const outputs: string[] = [];
	await BUILTIN_TEAMS_SLASH_COMMANDS[0]!.handle!(
		{ name: "team", args, text: `/team ${args}` },
		{
			session: lead,
			sessionManager: lead.sessionManager,
			settings: lead.settings,
			cwd,
			output: text => {
				outputs.push(text);
			},
			refreshCommands() {},
			async reloadPlugins() {},
		},
	);
	return outputs.join("\n");
}

function rewritingRunner(rewrite: () => unknown): ExtensionRunner {
	return {
		hasHandlers: (event: string) => event === "tool_call",
		markLoopToolCall() {},
		clearLoopToolCall() {},
		markToolCallEmitted() {},
		emitToolCall: async () => ({ input: rewrite() }),
		emit: async () => undefined,
	} as unknown as ExtensionRunner;
}

describe("AgentSession authoritative team plan gate", () => {
	it("allows only the eight exact read/search/wait names, not aliases or unlisted tools", async () => {
		const { session } = await fixture();
		for (const name of ["read", "grep", "glob", "find", "ast_grep", "lsp", "web_search", "wait"])
			expect((await before(session, name, name === "lsp" ? { action: "hover" } : {}))?.block).not.toBe(true);
		for (const name of [
			"bash",
			"edit",
			"task",
			"todo",
			"Read",
			"read_file",
			"mcp__read",
			"eval",
			"multi_tool_use.parallel",
			"unknown",
		]) {
			expect(await before(session, name)).toMatchObject({ block: true, reason: required });
		}
	});
	it("admits read-only find and ast_grep, keeping ast_edit, edit, bash and file writes blocked", async () => {
		const { session } = await fixture();
		for (const name of ["find", "ast_grep"]) expect((await before(session, name))?.block).not.toBe(true);
		for (const name of ["ast_edit", "edit", "bash"])
			expect(await before(session, name)).toMatchObject({ block: true, reason: required });
		expect(await dispatchWrite(session, { path: "blocked.txt", content: "bad" })).toMatchObject({
			block: true,
			reason: required,
		});
		expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
	});

	it("blocks mutating LSP actions and extension rewrites to them", async () => {
		const { session } = await fixture();
		for (const action of ["hover", "definition", "references", "diagnostics"])
			expect((await before(session, "lsp", { action }))?.block).not.toBe(true);
		for (const args of [
			{ action: "rename", new_name: "changed" },
			{ action: "rename_file", file: "old.ts", new_name: "new.ts" },
			{ action: "code_actions", apply: true },
			{ action: "request", query: "workspace/executeCommand" },
			{},
		])
			expect(await before(session, "lsp", args)).toMatchObject({ block: true, reason: required });
		const rewritten = await fixture({
			extensionRunner: rewritingRunner(() => ({ action: "rename", new_name: "changed" })),
		});
		expect((await before(rewritten.session, "read"))?.block).not.toBe(true);
		expect(await before(rewritten.session, "lsp", { action: "hover" })).toMatchObject({
			block: true,
			reason: required,
		});
	});

	for (const xdev of [false, true]) {
		it(`blocks disk, selector and nested/device smuggling with xdev=${xdev}`, async () => {
			const { session } = await fixture({ xdev });
			for (const target of [
				"blocked.txt",
				"[blocked.txt#ABCD]",
				"./agent://Scout",
				"agent://Scout/../../blocked.txt:1-2",
				"local://blocked.txt",
				"file://blocked.txt",
				"agentx://Scout",
				"xd://bash",
				"[xd://bash#ABCD]",
				"xd://write",
				"xd://read",
				"team://audit/tasks:1-2",
				"agent:/Scout",
			]) {
				const result = await before(session, "write", {
					path: target,
					content: JSON.stringify({ command: "touch blocked.txt", path: "blocked.txt" }),
				});
				expect(result).toMatchObject({ block: true, reason: required });
			}
			expect(await dispatchWrite(session, { path: "blocked.txt", content: "blocked" })).toMatchObject({
				block: true,
			});
			expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
		});
	}

	it("requires coordination scope as well as the exact agent/team scheme", async () => {
		const { session } = await fixture();
		const router = InternalUrlRouter.instance();
		router.register({
			scheme: "agent",
			spec: {
				backing: "file",
				selectors: "lines",
				immutable: false,
				write: { via: "file", payload: "text", scope: "workspace", tier: () => "write" },
			},
			locate: async () => path.join(cwd, "smuggled.txt"),
			resolve: async () => ({ url: "agent://Scout", content: "", contentType: "text/plain" }),
		});
		expect(await dispatchWrite(session, { path: "[agent://Scout#ABCD]", content: "bad" })).toMatchObject({
			block: true,
			reason: required,
		});
		router.register({
			scheme: "coord",
			spec: {
				backing: "virtual",
				selectors: "none",
				immutable: true,
				write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
			},
			resolve: async () => ({ url: "coord://Scout", content: "", contentType: "text/plain" }),
			write: async () => ({ content: [{ type: "text", text: "sent" }] }),
		});
		expect(await before(session, "write", { path: "coord://Scout", content: "bad" })).toMatchObject({
			block: true,
			reason: required,
		});
		expect(await Bun.file(path.join(cwd, "smuggled.txt")).exists()).toBe(false);
	});

	it("allows normalized coordination targets exactly as WriteTool resolves them", async () => {
		const { session } = await fixture();
		for (const target of [
			"agent://Scout",
			"[agent://Scout#ABCD]",
			"team://audit/plan",
			"team:/audit/plan",
			"[team:/audit/plan#ABCD]",
			"team://audit/tasks",
			"team://audit/tasks:raw",
			"team://audit/tasks:conflicts",
		]) {
			expect((await before(session, "write", { path: target, content: "plan" }))?.block).not.toBe(true);
		}
	});

	it("rechecks extension rewritten final targets and malformed arguments", async () => {
		let rewritten: unknown = { path: "blocked.txt", content: "bad" };
		const { session } = await fixture({ extensionRunner: rewritingRunner(() => rewritten) });
		for (const value of [
			{ path: "blocked.txt", content: "bad" },
			{ path: "[xd://bash#ABCD]", content: "{}" },
			{},
			null,
			{ path: 12 },
		]) {
			rewritten = value;
			expect(await before(session, "write", { path: "team://audit/plan", content: "safe" })).toMatchObject({
				block: true,
				reason: required,
			});
		}
		expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
	});

	it("uses runtime approval on every call: reject, resubmit, approve then actually write", async () => {
		const { session, lead, leadMessages, memberMessages } = await fixture();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const args = { path: "result.txt", content: "approved output" };
		expect(await dispatchWrite(session, args)).toMatchObject({ block: true, reason: required });
		await dispatchWrite(session, { path: "[team:/audit/plan#ABCD]", content: "First plan" });
		expect(leadMessages.some(message => message.body.includes("First plan"))).toBe(true);
		expect(await teamCommand(lead, "reject Scout Include verification")).toContain("rejected");
		expect(memberMessages.some(message => message.body.includes("Include verification"))).toBe(true);
		expect(await dispatchWrite(session, args)).toMatchObject({ block: true, reason: required });
		now += 500; // Revised plans are ordinary rate-charged progress, so begin a fresh window.
		await dispatchWrite(session, { path: "team://audit/plan", content: "Revised plan with verification" });
		expect(await teamCommand(lead, "approve Scout")).toContain("approved");
		const approvals = memberMessages.filter(message => message.body.includes("Plan approved"));
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({ from: "Lead", to: "Scout", progress: true, teamControl: true });
		expect(approvals[0]!.body).toContain("mutation tools are available");
		expect(IrcBus.global().unansweredSends("Lead", 0)).toEqual([]);
		expect(IrcBus.global().unansweredSends("Scout", 0)).toEqual([]);
		await dispatchWrite(session, args);
		expect(await Bun.file(path.join(cwd, "result.txt")).text()).toBe("approved output");
	});

	it("approval does not promote lifetime coordination-only write capability", async () => {
		const { session, lead, client, toolSession } = await fixture({ coordinationOnlyWrite: true });
		await dispatchWrite(session, { path: "team://audit/plan", content: "Plan" });
		await client.approve(lead.instanceKey, "Scout");
		await expect(dispatchWrite(session, { path: "blocked.txt", content: "bad" })).rejects.toThrow(
			"coordination-only",
		);
		expect(toolSession.coordinationOnlyWrite).toBe(true);
		expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
	});

	it("blocks a locally ungated identity when the runtime still requires approval", async () => {
		const { session, toolSession } = await fixture();
		toolSession.teamIdentity = { ...toolSession.teamIdentity!, planApproval: false };
		expect(await dispatchWrite(session, { path: "blocked.txt", content: "bad" })).toMatchObject({
			block: true,
			reason: required,
		});
		expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
	});

	it("does not trust a false identity on service failure or a live member authority mismatch", async () => {
		const { session, client, toolSession } = await fixture();
		toolSession.teamIdentity = { ...toolSession.teamIdentity!, planApproval: false, memberId: "outsider" };
		expect(await before(session, "read")).toMatchObject({ block: true, reason: required });
		vi.spyOn(client, "planPending").mockRejectedValue(new Error("thread service unavailable"));
		expect(await before(session, "read")).toMatchObject({ block: true, reason: required });
	});

	for (const name of ["yield", "handback"]) {
		it(`lets a forced ${name} finish a gated member turn without a reminder loop`, async () => {
			const { session, client, toolSession } = await fixture({ requireYieldTool: true });
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								name,
								arguments:
									name === "yield"
										? { type: "result", data: "Plan submitted; awaiting approval" }
										: { report: "Plan submitted; awaiting approval" },
							},
						],
					},
				],
			});
			session.agent.streamFn = mock.stream;
			session.agent.setModel(mock.model);
			await session.agent.prompt("Finish the current turn while awaiting approval", {
				toolChoice: { type: "tool", name },
			});
			const results = session.agent.state.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ toolName: name, isError: false, details: { status: "success" } });
			expect(await client.planPending(session.instanceKey, toolSession.teamIdentity!)).toBe(true);
			expect(await dispatchWrite(session, { path: "blocked.txt", content: "bad" })).toMatchObject({
				block: true,
				reason: required,
			});
		});
	}

	for (const authority of ["stale", "unreachable", "mismatched"] as const) {
		it(`allows yield and handback with ${authority} team authority while other tools fail closed`, async () => {
			const { session, client, toolSession } = await fixture({ requireYieldTool: true });
			if (authority === "stale") {
				toolSession.teamIdentity = { ...toolSession.teamIdentity!, generation: -1 };
			} else if (authority === "unreachable") {
				vi.spyOn(client, "planPending").mockRejectedValue(new Error("thread service unavailable"));
			} else {
				toolSession.teamIdentity = { ...toolSession.teamIdentity!, memberId: "outsider" };
			}
			for (const name of ["yield", "handback"]) {
				expect(await before(session, name)).toBeUndefined();
			}
			for (const name of ["read", "grep", "glob", "lsp", "web_search", "wait", "bash", "edit", "task", "write"]) {
				expect(
					await before(session, name, { action: "hover", path: "team://audit/plan", content: "plan" }),
				).toMatchObject({ block: true, reason: required });
			}
		});
	}

	it("fails closed even for allowlisted tools on runtime failure", async () => {
		const { session, client } = await fixture();
		vi.spyOn(client, "planPending").mockRejectedValue(new Error("thread service unavailable"));
		for (const name of ["read", "wait", "bash", "write"]) {
			expect(await before(session, name, { path: "team://audit/plan", content: "plan" })).toMatchObject({
				block: true,
				reason: required,
			});
		}
	});

	it("does not cache an ungated runtime result and survives tool rebuilding", async () => {
		const { session, client } = await fixture();
		const pending = vi.spyOn(client, "planPending").mockResolvedValue(false);
		expect((await before(session, "bash"))?.block).not.toBe(true);
		pending.mockResolvedValue(true);
		await session.setActiveToolsByName(["read", "write", "bash"]);
		expect(await before(session, "bash")).toMatchObject({ block: true, reason: required });
		pending.mockResolvedValue(false);
		expect((await before(session, "bash"))?.block).not.toBe(true);
	});

	it("leaves nonteam and runtime-ungated sessions unchanged", async () => {
		const nonteam = makeSession();
		await dispatchWrite(nonteam.session, { path: "nonteam.txt", content: "ordinary" });
		expect(await Bun.file(path.join(cwd, "nonteam.txt")).text()).toBe("ordinary");
		const member = await fixture({ planApproval: false });
		await dispatchWrite(member.session, { path: "ungated.txt", content: "ordinary" });
		expect(await Bun.file(path.join(cwd, "ungated.txt")).text()).toBe("ordinary");
	});

	it("rechecks runtime state after an extension changes it during argument preparation", async () => {
		const client = getTeamClient();
		const { session } = await fixture({
			extensionRunner: rewritingRunner(() => {
				pending.mockResolvedValue(true);
				return { path: "result.txt", content: "bad" };
			}),
		});
		const pending = vi.spyOn(client, "planPending").mockResolvedValue(false);
		expect(await dispatchWrite(session, { path: "team://audit/plan", content: "plan" })).toMatchObject({
			block: true,
			reason: required,
		});
		expect(await Bun.file(path.join(cwd, "result.txt")).exists()).toBe(false);
	});

	it("the real agent loop cannot dispatch a write device around the pending gate", async () => {
		const { session } = await fixture({ xdev: true });
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: {
								path: "xd://write",
								content: JSON.stringify({ path: path.join(cwd, "nested.txt"), content: "bad" }),
							},
						},
					],
				},
				{ content: ["stopped"] },
			],
		});
		session.agent.streamFn = mock.stream;
		session.agent.setModel(mock.model);
		await session.agent.prompt("Attempt a nested write");
		const result = session.agent.state.messages.find(message => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain(required);
		expect(await Bun.file(path.join(cwd, "nested.txt")).exists()).toBe(false);
	});
	it("fails closed for a stale trusted membership identity", async () => {
		const { session, toolSession } = await fixture();
		toolSession.teamIdentity = { ...toolSession.teamIdentity!, generation: -1 } satisfies TeamIdentity;
		expect(await before(session, "write", { path: "result.txt", content: "bad" })).toMatchObject({
			block: true,
			reason: required,
		});
	});
	it("blocks a plain same-text error from a stub: only coded runtime errors open the cold-revival fallback", async () => {
		// Same message text as the runtime's TEAM_LEAD_GONE error, but thrown by
		// a plain Error with no `code`: the fallback must match the coded class,
		// never the text, so a spoofed stub cannot unlock the gate.
		const { session, client, toolSession } = await fixture();
		toolSession.teamIdentity = { ...toolSession.teamIdentity!, planApproval: false };
		vi.spyOn(client, "planPending").mockRejectedValue(new Error("Team lead is no longer registered"));
		expect(await before(session, "read")).toMatchObject({ block: true, reason: required });
	});
});

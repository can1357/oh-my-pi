import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

// The executor gives createTools the agent's declared read-only tool list.
// It grants a restricted reply transport, not filesystem editing. Device
// dispatch, cancellation, and session-local scratch retain upstream permissions;
// writing outside that scratch and mounting edit remain blocked.
const READ_ONLY_AGENT_TOOLS = ["read", "grep", "glob", "yield"];

const received = new Map<string, IrcMessage[]>();
let registry: AgentRegistry;

function registerPeer(id: string, status: "running" | "idle" = "running"): void {
	const messages: IrcMessage[] = [];
	received.set(id, messages);
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		status,
		session: {
			deliverIrcMessage: async (message: IrcMessage) => {
				messages.push(message);
				return status === "idle" ? "woken" : "injected";
			},
		} as AgentSession,
	});
}

function readOnlySession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		// xdev off: prove the reply transport does not ride the xd:// one.
		settings: Settings.isolated({ "tools.xdev": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "ReadOnlyWorker",
		agentRegistry: registry,
	} as unknown as ToolSession;
}

async function readOnlyTools(): Promise<Tool[]> {
	return createTools(readOnlySession(), [...READ_ONLY_AGENT_TOOLS]);
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registry = AgentRegistry.global();
	registry.register({
		id: "ReadOnlyWorker",
		displayName: "ReadOnlyWorker",
		kind: "sub",
		parentId: "Main",
		session: null,
	});
	received.clear();
});
afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("read-only agent reply via write agent://", () => {
	it("allows write agent://<id>: delivers the reply to the peer", async () => {
		registerPeer("Main");
		const write = (await readOnlyTools()).find(tool => tool.name === "write")!;
		const result = await write.execute("call-reply", { path: "agent://Main", content: "reply: all clear" });
		expect(result.content).toEqual([{ type: "text", text: "Delivered to Main." }]);
		expect(received.get("Main")?.map(message => message.body)).toEqual(["reply: all clear"]);
	});

	it("allows write agent://all: broadcast is still an agent:// message target", async () => {
		// Decision: ALLOW. The lead's rule keys on the URI namespace ("target is
		// an agent:// URI"); agent://all delivers message text to peer sessions
		// only — no filesystem, device, or tool state — and a read-only worker
		// answering a group check-in must be able to reach all peers.
		registerPeer("Scout");
		registerPeer("Reviewer");
		const write = (await readOnlyTools()).find(tool => tool.name === "write")!;
		const result = await write.execute("call-broadcast", { path: "agent://all", content: "reply: done" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Broadcast delivered") });
		expect(received.get("Scout")?.map(message => message.body)).toEqual(["reply: done"]);
		expect(received.get("Reviewer")?.map(message => message.body)).toEqual(["reply: done"]);
	});

	it("still refuses a local file write (negative control)", async () => {
		const write = (await readOnlyTools()).find(tool => tool.name === "write")!;
		const probe = "/tmp/readonly-reply-probe.txt";
		await expect(write.execute("call-file", { path: probe, content: "should never land" })).rejects.toThrow(
			/agent:\/\//,
		);
		expect(await Bun.file(probe).exists()).toBe(false);
	});

	it("keeps edit refused: edit is never mounted for a read-only tool list", async () => {
		const tools = await readOnlyTools();
		expect(tools.map(tool => tool.name)).not.toContain("edit");
	});

	it("does not grant write to a restricted session that owns its exact tool list", async () => {
		const session = { ...readOnlySession(), restrictToolNames: true } as ToolSession;
		const tools = await createTools(session, [...READ_ONLY_AGENT_TOOLS]);
		expect(tools.map(tool => tool.name)).not.toContain("write");
		expect(session.agentOnlyWrite).toBeUndefined();
	});

	it("still grants the agent-only write when externalThinking appends think to the plan", async () => {
		const session = readOnlySession();
		session.settings = Settings.isolated({ "tools.xdev": false, externalThinking: true });
		const model = getBundledModel("anthropic", "claude-fable-5");
		session.getActiveModel = () => model;
		const tools = await createTools(session, [...READ_ONLY_AGENT_TOOLS]);
		expect(tools.map(tool => tool.name)).toContain("think");
		expect(tools.map(tool => tool.name)).toContain("write");
		expect(session.agentOnlyWrite).toBe(true);
	});

	it("grants nothing when peer messaging is disabled, since agent:// writes would all be rejected", async () => {
		const session = { ...readOnlySession(), enableIrc: false } as ToolSession;
		const tools = await createTools(session, [...READ_ONLY_AGENT_TOOLS]);
		expect(tools.map(tool => tool.name)).not.toContain("write");
		expect(session.agentOnlyWrite).toBeUndefined();
		expect(session.deviceOnlyWrite).toBeUndefined();
	});

	it("does not mount write for a list with a mutating tool", async () => {
		const tools = await createTools(readOnlySession(), ["read", "bash"]);
		expect(tools.map(tool => tool.name)).not.toContain("write");
	});
});

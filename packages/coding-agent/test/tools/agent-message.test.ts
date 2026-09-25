import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

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

function makeSession(options: { senderId?: string; deviceOnlyWrite?: boolean; planMode?: boolean } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => options.senderId ?? "Main",
		agentRegistry: registry,
		deviceOnlyWrite: options.deviceOnlyWrite,
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registry = AgentRegistry.global();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
	received.clear();
});
afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("write agent:// messaging", () => {
	it("delivers the exact content to a live peer and reports a receipt", async () => {
		registerPeer("Scout");
		const tool = new WriteTool(makeSession());
		expect(tool.approval({ path: "agent://Scout", content: "question" })).toBe("read");
		const result = await tool.execute("send", { path: "agent://Scout", content: "question\nanswer?" });
		expect(result.content).toEqual([{ type: "text", text: "Delivered to Scout." }]);
		expect(result.details?.message).toMatchObject({
			op: "send",
			to: "Scout",
			receipts: [{ to: "Scout", outcome: "injected" }],
		});
		expect(received.get("Scout")?.map(message => [message.from, message.body])).toEqual([
			["Main", "question\nanswer?"],
		]);
	});

	it("broadcasts to live peers without reviving parked agents", async () => {
		registerPeer("Scout");
		registerPeer("Reviewer", "idle");
		registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const result = await new WriteTool(makeSession()).execute("broadcast", {
			path: "agent://all",
			content: "update",
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Broadcast delivered to 2 of 2 peer(s)."),
		});
		expect(received.get("Scout")?.map(message => message.body)).toEqual(["update"]);
		expect(received.get("Reviewer")?.map(message => message.body)).toEqual(["update"]);
		expect(result.details?.message?.receipts).toMatchObject([
			{ to: "Scout", outcome: "injected" },
			{ to: "Reviewer", outcome: "woken" },
		]);
		await expect(new AgentProtocolHandler().resolve(new URL("agent://all") as never)).rejects.toThrow("write-only");
	});

	it("does not duplicate a child broadcast in the main session's relay view", async () => {
		registerPeer("Sender");
		registerPeer("Sibling");
		const delivered: IrcMessage[] = [];
		const relayed: unknown[] = [];
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: {
				deliverIrcMessage: async (message: IrcMessage) => {
					delivered.push(message);
					return "injected";
				},
				emitIrcRelayObservation: (record: unknown) => {
					relayed.push(record);
				},
			} as AgentSession,
		});
		const result = await new WriteTool(makeSession({ senderId: "Sender" })).execute("broadcast", {
			path: "agent://all",
			content: "one update",
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("2 of 2 peer(s)") });
		expect(delivered.map(message => message.body)).toEqual(["one update"]);
		expect(received.get("Sibling")?.map(message => message.body)).toEqual(["one update"]);
		expect(relayed).toEqual([]);
	});

	it("reports unknown and stopped recipients without delivering", async () => {
		const tool = new WriteTool(makeSession());
		const unknown = await tool.execute("unknown", { path: "agent://Missing", content: "hello" });
		expect(unknown.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Failed: Missing is not running."),
		});
		expect(unknown.isError).toBeTrue();
		expect(unknown.details?.message?.receipts).toMatchObject([{ to: "Missing", outcome: "failed" }]);
		registry.register({ id: "Stopped", displayName: "Stopped", kind: "sub", session: null, status: "aborted" });
		const stopped = await tool.execute("stopped", { path: "agent://Stopped", content: "hello" });
		expect(stopped.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Failed: Stopped is not running."),
		});
	});

	it("rejects messaging when the session has no peer capability", async () => {
		registerPeer("Scout");
		const disabled = makeSession();
		disabled.enableIrc = false;
		await expect(
			new WriteTool(disabled).execute("disabled", { path: "agent://Scout", content: "hello" }),
		).rejects.toThrow("Peer messaging is unavailable in this session.");
		expect(received.get("Scout")).toEqual([]);
	});

	it("permits device-only and plan-mode messaging, but rejects path suffixes and empty content", async () => {
		registerPeer("Scout");
		const deviceOnly = new WriteTool(makeSession({ deviceOnlyWrite: true }));
		const planMode = new WriteTool(makeSession({ planMode: true }));
		expect(
			(await deviceOnly.execute("device", { path: "agent://Scout", content: "from device" })).content[0],
		).toMatchObject({ text: "Delivered to Scout." });
		expect(
			(await planMode.execute("plan", { path: "agent://Scout", content: "from plan" })).content[0],
		).toMatchObject({ text: "Delivered to Scout." });
		await expect(planMode.execute("suffix", { path: "agent://Scout/result", content: "oops" })).rejects.toThrow(
			"JSON-path suffix",
		);
		await expect(deviceOnly.execute("empty", { path: "agent://Scout", content: "  " })).rejects.toThrow(
			"non-empty content",
		);
		expect(received.get("Scout")?.map(message => message.body)).toEqual(["from device", "from plan"]);
	});
});

/**
 * Reply tracking across the cross-process seam: an inbound remote message that expects a reply
 * leaves the local recipient owing the remote sender one, exactly as a local peer request does; a
 * later `write agent://@ns/name` routed through the namespace's RemoteTransport answers it, and a
 * `?progress` note does not. A remote peer the caller asked never sustains (or "stops") a reply wait.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const REMOTE = "@cluster-a/leia";

function setup() {
	const registry = AgentRegistry.global();
	registry.register({
		id: "worker",
		displayName: "worker",
		kind: "sub",
		parentId: "Main",
		session: null,
		status: "running",
	});
	const bus = IrcBus.forRegistry(registry);
	const outbound: IrcMessage[] = [];
	const transport: RemoteTransport = {
		async send(message) {
			outbound.push(message);
			return { to: message.to, outcome: "injected" };
		},
	};
	bus.setRemoteTransport("cluster-a", transport, "ext:test");
	return { registry, bus, outbound };
}

/** Deliver an inbound remote message into a pending local `wait`, so delivery succeeds in-process. */
async function inbound(bus: IrcBus, body: string, opts?: { expectsReply?: boolean }) {
	const taken = bus.wait("worker", { from: REMOTE }, 1000);
	const { receipt } = await bus.deliverInbound({ from: REMOTE, to: "worker", body }, opts);
	expect(receipt.outcome).toBe("injected");
	await taken;
}

const owedTo = (bus: IrcBus) => bus.unansweredSends(REMOTE, 0).map(entry => entry.to);

describe("IrcBus owed replies to remote peers", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("an inbound remote request is owed until a reply through the transport answers it", async () => {
		const { bus, outbound } = setup();
		await inbound(bus, "what is 2+2?", { expectsReply: true });
		expect(owedTo(bus)).toEqual(["worker"]);

		await bus.send({ from: "worker", to: REMOTE, body: "4" });
		expect(outbound.map(message => message.body)).toEqual(["4"]);
		expect(owedTo(bus)).toEqual([]);
	});

	it("a progress note to the remote peer promises the reply but does not settle it", async () => {
		const { bus, outbound } = setup();
		await inbound(bus, "summarize the repo", { expectsReply: true });

		await bus.send({ from: "worker", to: REMOTE, body: "on it", progress: true });
		expect(outbound).toHaveLength(1);
		expect(bus.unansweredSends(REMOTE, 0)).toEqual([expect.objectContaining({ to: "worker", promised: true })]);

		await bus.send({ from: "worker", to: REMOTE, body: "done" });
		expect(owedTo(bus)).toEqual([]);
	});

	it("an inbound message that expects no reply leaves nothing owed but still answers the local agent", async () => {
		const { bus } = setup();
		await bus.send({ from: "worker", to: REMOTE, body: "ping?" });
		expect(bus.unansweredSends("worker", 0).map(entry => entry.to)).toEqual([REMOTE]);

		await inbound(bus, "pong");
		expect(owedTo(bus)).toEqual([]);
		expect(bus.unansweredSends("worker", 0)).toEqual([]);
	});

	it("a question to a remote peer never sustains or stops the caller's reply wait", async () => {
		const { registry, bus } = setup();
		await bus.send({ from: "worker", to: REMOTE, body: "are you there?" });
		const session = {
			cwd: process.cwd(),
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: registry,
			getAgentId: () => "worker",
		} as unknown as ToolSession;

		const result = await new WaitTool(session).execute("wait-remote", {});
		const [first] = result.content;
		const text = first?.type === "text" ? first.text : "";
		expect(text).toContain("no agent you messaged this run owes a reply");
		expect(text).not.toContain(REMOTE);
	});
});

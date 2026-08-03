/**
 * IrcBus RemoteTransport seam (murmur-l5vv): a local-registry MISS (`!ref`) hands off to an
 * installed transport instead of failing; every other failure mode (aborted / advisor /
 * no-session) stays local `failed` and never touches the transport. This is the loop-safety
 * invariant the murmur bridge relies on — only a genuine cross-process recipient leaves.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";

function recordingTransport(outcome: "injected" | "failed" = "injected"): {
	transport: RemoteTransport;
	seen: IrcMessage[];
} {
	const seen: IrcMessage[] = [];
	return {
		seen,
		transport: {
			async send(message) {
				seen.push(message);
				return { to: message.to, outcome };
			},
		},
	};
}

describe("IrcBus RemoteTransport seam", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("fires the transport on a !ref miss and returns its receipt, with the native id already minted", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "Main", to: "remote-peer", body: "how goes it", replyTo: "r1" });

		expect(receipt).toEqual({ to: "remote-peer", outcome: "injected" });
		expect(seen).toHaveLength(1);
		const msg = seen[0]!;
		expect(msg.from).toBe("Main");
		expect(msg.to).toBe("remote-peer");
		expect(msg.body).toBe("how goes it");
		expect(msg.replyTo).toBe("r1");
		// send() mints omp's native id/ts BEFORE the miss branch — the transport receives them.
		expect(typeof msg.id).toBe("string");
		expect(msg.id.length).toBeGreaterThan(0);
		expect(msg.ts).toBeGreaterThan(0);
	});

	it("does NOT fire the transport for a live local recipient (stays in-process)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		// A pending waiter satisfies delivery in-process without a session or the transport.
		const reply = bus.wait("Main", { from: "peer" }, 1000);
		const receipt = await bus.send({ from: "peer", to: "Main", body: "local hello" });

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0);
		expect((await reply)?.body).toBe("local hello");
	});

	it("does NOT fire the transport for an aborted local recipient (stays failed)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "aborted" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "peer", to: "Main", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(seen).toHaveLength(0);
	});

	it("without a transport, a !ref miss still fails with the unknown-agent error", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const receipt = await bus.send({ from: "Main", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "ghost"/);
	});

	it("setRemoteTransport(undefined) clears the seam — a miss fails again", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		bus.setRemoteTransport(recordingTransport().transport);
		bus.setRemoteTransport(undefined);

		const receipt = await bus.send({ from: "Main", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
	});

	it("routes a `remote`-kind proxy ref to the transport (murmur-q00p), not local delivery", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "beatrice", displayName: "beatrice", kind: "remote", session: null, status: "running" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi remote" });

		expect(receipt).toEqual({ to: "beatrice", outcome: "injected" });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.to).toBe("beatrice");
	});

	it("does NOT forward an `aborted` remote proxy to the transport — fails like a local aborted agent (Codex)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "beatrice", displayName: "beatrice", kind: "remote", session: null, status: "aborted" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi remote" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("aborted");
		expect(seen).toHaveLength(0);
	});

	it("surfaces a transport rejection as a failed receipt instead of throwing (Codex: no whole hub-call exception)", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		bus.setRemoteTransport({
			async send() {
				throw new Error("proxy unreachable");
			},
		});

		const receipt = await bus.send({ from: "Main", to: "remote-peer", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.to).toBe("remote-peer");
		expect(receipt.error).toContain("proxy unreachable");
	});

	it("deliverInbound rejects a `remote`-kind target and never bounces to the transport", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "beatrice", displayName: "beatrice", kind: "remote", session: null, status: "running" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(transport);

		const { receipt } = await bus.deliverInbound({ from: "peer", to: "beatrice", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(seen).toHaveLength(0);
	});

	it("deliverInbound to a live local recipient delivers in-process and never re-forwards to the transport (murmur-ffh4)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "worker",
			displayName: "worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		// A message that arrived FROM murmur (inbound) delivers to the local waiter in-process and
		// must NOT bounce back onto the bus — the inbound-never-re-forwarded invariant (contract §8).
		const reply = bus.wait("worker", { from: "alice" }, 1000);
		const { receipt } = await bus.deliverInbound({ from: "alice", to: "worker", body: "from murmur" });

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0);
		expect((await reply)?.body).toBe("from murmur");
	});

	it("the Main-UI relay of an inbound message is display-only and never re-enters the transport (murmur-ffh4 no echo loop)", async () => {
		const registry = AgentRegistry.global();
		const relayed: unknown[] = [];
		// `Main` is both the omp root and (in a bridged cluster) a murmur roster entry — the exact
		// double-membership that could loop. Its UI relay must observe cross-agent traffic display-only,
		// never re-dispatching it onto the transport.
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: { emitIrcRelayObservation: () => relayed.push(1) } as unknown as AgentSession,
			status: "running",
		});
		registry.register({
			id: "worker",
			displayName: "worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		const reply = bus.wait("worker", { from: "alice" }, 1000);
		const { receipt } = await bus.deliverInbound({ from: "alice", to: "worker", body: "hi worker" });
		await reply;

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0); // inbound never bounces outbound
		expect(relayed).toHaveLength(1); // Main got a display-only copy — the relay ran but did not re-enter delivery
	});
});

describe("AgentRegistry.listVisibleTo remote proxies (murmur-q00p)", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("includes running/idle remote proxies but excludes parked/aborted ones", () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "live-remote",
			displayName: "live-remote",
			kind: "remote",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "gone-remote",
			displayName: "gone-remote",
			kind: "remote",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "dead-remote",
			displayName: "dead-remote",
			kind: "remote",
			session: null,
			status: "aborted",
		});

		const visible = registry.listVisibleTo("Main").map(ref => ref.id);
		expect(visible).toContain("live-remote");
		expect(visible).not.toContain("gone-remote");
		expect(visible).not.toContain("dead-remote");
	});
});

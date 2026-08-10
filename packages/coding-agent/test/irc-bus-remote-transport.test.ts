/**
 * IrcBus RemoteTransport seam (murmur-l5vv): only a REGISTERED cross-process `remote` proxy ref hands
 * off to an installed transport. A bare local-registry MISS (`!ref`) fails locally with the
 * unknown-agent error even when a transport is installed, and every other failure mode (aborted /
 * advisor / no-session) stays local `failed` and never touches the transport. This is the loop-safety
 * invariant the murmur bridge relies on — only a genuine, registered cross-process recipient leaves,
 * so a transport installed by one top-level session cannot swallow another's mistyped/unknown
 * recipient in a shared-registry, multi-top-level-session host (can1357/oh-my-pi#7401 review).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";

const OWNER = "ext:test";

function recordingTransport(outcome: "injected" | "failed" = "injected"): {
	transport: RemoteTransport;
	seen: IrcMessage[];
	seenOpts: ({ expectsReply?: boolean } | undefined)[];
} {
	const seen: IrcMessage[] = [];
	const seenOpts: ({ expectsReply?: boolean } | undefined)[] = [];
	return {
		seen,
		seenOpts,
		transport: {
			async send(message, opts) {
				seen.push(message);
				seenOpts.push(opts);
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

	it("does NOT fire the transport on a bare !ref miss — fails locally even with a transport installed", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(OWNER, transport);

		// No registered `remote` ref for this id: a bare miss is a genuine unknown recipient and must
		// NOT leave the process, even though a transport is installed (multi-top-level-session leak guard).
		const receipt = await bus.send({ from: "Main", to: "remote-peer", body: "how goes it", replyTo: "r1" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "remote-peer"/);
		expect(seen).toHaveLength(0);
	});

	it("does NOT fire the transport for a live local recipient (stays in-process)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(OWNER, transport);

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
		bus.setRemoteTransport(OWNER, transport);

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

	it("setRemoteTransport(undefined) clears the seam — a registered remote proxy becomes unreachable", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(OWNER, transport);
		bus.setRemoteTransport(OWNER, undefined);

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unreachable/);
		expect(seen).toHaveLength(0);
	});

	it("routes a `remote`-kind proxy ref to the transport (murmur-q00p), with the native id already minted", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(OWNER, transport);

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi remote", replyTo: "r1" });

		expect(receipt).toEqual({ to: "beatrice", outcome: "injected" });
		expect(seen).toHaveLength(1);
		const msg = seen[0]!;
		expect(msg.to).toBe("beatrice");
		expect(msg.body).toBe("hi remote");
		expect(msg.replyTo).toBe("r1");
		// send() mints omp's native id/ts BEFORE the handoff — the transport receives them.
		expect(typeof msg.id).toBe("string");
		expect(msg.id.length).toBeGreaterThan(0);
		expect(msg.ts).toBeGreaterThan(0);
	});

	it("does NOT forward an `aborted` remote proxy to the transport — fails like a local aborted agent (Codex)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "aborted",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(OWNER, transport);

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi remote" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("aborted");
		expect(seen).toHaveLength(0);
	});

	it("forwards expectsReply to the transport on an awaited remote send (Codex)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seenOpts } = recordingTransport("injected");
		bus.setRemoteTransport(OWNER, transport);

		await bus.send({ from: "Main", to: "beatrice", body: "await me" }, { expectsReply: true });
		expect(seenOpts).toHaveLength(1);
		expect(seenOpts[0]?.expectsReply).toBe(true);

		// A non-awaited send carries no expectsReply across the seam.
		await bus.send({ from: "Main", to: "beatrice", body: "fire and forget" });
		expect(seenOpts[1]?.expectsReply).toBeUndefined();
	});

	it("a wait for an idle remote peer is NOT aborted by the liveness gate (band-aid; can1357/oh-my-pi#7503)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "idle",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);

		// An idle remote is alive and can deliver inbound → the wait must block (not abort), then resolve.
		const waitP = bus.wait("Main", { from: "beatrice" }, 5000, undefined, {
			liveness: { registry, senderId: "Main" },
		});
		await bus.deliverInbound({ from: "beatrice", to: "Main", body: "hi from remote" });
		const msg = await waitP;
		expect(msg?.from).toBe("beatrice");
		expect(msg?.body).toBe("hi from remote");
	});

	it("surfaces a transport rejection as a failed receipt instead of throwing (Codex: no whole hub-call exception)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(OWNER, {
			async send() {
				throw new Error("proxy unreachable");
			},
		});

		const receipt = await bus.send({ from: "Main", to: "beatrice", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.to).toBe("beatrice");
		expect(receipt.error).toContain("proxy unreachable");
	});

	it("deliverInbound rejects a `remote`-kind target and never bounces to the transport", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(OWNER, transport);

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
		bus.setRemoteTransport(OWNER, transport);

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
		bus.setRemoteTransport(OWNER, transport);

		const reply = bus.wait("worker", { from: "alice" }, 1000);
		const { receipt } = await bus.deliverInbound({ from: "alice", to: "worker", body: "hi worker" });
		await reply;

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0); // inbound never bounces outbound
		expect(relayed).toHaveLength(1); // Main got a display-only copy — the relay ran but did not re-enter delivery
	});

	it("relays a successful non-Main outbound remote send to the Main UI (symmetric with local + inbound)", async () => {
		const registry = AgentRegistry.global();
		const relayed: unknown[] = [];
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: { emitIrcRelayObservation: () => relayed.push(1) } as unknown as AgentSession,
			status: "running",
		});
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(OWNER, recordingTransport("injected").transport);

		// A subagent → remote send is mirrored to the root UI (neither endpoint is Main) — otherwise the
		// root sees replies from remote peers but not the outbound messages that prompted them.
		await bus.send({ from: "worker", to: "beatrice", body: "outbound to remote" });
		expect(relayed).toHaveLength(1);

		// A Main → remote send is NOT relayed (Main already rendered its own outbound send).
		await bus.send({ from: "Main", to: "beatrice", body: "from main" });
		expect(relayed).toHaveLength(1);

		// suppressRelay skips the relay leg (broadcast dedup).
		await bus.send({ from: "worker", to: "beatrice", body: "dup" }, { suppressRelay: true });
		expect(relayed).toHaveLength(1);
	});

	it("does not relay a failed outbound remote send", async () => {
		const registry = AgentRegistry.global();
		const relayed: unknown[] = [];
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: { emitIrcRelayObservation: () => relayed.push(1) } as unknown as AgentSession,
			status: "running",
		});
		registry.register({
			id: "beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(OWNER, recordingTransport("failed").transport);

		const receipt = await bus.send({ from: "worker", to: "beatrice", body: "will fail" });
		expect(receipt.outcome).toBe("failed");
		expect(relayed).toHaveLength(0);
	});

	it("routes each remote proxy through ITS OWNER's transport, not another owner's (Codex)", async () => {
		const registry = AgentRegistry.global();
		// Two bridges to different rosters coexist in one process.
		registry.register({
			id: "alice",
			displayName: "alice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: "ext-a",
		});
		registry.register({
			id: "bob",
			displayName: "bob",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: "ext-b",
		});
		const bus = new IrcBus(registry);
		const seenA: string[] = [];
		const seenB: string[] = [];
		bus.setRemoteTransport("ext-a", {
			async send(m) {
				seenA.push(m.to);
				return { to: m.to, outcome: "injected" };
			},
		});
		bus.setRemoteTransport("ext-b", {
			async send(m) {
				seenB.push(m.to);
				return { to: m.to, outcome: "injected" };
			},
		});

		await bus.send({ from: "Main", to: "alice", body: "to A's roster" });
		await bus.send({ from: "Main", to: "bob", body: "to B's roster" });
		expect(seenA).toEqual(["alice"]);
		expect(seenB).toEqual(["bob"]);

		// Clearing one owner's transport leaves the other's intact.
		bus.setRemoteTransport("ext-a", undefined);
		const receipt = await bus.send({ from: "Main", to: "alice", body: "now unreachable" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unreachable/);
		expect((await bus.send({ from: "Main", to: "bob", body: "still ok" })).outcome).toBe("injected");
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

/**
 * IrcBus RemoteTransport seam (murmur-awiv): routing is PREFIX-AUTHORITATIVE. A recipient of the form
 * `@<namespace>/<name>` is unambiguously remote and routes to that namespace's transport — a
 * registered proxy ref is optional (reach-by-name). A bare (non-namespaced) id is local: a miss fails
 * with the unknown-agent error even when a transport is installed, so a mistyped local id never leaks
 * to the mesh. Namespaces are globally unique (claimed by the installing extension load's ownerToken);
 * a second load claiming an owned namespace throws. `opts.toName` hands the transport the bare mesh
 * name so it never parses ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	composeRemoteId,
	IrcBus,
	isValidRemoteName,
	isValidRemoteNamespace,
	type RemoteTransport,
	remoteNameOf,
	remoteNamespaceOf,
} from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";

/** An extension load's owner token (opaque; NOT a namespace — may contain any characters). */
const OWNER = "ext:test";
/** A globally-unique namespace this load claims (the `@cluster-a/` routing prefix). */
const NS = "cluster-a";

function recordingTransport(outcome: "injected" | "failed" = "injected"): {
	transport: RemoteTransport;
	seen: IrcMessage[];
	seenOpts: ({ expectsReply?: boolean; toName?: string } | undefined)[];
} {
	const seen: IrcMessage[] = [];
	const seenOpts: ({ expectsReply?: boolean; toName?: string } | undefined)[] = [];
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

	it("does NOT fire the transport for a bare (non-namespaced) recipient — fails locally even with a transport installed", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);

		// A bare id has no `@ns/` prefix, so it is local: a miss is a genuine unknown recipient and must
		// NOT leave the process even with a transport installed (a mistyped local id never leaks out).
		const receipt = await bus.send({ from: "Main", to: "remote-peer", body: "how goes it", replyTo: "r1" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "remote-peer"/);
		expect(seen).toHaveLength(0);
	});

	it("rejects a malformed reach-by-name recipient locally — never hands a bad name to the transport", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);
		// Names the @ns/name contract forbids: empty, whitespace, or an extra "/".
		for (const bad of [`@${NS}/`, `@${NS}/a b`, `@${NS}/a/b`]) {
			const receipt = await bus.send({ from: "Main", to: bad, body: "hi" });
			expect(receipt.outcome).toBe("failed");
			expect(receipt.error).toMatch(/Invalid remote recipient/);
		}
		// A well-formed reach-by-name recipient still routes — only it reaches the transport.
		const ok = await bus.send({ from: "Main", to: composeRemoteId(NS, "alice"), body: "hi" });
		expect(ok.outcome).toBe("injected");
		expect(seen.map(m => m.to)).toEqual([`@${NS}/alice`]);
	});

	it("does NOT fire the transport for a live local recipient (stays in-process)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(NS, transport, OWNER);

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
		bus.setRemoteTransport(NS, transport, OWNER);

		const receipt = await bus.send({ from: "peer", to: "Main", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(seen).toHaveLength(0);
	});

	it("without a transport, a bare miss still fails with the unknown-agent error", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const receipt = await bus.send({ from: "Main", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "ghost"/);
	});

	it("routes an @ns/name recipient to its namespace transport even with NO registered ref (reach-by-name)", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen, seenOpts } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);

		// No registered proxy ref for `@cluster-a/beatrice`: prefix routing still hands it to the
		// namespace's transport (registration is discovery-only, not required for routing).
		const receipt = await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "hi remote", replyTo: "r1" });

		expect(receipt).toEqual({ to: "@cluster-a/beatrice", outcome: "injected" });
		expect(seen).toHaveLength(1);
		const msg = seen[0]!;
		expect(msg.to).toBe("@cluster-a/beatrice"); // full id preserved for logging / correlation
		expect(msg.body).toBe("hi remote");
		expect(msg.replyTo).toBe("r1");
		expect(seenOpts[0]?.toName).toBe("beatrice"); // bare mesh name handed to the transport
		// send() mints omp's native id/ts BEFORE the handoff — the transport receives them.
		expect(typeof msg.id).toBe("string");
		expect(msg.id.length).toBeGreaterThan(0);
		expect(msg.ts).toBeGreaterThan(0);
	});

	it("clearing a namespace transport makes @ns/* unreachable but KEEPS the claim (reconnect-friendly)", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(NS, transport, OWNER);
		bus.setRemoteTransport(NS, undefined, OWNER); // clear ROUTING only

		const receipt = await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unreachable/);
		expect(seen).toHaveLength(0);

		// The claim survives a clear: a DIFFERENT owner still cannot take the namespace...
		expect(() => bus.setRemoteTransport(NS, transport, "other-owner")).toThrow(/already claimed/);
		// ...but the owner can reinstall (reconnect) and routing resumes.
		bus.setRemoteTransport(NS, transport, OWNER);
		expect((await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "again" })).outcome).toBe("injected");
	});

	it("rejects clearing a namespace that was never claimed (no phantom claim from clear-before-install)", () => {
		const bus = new IrcBus(AgentRegistry.global());
		// A clear (undefined) before any install must throw, not silently no-op: otherwise the ExtensionAPI
		// marks the namespace claimed while the bus records no owner, letting a later load claim it and
		// steal this load's @ns/* routing (PR #7401 codex, bus.ts:174).
		expect(() => bus.setRemoteTransport(NS, undefined, OWNER)).toThrow(/not claimed/);
		// The namespace stays free — a different owner can still claim it cleanly afterwards.
		expect(bus.hasRemoteTransport()).toBe(false);
		expect(() => bus.setRemoteTransport(NS, recordingTransport().transport, "other-owner")).not.toThrow();
	});

	it("does NOT forward to an `aborted` remote proxy ref — fails like a local aborted agent (honors the tombstone)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "@cluster-a/beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "aborted",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);

		const receipt = await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "hi remote" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("aborted");
		expect(seen).toHaveLength(0);
	});

	it("forwards expectsReply (and toName) to the transport on an awaited remote send", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seenOpts } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);

		await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "await me" }, { expectsReply: true });
		expect(seenOpts).toHaveLength(1);
		expect(seenOpts[0]?.expectsReply).toBe(true);
		expect(seenOpts[0]?.toName).toBe("beatrice");

		// A non-awaited send carries no expectsReply across the seam.
		await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "fire and forget" });
		expect(seenOpts[1]?.expectsReply).toBeUndefined();
	});

	it("a wait for an idle remote peer is NOT aborted by the liveness gate (band-aid; can1357/oh-my-pi#7503)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "@cluster-a/beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "idle",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);

		// An idle remote is alive and can deliver inbound → the wait must block (not abort), then resolve.
		const waitP = bus.wait("Main", { from: "@cluster-a/beatrice" }, 5000, undefined, {
			liveness: { registry, senderId: "Main" },
		});
		await bus.deliverInbound({ from: "@cluster-a/beatrice", to: "Main", body: "hi from remote" });
		const msg = await waitP;
		expect(msg?.from).toBe("@cluster-a/beatrice");
		expect(msg?.body).toBe("hi from remote");
	});

	it("surfaces a transport rejection as a failed receipt instead of throwing (no whole hub-call exception)", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		bus.setRemoteTransport(
			NS,
			{
				async send() {
					throw new Error("proxy unreachable");
				},
			},
			OWNER,
		);

		const receipt = await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.to).toBe("@cluster-a/beatrice");
		expect(receipt.error).toContain("proxy unreachable");
	});

	it("deliverInbound rejects a remote-kind target and never bounces to the transport", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "@cluster-a/beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(NS, transport, OWNER);

		const { receipt } = await bus.deliverInbound({ from: "@cluster-a/alice", to: "@cluster-a/beatrice", body: "hi" });

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
		bus.setRemoteTransport(NS, transport, OWNER);

		// A message that arrived FROM the mesh (inbound) delivers to the local waiter in-process and
		// must NOT bounce back onto the bus — the inbound-never-re-forwarded invariant (contract §8).
		const reply = bus.wait("worker", { from: "@cluster-a/alice" }, 1000);
		const { receipt } = await bus.deliverInbound({ from: "@cluster-a/alice", to: "worker", body: "from murmur" });

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0);
		expect((await reply)?.body).toBe("from murmur");
	});

	it("the Main-UI relay of an inbound message is display-only and never re-enters the transport (murmur-ffh4 no echo loop)", async () => {
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
			id: "worker",
			displayName: "worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(NS, transport, OWNER);

		const reply = bus.wait("worker", { from: "@cluster-a/alice" }, 1000);
		const { receipt } = await bus.deliverInbound({ from: "@cluster-a/alice", to: "worker", body: "hi worker" });
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
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(NS, recordingTransport("injected").transport, OWNER);

		// A subagent → remote send is mirrored to the root UI (neither endpoint is Main) — otherwise the
		// root sees replies from remote peers but not the outbound messages that prompted them.
		await bus.send({ from: "worker", to: "@cluster-a/beatrice", body: "outbound to remote" });
		expect(relayed).toHaveLength(1);

		// A Main → remote send is NOT relayed (Main already rendered its own outbound send).
		await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "from main" });
		expect(relayed).toHaveLength(1);

		// suppressRelay skips the relay leg (broadcast dedup).
		await bus.send({ from: "worker", to: "@cluster-a/beatrice", body: "dup" }, { suppressRelay: true });
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
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(NS, recordingTransport("failed").transport, OWNER);

		const receipt = await bus.send({ from: "worker", to: "@cluster-a/beatrice", body: "will fail" });
		expect(receipt.outcome).toBe("failed");
		expect(relayed).toHaveLength(0);
	});

	it("routes each recipient through ITS namespace's transport; clearing one leaves the others intact", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		// Two bridges to different clusters coexist in one process, each with its own namespace.
		const seenA: string[] = [];
		const seenB: string[] = [];
		bus.setRemoteTransport(
			"cluster-a",
			{
				async send(m, o) {
					seenA.push(o?.toName ?? m.to);
					return { to: m.to, outcome: "injected" };
				},
			},
			"ext-a",
		);
		bus.setRemoteTransport(
			"cluster-b",
			{
				async send(m, o) {
					seenB.push(o?.toName ?? m.to);
					return { to: m.to, outcome: "injected" };
				},
			},
			"ext-b",
		);

		await bus.send({ from: "Main", to: "@cluster-a/alice", body: "to A's cluster" });
		await bus.send({ from: "Main", to: "@cluster-b/bob", body: "to B's cluster" });
		expect(seenA).toEqual(["alice"]);
		expect(seenB).toEqual(["bob"]);

		// Clearing one namespace's transport leaves the other's intact.
		bus.setRemoteTransport("cluster-a", undefined, "ext-a");
		const receipt = await bus.send({ from: "Main", to: "@cluster-a/alice", body: "now unreachable" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unreachable/);
		expect((await bus.send({ from: "Main", to: "@cluster-b/bob", body: "still ok" })).outcome).toBe("injected");
	});

	it("rejects a second extension load claiming an already-owned namespace (global uniqueness)", () => {
		const bus = new IrcBus(AgentRegistry.global());
		const t = recordingTransport().transport;
		bus.setRemoteTransport("cluster-a", t, "ext-a");
		// A different owner claiming the same namespace clashes.
		expect(() => bus.setRemoteTransport("cluster-a", t, "ext-b")).toThrow(/already claimed/);
		// The same owner may re-set (update / reinstall) freely.
		expect(() => bus.setRemoteTransport("cluster-a", t, "ext-a")).not.toThrow();
	});

	it("releaseTransportsForOwner drops the claim so the namespace can be re-claimed by another load", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const t = recordingTransport().transport;
		bus.setRemoteTransport("cluster-a", t, "ext-a");
		bus.releaseTransportsForOwner("ext-a");
		expect(bus.hasRemoteTransport()).toBe(false);

		// Freed: a different owner can now claim it, and it routes via the new transport.
		expect(() => bus.setRemoteTransport("cluster-a", t, "ext-b")).not.toThrow();
		expect((await bus.send({ from: "Main", to: "@cluster-a/x", body: "hi" })).outcome).toBe("injected");
	});

	it("clearing a namespace transport leaves its registered peers listed (T7 reconnect roster)", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "@cluster-a/beatrice",
			displayName: "beatrice",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: OWNER,
		});
		const bus = new IrcBus(registry);
		bus.setRemoteTransport(NS, recordingTransport().transport, OWNER);
		bus.setRemoteTransport(NS, undefined, OWNER); // clear routing (claim + roster retained)

		// The registered peer survives the clear — still in the registry and the hub roster...
		expect(registry.get("@cluster-a/beatrice")?.kind).toBe("remote");
		expect(registry.listVisibleTo("Main").map(ref => ref.id)).toContain("@cluster-a/beatrice");
		// ...but a send to it now fails unreachable (no transport until the owner reinstalls).
		const receipt = await bus.send({ from: "Main", to: "@cluster-a/beatrice", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unreachable/);
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
			id: "@cluster-a/live-remote",
			displayName: "live-remote",
			kind: "remote",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "@cluster-a/gone-remote",
			displayName: "gone-remote",
			kind: "remote",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "@cluster-a/dead-remote",
			displayName: "dead-remote",
			kind: "remote",
			session: null,
			status: "aborted",
		});

		const visible = registry.listVisibleTo("Main").map(ref => ref.id);
		expect(visible).toContain("@cluster-a/live-remote");
		expect(visible).not.toContain("@cluster-a/gone-remote");
		expect(visible).not.toContain("@cluster-a/dead-remote");
	});
});

describe("remote id helpers (murmur-167o)", () => {
	it("composes and round-trips @ns/name", () => {
		const id = composeRemoteId("cluster-a", "ariel.scout");
		expect(id).toBe("@cluster-a/ariel.scout");
		expect(remoteNamespaceOf(id)).toBe("cluster-a");
		expect(remoteNameOf(id)).toBe("ariel.scout");
	});

	it("treats a bare (non-@) or malformed id as local", () => {
		expect(remoteNamespaceOf("Main")).toBeUndefined();
		expect(remoteNamespaceOf("Main.Scout")).toBeUndefined();
		expect(remoteNameOf("Main")).toBeUndefined();
		// A lone `@`, an empty namespace, or a namespace with no `/` is not a well-formed remote id.
		expect(remoteNamespaceOf("@")).toBeUndefined();
		expect(remoteNamespaceOf("@/x")).toBeUndefined();
		expect(remoteNamespaceOf("@ns")).toBeUndefined();
	});

	it("validates namespace + name charset and rejects invalid compositions", () => {
		expect(isValidRemoteNamespace("cluster-a.1_b")).toBe(true);
		expect(isValidRemoteNamespace("bad ns")).toBe(false);
		expect(isValidRemoteNamespace("bad/ns")).toBe(false);
		expect(isValidRemoteNamespace("")).toBe(false);
		expect(isValidRemoteName("ariel.scout")).toBe(true);
		expect(isValidRemoteName("a/b")).toBe(false);
		expect(isValidRemoteName("has space")).toBe(false);
		expect(() => composeRemoteId("bad ns", "x")).toThrow(/namespace/);
		expect(() => composeRemoteId("cluster-a", "a/b")).toThrow(/name/);
	});

	it("rejects namespaces over 64 chars and names over 128 chars", () => {
		// Boundary: a max-length id is accepted, one char over is rejected — so a bridge cannot bloat
		// every subagent prompt / `hub list` with an unbounded @ns/name (displayName is separately
		// capped). Murmur wire slugs are <=40 chars/segment, so these bound abuse without rejecting a
		// realistic dotted id (#7401 review).
		const ns64 = "a".repeat(64);
		const name128 = "a".repeat(128);
		expect(isValidRemoteNamespace(ns64)).toBe(true);
		expect(isValidRemoteNamespace(`${ns64}a`)).toBe(false);
		expect(isValidRemoteName(name128)).toBe(true);
		expect(isValidRemoteName(`${name128}a`)).toBe(false);
		expect(composeRemoteId(ns64, name128)).toBe(`@${ns64}/${name128}`);
		expect(() => composeRemoteId(`${ns64}a`, "x")).toThrow(/namespace/);
		expect(() => composeRemoteId("cluster-a", `${name128}a`)).toThrow(/name/);
	});
});

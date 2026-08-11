/**
 * IrcBus.forRegistry — one bus per AgentRegistry (Option B, murmur-up8k).
 *
 * A session with a custom (non-global) AgentRegistry gets its own bus, so its peers, waiters,
 * mailboxes, and transports are isolated by construction from the global bus and from any other
 * session registry. The delivery core is unchanged — each bus resolves recipients in its own registry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("IrcBus.forRegistry (per-registry isolation)", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("memoizes one bus per registry; global() is the global registry's bus", () => {
		const a = new AgentRegistry();
		const b = new AgentRegistry();
		expect(IrcBus.forRegistry(a)).toBe(IrcBus.forRegistry(a)); // same registry -> same bus
		expect(IrcBus.forRegistry(a)).not.toBe(IrcBus.forRegistry(b)); // distinct registries -> distinct buses
		expect(IrcBus.global()).toBe(IrcBus.forRegistry(AgentRegistry.global()));
	});

	it("delivers inbound into the addressed registry only", async () => {
		const a = new AgentRegistry();
		const b = new AgentRegistry();
		a.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		// A's bus resolves "Main" (its waiter consumes the message).
		const waitA = IrcBus.forRegistry(a).wait("Main", { from: "peer" }, 1000);
		const inA = await IrcBus.forRegistry(a).deliverInbound({ from: "peer", to: "Main", body: "hi-a" });
		expect(inA.receipt.outcome).not.toBe("failed");
		expect((await waitA)?.body).toBe("hi-a");
		// B never registered "Main" — the same address misses; registries share no refs.
		const inB = await IrcBus.forRegistry(b).deliverInbound({ from: "peer", to: "Main", body: "hi-b" });
		expect(inB.receipt.outcome).toBe("failed");
		expect(inB.receipt.error).toMatch(/Unknown agent "Main"/);
	});

	it("routes a namespaced send only on the registry that installed the transport", async () => {
		const a = new AgentRegistry();
		const b = new AgentRegistry();
		let seenOnA = false;
		const transport: RemoteTransport = {
			async send(message) {
				seenOnA = true;
				return { to: message.to, outcome: "injected" };
			},
		};
		IrcBus.forRegistry(a).setRemoteTransport("cluster-x", transport, "owner-a");
		expect(IrcBus.forRegistry(a).hasRemoteTransport()).toBe(true);
		expect(IrcBus.forRegistry(b).hasRemoteTransport()).toBe(false);
		// B has no cluster-x transport, so an @cluster-x/* send fails locally and never touches A's.
		const bReceipt = await IrcBus.forRegistry(b).send({ from: "Main", to: "@cluster-x/peer", body: "x" });
		expect(bReceipt.outcome).toBe("failed");
		expect(seenOnA).toBe(false);
	});
});

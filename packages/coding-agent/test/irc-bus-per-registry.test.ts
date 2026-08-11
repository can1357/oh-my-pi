/**
 * IrcBus.forRegistry — one bus per AgentRegistry (Option B, murmur-up8k).
 *
 * A session with a custom (non-global) AgentRegistry gets its own bus, so its peers, waiters,
 * mailboxes, and transports are isolated by construction from the global bus and from any other
 * session registry. The delivery core is unchanged — each bus resolves recipients in its own registry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
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
		const waitA = IrcBus.forRegistry(a).wait("Main", { from: "@cluster/peer" }, 1000);
		const inA = await IrcBus.forRegistry(a).deliverInbound({ from: "@cluster/peer", to: "Main", body: "hi-a" });
		expect(inA.receipt.outcome).not.toBe("failed");
		expect((await waitA)?.body).toBe("hi-a");
		// B never registered "Main" — the same address misses; registries share no refs.
		const inB = await IrcBus.forRegistry(b).deliverInbound({ from: "@cluster/peer", to: "Main", body: "hi-b" });
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

describe("AgentLifecycleManager.forRegistry (per-registry isolation)", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("memoizes one manager per registry; global() is the global registry's manager", () => {
		const a = new AgentRegistry();
		const b = new AgentRegistry();
		expect(AgentLifecycleManager.forRegistry(a)).toBe(AgentLifecycleManager.forRegistry(a)); // same registry -> same manager
		expect(AgentLifecycleManager.forRegistry(a)).not.toBe(AgentLifecycleManager.forRegistry(b)); // distinct -> distinct
		expect(AgentLifecycleManager.global()).toBe(AgentLifecycleManager.forRegistry(AgentRegistry.global()));
	});

	it("adopts a finished keep-alive subagent into its own registry, never the global one", () => {
		// The bug (PR #7401 codex): finalizeSubagentLifecycle resolved the ref via
		// AgentRegistry.global(), so a custom-registry subagent's completion missed its ref and
		// disposed the session instead of adopting it — the custom-registry hub lost finished
		// keep-alive subagents. Now each registry's manager owns only its own refs.
		const custom = new AgentRegistry();
		custom.register({ id: "Kid", displayName: "Kid", kind: "sub", session: null, status: "idle" });
		AgentLifecycleManager.forRegistry(custom).adopt("Kid", { idleTtlMs: 0 });
		expect(AgentLifecycleManager.forRegistry(custom).has("Kid")).toBe(true);
		expect(AgentLifecycleManager.global().has("Kid")).toBe(false);
	});
});

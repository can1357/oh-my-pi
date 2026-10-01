/**
 * IrcBus.deliverInbound (murmur-4e7n): the local-only inbound entry the murmur bridge uses.
 * Same in-process delivery core as send(), but a local-registry miss returns `failed` and
 * NEVER consults the remote transport (no bounce back onto the bus — contract §8). Returns
 * omp's freshly-minted native id for correlation with the murmur msgId.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

describe("IrcBus.deliverInbound", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("delivers to a live local recipient and returns the native id it minted", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);

		const reply = bus.wait("Main", { from: "peer" }, 1000);
		const { receipt, id } = await bus.deliverInbound({ from: "peer", to: "Main", body: "inbound hi" });

		expect(receipt.outcome).toBe("injected");
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
		const delivered = await reply;
		expect(delivered?.body).toBe("inbound hi");
		// The message handed to the recipient carries exactly the id we returned to the bridge.
		expect(delivered?.id).toBe(id);
	});

	it("a !ref miss returns failed", async () => {
		const bus = new IrcBus(AgentRegistry.global());

		const { receipt, id } = await bus.deliverInbound({ from: "remote", to: "ghost", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(typeof id).toBe("string");
	});

	it("an aborted local recipient fails", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "aborted" });
		const bus = new IrcBus(registry);

		const { receipt } = await bus.deliverInbound({ from: "peer", to: "Main", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
	});

	it("mints a distinct native id per delivery", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);

		bus.wait("Main", { from: "a" }, 1000);
		bus.wait("Main", { from: "b" }, 1000);
		const r1 = await bus.deliverInbound({ from: "a", to: "Main", body: "1" });
		const r2 = await bus.deliverInbound({ from: "b", to: "Main", body: "2" });

		expect(r1.id).not.toBe(r2.id);
	});
});

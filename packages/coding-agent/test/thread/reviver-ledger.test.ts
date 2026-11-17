import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Load the session layer first: it closes the services import cycle in the order the app uses.
import "../../src/session/agent-session";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { MainThreadLink } from "../../src/thread/protocol";
import type { WorkerPeer } from "../../src/thread/services";
import { MainSessionBridge } from "../../src/thread/services/agents";

const link: Partial<MainThreadLink> = {};

function makeBridge(): MainSessionBridge {
	// The ledger never touches the link; only threadId/retain are read.
	const peer = { threadId: "w1", link, retain: () => () => {} } satisfies Omit<WorkerPeer, "link"> & {
		link: Partial<MainThreadLink>;
	};
	return new MainSessionBridge(peer as unknown as WorkerPeer);
}

describe("MainSessionBridge reviver ledger", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("drops a worker reviver when its adoption ends (release, re-adopt, removal, forget)", async () => {
		const registry = AgentRegistry.global();
		const lifecycle = new AgentLifecycleManager(registry);
		const bridge = makeBridge();
		const register = (id: string) =>
			registry.register({ id, displayName: "task", kind: "sub", session: null, sessionFile: null, status: "idle" });
		const adopt = (id: string) => {
			const opts = bridge.adopted(lifecycle, id, {
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("not revived in this test");
				},
			});
			lifecycle.adopt(id, opts);
			return opts;
		};

		for (let i = 0; i < 50; i++) {
			const id = `Run${i}-Sub`;
			register(id);
			adopt(id);
			adopt(id); // re-adopt replaces the prior reviver
			expect(bridge.reviverCount).toBe(1);
			await lifecycle.release(id);
			expect(bridge.reviverCount).toBe(0);
		}

		register("Removed-Sub");
		adopt("Removed-Sub");
		registry.unregister("Removed-Sub");
		expect(bridge.reviverCount).toBe(0);

		register("Forgot-Sub");
		const opts = adopt("Forgot-Sub");
		if (!opts.revive) throw new Error("expected a reviver");
		expect(lifecycle.forgetReviver("Forgot-Sub", opts.revive)).toBe(true);
		expect(bridge.reviverCount).toBe(0);

		adopt("Unknown-Sub"); // refused adoption
		expect(bridge.reviverCount).toBe(0);
		await lifecycle.dispose();
	});
});

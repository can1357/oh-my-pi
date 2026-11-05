/**
 * A worker reaches main's registry and awaits table over RPC proxies. A
 * subscription that fails there must leave nothing behind on either side:
 * otherwise the next caller's successful subscription revives the failed
 * call's listener, which takes holds for a call that already ended and
 * refuses the child's idle wait.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
// Loads the cyclic service graph before the isolated service imports below.
import "../../src/session/agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { AwaitsProxyProbe, AwaitsProxyProbeGlobals } from "../fixtures/awaits-proxy-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});
/**
 * Poll a condition fed by another thread. There is no in-process clock to fake
 * across a real worker; this waits on the condition itself, never a guessed
 * duration.
 */
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

async function startWorker(): Promise<AwaitsProxyProbe> {
	const probe = Promise.withResolvers<AwaitsProxyProbe>();
	const probeService: ThreadService = {
		name: "awaits-proxy-probe",
		globals: (): AwaitsProxyProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/awaits-proxy-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return await probe.promise;
}

it("revives no hold of a worker call whose registry subscription failed", async () => {
	const registry = AgentRegistry.global();
	for (const id of ["Main", "Child"] as const) {
		registry.register({
			id,
			displayName: id,
			kind: id === "Main" ? "main" : "sub",
			...(id === "Child" ? { parentId: "Main" } : {}),
			session: { isStreaming: true } as never,
			status: "running",
		});
	}
	const probe = await startWorker();
	cleanups.push(() => probe.close());
	await probe.startJob();

	const realOnChange = registry.onChange.bind(registry);
	registry.onChange = () => {
		throw new Error("injected registry subscription setup failure");
	};
	let acquired: { error: string; waiters: string[] };
	try {
		acquired = await probe.acquire();
	} finally {
		registry.onChange = realOnChange;
	}
	expect(acquired.error).toContain("injected registry subscription setup failure");
	expect(acquired.waiters).toEqual([]);

	// Anyone's later subscription must not revive the failed call's listener.
	await probe.subscribeAgain();
	registry.register({
		id: "Unrelated",
		displayName: "Unrelated",
		kind: "sub",
		session: { isStreaming: true } as never,
		status: "running",
	});

	expect(await probe.waiters()).toEqual([]);
	// The child is free to idle: nothing is waiting on its result.
	expect(await probe.childIdleText()).toContain("Deadline reached");
}, 120_000);

it("refuses within a tick when the forwarded awaits subscription was dropped", async () => {
	// Main ends a forwarded subscription after a single failed delivery
	// (`MainSessionBridge.forward`), and the worker never hears that a block
	// started. The parked idle wait must still notice, from its own re-read,
	// rather than park on for its whole deadline while an agent waits on it.
	const registry = AgentRegistry.global();
	for (const id of ["Main", "Child"] as const) {
		registry.register({
			id,
			displayName: id,
			kind: id === "Main" ? "main" : "sub",
			...(id === "Child" ? { parentId: "Main" } : {}),
			session: { isStreaming: true } as never,
			status: "running",
		});
	}
	// Capture the release main hands its forwarding wrapper, so the test can
	// drop the subscription exactly as a failed delivery does.
	const realOnChange = registry.awaits.onChange.bind(registry.awaits);
	const forwarded: Array<() => void> = [];
	vi.spyOn(registry.awaits, "onChange").mockImplementation(listener => {
		const detach = realOnChange(listener);
		forwarded.push(detach);
		return detach;
	});
	const probe = await startWorker();
	cleanups.push(() => probe.close());

	const parked = probe.childIdleText(30);
	await waitFor(() => forwarded.length > 0);
	// Main drops the worker's forwarded subscription: no change event can reach
	// the worker from here on.
	for (const detach of forwarded.splice(0)) detach();
	vi.restoreAllMocks();

	const started = Date.now();
	const release = registry.awaits.hold("Main", ["Child"], { interruptible: false });
	cleanups.push(() => release());
	const text = await parked;

	expect(text).toContain("Nothing to wait for: `Main` is waiting on your result");
	// Bounded by the re-read tick, not by the caller's 30 s deadline.
	expect(Date.now() - started).toBeLessThan(10_000);
}, 120_000);

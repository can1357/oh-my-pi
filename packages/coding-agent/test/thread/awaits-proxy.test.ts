/**
 * A worker reaches main's registry and awaits table over RPC proxies. A
 * subscription that fails there must leave nothing behind on either side:
 * otherwise the next caller's successful subscription revives the failed
 * call's listener, which takes holds for a call that already ended and
 * refuses the child's idle wait.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
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

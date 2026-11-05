/**
 * A worker reaches main's registry and awaits table over RPC proxies. A
 * subscription that fails there must leave nothing behind on either side:
 * otherwise the next caller's successful subscription revives the failed
 * call's listener, which takes holds for a call that already ended and
 * refuses the child's idle wait.
 */
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
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
import { canonicalProjectDir } from "../../src/launch/paths";
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
	// An RPC round trip to the worker: the reply can only be served after the
	// idle block's own setup ran, so its first `waitersOn` read is already
	// behind us. Without this barrier the hold below can land before that
	// read and be found by it, which refuses with no re-read at all.
	await probe.waiters();
	// Main drops the worker's forwarded subscription: no change event can reach
	// the worker from here on.
	for (const detach of forwarded.splice(0)) detach();
	vi.restoreAllMocks();

	const started = Date.now();
	const release = registry.awaits.hold("Main", ["Child"], { interruptible: false });
	cleanups.push(() => release());
	const text = await parked;

	expect(text).toContain("Nothing to wait for: `Main` is waiting on your result");
	// Bounded by the one-second re-read tick, not by the caller's 30 s
	// deadline: before the tick existed this returned at 30 s.
	expect(Date.now() - started).toBeLessThan(5_000);
}, 120_000);

it("refuses within a tick when the block starts while the broker refresh hangs", async () => {
	// The same lost notification, but landing while the wait's owned-service
	// refresh is still outstanding: the broker token read blocks on a FIFO with
	// no writer, so the refresh cannot finish on its own. The re-read has to
	// cover that race too, or the call leaves `Main` blocked for its whole
	// deadline.
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "awaits-broker-"));
	cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
	const runtimeDir = getDaemonRuntimeDir(await canonicalProjectDir(cwd));
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const token = path.join(runtimeDir, "broker.token");
	expect(Bun.spawnSync(["mkfifo", token]).exitCode).toBe(0);

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
	const realOnChange = registry.awaits.onChange.bind(registry.awaits);
	const forwarded: Array<() => void> = [];
	vi.spyOn(registry.awaits, "onChange").mockImplementation(listener => {
		const detach = realOnChange(listener);
		forwarded.push(detach);
		return detach;
	});
	const probe = await startWorker();
	cleanups.push(() => probe.close());
	// Release the token read before the probe is closed, however this test
	// ends: the non-blocking open fails outright if the read is already gone,
	// and otherwise hands the abandoned reader its bytes so nothing in the
	// worker is left blocked on a FIFO that is about to be removed.
	cleanups.push(async () => {
		try {
			const handle = await fs.open(token, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
			await handle.writeFile("0".repeat(32), "utf8");
			await handle.close();
		} catch {
			// No reader left: nothing to release.
		}
		await fs.rm(token, { force: true });
	});

	let settled = false;
	const parked = probe.childIdleTextWithBroker(cwd, 30).then(text => {
		settled = true;
		return text;
	});
	// The refresh subscribes before it races the broker, so a forwarded
	// subscription proves the token read is already outstanding.
	await waitFor(() => forwarded.length > 0);
	for (const detach of forwarded.splice(0)) detach();
	vi.restoreAllMocks();

	const started = Date.now();
	const release = registry.awaits.hold("Main", ["Child"], { interruptible: false });
	cleanups.push(() => release());
	const text = await parked;
	const elapsedMs = Date.now() - started;

	expect(text).toContain("Nothing to wait for: `Main` is waiting on your result");
	// The refresh is still hanging on the FIFO; only the re-read can have ended
	// this. Before it covered the refresh, the call returned at its 30 s deadline.
	expect(elapsedMs).toBeLessThan(5_000);
	expect(settled).toBe(true);
}, 120_000);

it("leaves no refresh tick behind when the proxy awaits subscription rejects", async () => {
	// The refresh takes its re-read tick before it subscribes, and a worker's
	// subscription is an RPC request that main can reject. A rejection must
	// release the tick with everything else: otherwise an ended call goes on
	// reading main's awaits table once a second until the worker exits.
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "awaits-setup-"));
	cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
	const runtimeDir = getDaemonRuntimeDir(await canonicalProjectDir(cwd));
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const token = path.join(runtimeDir, "broker.token");
	expect(Bun.spawnSync(["mkfifo", token]).exitCode).toBe(0);

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
	cleanups.push(async () => {
		try {
			const handle = await fs.open(token, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
			await handle.writeFile("0".repeat(32), "utf8");
			await handle.close();
		} catch {
			// No reader left: nothing to release.
		}
		await fs.rm(token, { force: true });
	});

	// Count the reads the worker's tick would make, over the real link.
	let reads = 0;
	const realWaitersOn = registry.awaits.waitersOn.bind(registry.awaits);
	vi.spyOn(registry.awaits, "waitersOn").mockImplementation(id => {
		reads++;
		return realWaitersOn(id);
	});
	vi.spyOn(registry.awaits, "onChange").mockImplementation(() => {
		throw new Error("injected awaits subscription setup failure");
	});

	const failures: string[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await probe.childIdleTextWithBroker(cwd, 1);
		} catch (error) {
			failures.push(String(error));
		}
	}
	expect(failures).toHaveLength(3);
	const readsWhenRejected = reads;
	// A leak has no event to await, and the timer that would fire it lives in
	// another thread, where no fake clock of this one reaches: the only way to
	// see it is to let real time pass. 2.4 s is past all three one-second call
	// deadlines and two re-read intervals, so a surviving tick has fired twice.
	await Bun.sleep(2_400);

	expect(reads).toBe(readsWhenRejected);
}, 120_000);

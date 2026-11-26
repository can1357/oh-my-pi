/**
 * The daemon `provider-slots` module: its unit runs in this process behind
 * in-memory tunnels, one {@link DaemonProviderSlots} per simulated process.
 */
import { describe, expect, it, vi } from "bun:test";
import {
	DaemonProviderSlots,
	type ProviderSlotsDaemon,
	providerSlotsModule,
} from "../../src/daemon/modules/provider-slots";
import { delivered, LocalModuleDaemon } from "../fixtures/local-module-daemon";

/** One simulated process's slots on `daemon`. */
function processSlots(daemon: LocalModuleDaemon): DaemonProviderSlots {
	return new DaemonProviderSlots({ connect: async () => daemon, key: () => "config-root" });
}

/** Ask for a slot and record when it was granted. */
function take(
	slots: DaemonProviderSlots,
	limit: number,
	signal?: AbortSignal,
): { granted: boolean; release: Promise<() => void> } {
	const taken = { granted: false, release: Promise.resolve(() => {}) };
	taken.release = slots.acquire("openai", limit, signal).then(release => {
		taken.granted = true;
		return release;
	});
	return taken;
}

describe("daemon provider slots", () => {
	it("runs at most the limit across processes and grants waiters in the order they asked", async () => {
		const daemon = new LocalModuleDaemon(providerSlotsModule);
		const first = await processSlots(daemon).acquire("openai", 2);
		const second = await processSlots(daemon).acquire("openai", 2);
		const third = take(processSlots(daemon), 2);
		await delivered();
		const fourth = take(processSlots(daemon), 2);
		await delivered();
		expect([third.granted, fourth.granted]).toEqual([false, false]);
		// Other providers have slots of their own.
		(await processSlots(daemon).acquire("anthropic", 1))();

		first();
		await delivered();
		expect([third.granted, fourth.granted]).toEqual([true, false]);
		second();
		await delivered();
		expect(fourth.granted).toBe(true);
	});

	it("lets a request with a higher limit pass one waiting under a lower", async () => {
		const daemon = new LocalModuleDaemon(providerSlotsModule);
		const running = await processSlots(daemon).acquire("openai", 2);
		const strict = take(processSlots(daemon), 1);
		await delivered();
		const lenient = take(processSlots(daemon), 2);
		await delivered();
		expect([strict.granted, lenient.granted]).toEqual([false, true]);

		running();
		(await lenient.release)();
		await delivered();
		expect(strict.granted).toBe(true);
	});

	it("gives back the slots of a process that goes away", async () => {
		const daemon = new LocalModuleDaemon(providerSlotsModule);
		await processSlots(daemon).acquire("openai", 1);
		const waiting = take(processSlots(daemon), 1);
		await delivered();
		expect(waiting.granted).toBe(false);

		// The holder's process exited: its tunnel closed without a release.
		daemon.tunnels[0].close();
		await delivered();
		expect(waiting.granted).toBe(true);
	});

	it("withdraws an aborted request so the next one in line gets the slot", async () => {
		const daemon = new LocalModuleDaemon(providerSlotsModule);
		const held = await processSlots(daemon).acquire("openai", 1);
		const controller = new AbortController();
		const aborted = processSlots(daemon).acquire("openai", 1, controller.signal);
		await delivered();
		const next = take(processSlots(daemon), 1);
		await delivered();

		controller.abort(new Error("user cancelled"));
		await expect(aborted).rejects.toThrow("user cancelled");
		held();
		await delivered();
		expect(next.granted).toBe(true);
	});

	it("counts the requests still running on the unit that replaces a stopped one", async () => {
		const daemon = new LocalModuleDaemon(providerSlotsModule);
		const survivor = processSlots(daemon);
		const running = await survivor.acquire("openai", 1);
		const waiting = take(processSlots(daemon), 1);
		await delivered();

		// The daemon stops the unit (upgrade): the waiter goes ahead, and the survivor
		// reattaches to the next unit with its running request.
		await daemon.stop();
		await delivered();
		expect(waiting.granted).toBe(true);
		(await waiting.release)();
		const later = take(processSlots(daemon), 1);
		await delivered();
		expect(later.granted).toBe(false);

		running();
		await delivered();
		expect(later.granted).toBe(true);
	});

	it("goes ahead without a daemon and does not look for one again right away", async () => {
		const connect = vi.fn(async (): Promise<ProviderSlotsDaemon | undefined> => undefined);
		const offline = new DaemonProviderSlots({ connect, key: () => "config-root" });

		(await offline.acquire("openai", 1))();
		(await offline.acquire("openai", 1))();
		expect(connect).toHaveBeenCalledTimes(1);
	});
});

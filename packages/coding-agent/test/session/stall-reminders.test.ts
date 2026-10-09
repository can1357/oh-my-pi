import { afterEach, describe, expect, mock, type Mock, test } from "bun:test";
import { ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	cfgStallRemindersEnabled,
	cfgStallRemindersIntervalMinutes,
	cfgStallRemindersPolicy,
	type StallReminderSettings,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { StallReminderController, type StallReminderClock } from "@oh-my-pi/pi-coding-agent/session/stall-reminders";
import type { StallReport } from "@oh-my-pi/pi-coding-agent/session/stall-report";
import { TempDir } from "@oh-my-pi/pi-utils";

const enabled: StallReminderSettings = { enabled: true, intervalMinutes: 1, policy: "always" };
const controllers: StallReminderController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

class ManualClock implements StallReminderClock {
	time = 0;
	readonly scheduledDelays: number[] = [];
	readonly timers = new Set<{ at: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	schedule(callback: () => void, delayMs: number): () => void {
		this.scheduledDelays.push(delayMs);
		const timer = { at: this.time + delayMs, callback };
		this.timers.add(timer);
		return () => {
			this.timers.delete(timer);
		};
	}

	async advance(milliseconds: number): Promise<void> {
		const end = this.time + milliseconds;
		for (;;) {
			const timer = [...this.timers].sort((a, b) => a.at - b.at)[0];
			if (!timer || timer.at > end) break;
			this.time = timer.at;
			this.timers.delete(timer);
			timer.callback();
			await Promise.resolve();
			await Promise.resolve();
		}
		this.time = end;
		await Promise.resolve();
	}
}

function harness(options?: {
	collect?: () => Promise<StallReport>;
	unfinished?: boolean;
	requestDelivery?: () => void;
	shouldRetryDelivery?: () => boolean;
}) {
	const timerClock = new ManualClock();
	const commit = mock(() => {});
	const report: StallReport = {
		text: "Sampled at 1970-01-01T00:01:00.000Z: assess this report",
		hasUnfinishedWork: options?.unfinished ?? false,
		commit,
	};
	const collect = mock(options?.collect ?? (async () => report));
	const disposers: Mock<() => void>[] = [];
	const createCollector = mock(() => {
		const dispose = mock(() => {});
		disposers.push(dispose);
		return { collect, dispose };
	});
	const requestDelivery = mock(options?.requestDelivery ?? (() => {}));
	const controller = new StallReminderController(
		{
			createCollector,
			requestDelivery,
			shouldRetryDelivery: options?.shouldRetryDelivery,
		},
		timerClock,
	);
	controllers.push(controller);
	return { controller, timerClock, collect, commit, report, createCollector, requestDelivery, disposers };
}

describe("stall reminder settings", () => {
	test("pristine and partial on-disk configs can load with an omitted reminder interval", async () => {
		const directory = TempDir.createSync("@pi-stall-reminder-config-");
		try {
			const agentDir = directory.join("agent");
			const options = { cwd: directory.path(), agentDir };
			const pristine = await Settings.loadReadOnly(options);
			const inheritedInterval = cfgStallRemindersIntervalMinutes.get(pristine);
			expect(Number.isFinite(inheritedInterval)).toBe(true);
			expect(inheritedInterval).toBeGreaterThan(0);
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, "config.yml"), "stallReminders:\n  enabled: true\n");
			const partial = await Settings.loadReadOnly(options);
			expect(cfgStallRemindersEnabled.get(partial)).toBe(true);
			expect(cfgStallRemindersIntervalMinutes.get(partial)).toBe(inheritedInterval);
		} finally {
			directory.removeSync();
		}
	});

	test("explicit invalid on-disk intervals reject read-only loading and persisted reload without changing last-good state", async () => {
		const directory = TempDir.createSync("@pi-stall-reminder-invalid-config-");
		try {
			const agentDir = directory.join("agent");
			fs.mkdirSync(agentDir, { recursive: true });
			const configPath = path.join(agentDir, "config.yml");
			await Bun.write(configPath, "stallReminders:\n  intervalMinutes: 2.5\n");
			const options = { cwd: directory.path(), agentDir };
			const settings = await Settings.loadIsolated(options);
			await Bun.write(configPath, "stallReminders:\n  intervalMinutes: 0\n");
			await expect(Settings.loadReadOnly(options)).rejects.toThrow("positive finite");
			await expect(settings.reloadFromDisk()).rejects.toThrow("positive finite");
			expect(cfgStallRemindersIntervalMinutes.get(settings)).toBe(2.5);
		} finally {
			AgentStorage.close();
			directory.removeSync();
		}
	});

	test("interval rejects non-positive, non-finite and malformed input without restricting finite positive values", () => {
		const settings = Settings.isolated();
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => cfgStallRemindersIntervalMinutes.override(settings, value)).toThrow("positive finite");
		}
		expect(() => cfgStallRemindersIntervalMinutes.parse("0")).toThrow("positive finite");
		for (const value of [Number.MIN_VALUE, 0.001, 60, Number.MAX_VALUE]) {
			cfgStallRemindersIntervalMinutes.override(settings, value);
			expect(cfgStallRemindersIntervalMinutes.get(settings)).toBe(value);
		}
		expect(() => cfgStallRemindersPolicy.parse("sometimes")).toThrow("Valid values");
	});
});

describe("StallReminderController", () => {
	test("a temporary delivery gate retries the same report without recollecting, then resumes after the gate clears", async () => {
		let gateOpen = false;
		const h = harness({
			shouldRetryDelivery: () => true,
			requestDelivery: () => {
				if (gateOpen) controller.takeAside()?.()?.[ASIDE_MESSAGE_COMMIT]?.();
			},
		});
		const controller = h.controller;
		controller.configure(enabled);
		await h.timerClock.advance(60_000);
		await h.timerClock.advance(3_000);
		expect(h.collect).toHaveBeenCalledTimes(1);
		expect(h.requestDelivery).toHaveBeenCalledTimes(4);
		expect(h.commit).not.toHaveBeenCalled();
		gateOpen = true;
		await h.timerClock.advance(1_000);
		expect(h.commit).toHaveBeenCalledTimes(1);
		expect(h.collect).toHaveBeenCalledTimes(1);
		expect(h.timerClock.timers.size).toBe(1);
		await h.timerClock.advance(59_999);
		expect(h.collect).toHaveBeenCalledTimes(1);
	});

	test("a released persistent gate can re-arm one temporary retry without recollecting its parked report", async () => {
		let held = true;
		let gateOpen = false;
		const h = harness({
			shouldRetryDelivery: () => !held,
			requestDelivery: () => {
				if (gateOpen) controller.takeAside()?.()?.[ASIDE_MESSAGE_COMMIT]?.();
			},
		});
		const controller = h.controller;
		controller.configure(enabled);
		await h.timerClock.advance(60_000);
		expect(h.timerClock.timers.size).toBe(0);
		await h.timerClock.advance(600_000);
		expect(h.collect).toHaveBeenCalledTimes(1);
		expect(h.requestDelivery).toHaveBeenCalledTimes(1);
		held = false;
		controller.retryBlockedDelivery();
		controller.retryBlockedDelivery();
		expect(h.timerClock.timers.size).toBe(1);
		await h.timerClock.advance(1_000);
		expect(h.requestDelivery).toHaveBeenCalledTimes(2);
		expect(h.commit).not.toHaveBeenCalled();
		gateOpen = true;
		await h.timerClock.advance(1_000);
		expect(h.commit).toHaveBeenCalledTimes(1);
		expect(h.collect).toHaveBeenCalledTimes(1);
		expect(h.timerClock.timers.size).toBe(1);
	});

	test("protocol deferral or a deliberate stop parks delivery without polling", async () => {
		let defer = false;
		const h = harness({ shouldRetryDelivery: () => !defer });
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		await h.timerClock.advance(1_000);
		defer = true;
		await h.timerClock.advance(10_000);
		h.controller.retryBlockedDelivery();
		await h.timerClock.advance(10_000);
		expect(h.requestDelivery).toHaveBeenCalledTimes(2);
		expect(h.collect).toHaveBeenCalledTimes(1);
		expect(h.controller.hasPending).toBe(true);
		expect(h.timerClock.timers.size).toBe(0);
	});

	test("session transition and disposal cancel a pending delivery retry", async () => {
		const h = harness({ shouldRetryDelivery: () => true });
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		expect(h.timerClock.timers.size).toBe(1);
		h.controller.suspend();
		expect(h.timerClock.timers.size).toBe(0);
		h.controller.resume();
		await h.timerClock.advance(60_000);
		h.controller.dispose();
		await h.timerClock.advance(10_000);
		expect(h.requestDelivery).toHaveBeenCalledTimes(2);
		expect(h.timerClock.timers.size).toBe(0);
	});

	test("disabled settings never instantiate or collect telemetry and arm no timer", async () => {
		const h = harness();
		h.controller.configure({ ...enabled, enabled: false });
		h.controller.configure({ ...enabled, enabled: false, intervalMinutes: 5 });
		await h.timerClock.advance(600_000);
		expect(h.createCollector).not.toHaveBeenCalled();
		expect(h.collect).not.toHaveBeenCalled();
		expect(h.timerClock.timers.size).toBe(0);
	});

	test("always delivers a synthetic developer report while fully idle, commits only its receipt and never stacks reports", async () => {
		const h = harness();
		h.controller.configure(enabled);
		await h.timerClock.advance(59_999);
		expect(h.collect).not.toHaveBeenCalled();
		await h.timerClock.advance(1);
		expect(h.requestDelivery).toHaveBeenCalledTimes(1);
		expect(h.commit).not.toHaveBeenCalled();
		await h.timerClock.advance(60_000 * 100);
		expect(h.collect).toHaveBeenCalledTimes(1);
		const first = h.controller.takeAside()!;
		const duplicate = h.controller.takeAside()!;
		const message = first()!;
		expect(duplicate()).toBeNull();
		expect(message).toMatchObject({ role: "developer", synthetic: true, userInitiated: false, attribution: "agent" });
		expect(h.controller.takeAside()).toBeUndefined();
		expect(h.commit).not.toHaveBeenCalled();
		message[ASIDE_MESSAGE_COMMIT]?.();
		message[ASIDE_MESSAGE_COMMIT]?.();
		expect(h.commit).toHaveBeenCalledTimes(1);
		await h.timerClock.advance(60_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
	});

	test("unfinished-only skips without consuming the collector baseline and reassesses at the next interval", async () => {
		const h = harness();
		h.controller.configure({ ...enabled, policy: "unfinished-only" });
		await h.timerClock.advance(120_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
		expect(h.requestDelivery).not.toHaveBeenCalled();
		expect(h.commit).not.toHaveBeenCalled();
		h.report.hasUnfinishedWork = true;
		await h.timerClock.advance(60_000);
		h.controller.takeAside()!()![ASIDE_MESSAGE_COMMIT]?.();
		expect(h.commit).toHaveBeenCalledTimes(1);
	});

	test("settings edits invalidate queued lazy reports and rearm with the new interval without replacing the baseline", async () => {
		const h = harness();
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		const stale = h.controller.takeAside()!;
		h.controller.configure({ ...enabled, intervalMinutes: 2 });
		expect(stale()).toBeNull();
		await h.timerClock.advance(119_999);
		expect(h.collect).toHaveBeenCalledTimes(1);
		await h.timerClock.advance(1);
		expect(h.collect).toHaveBeenCalledTimes(2);
		expect(h.createCollector).toHaveBeenCalledTimes(1);
		expect(h.commit).not.toHaveBeenCalled();
	});

	test("disabling invalidates a claimed report and unsubscribes tracking immediately", async () => {
		const h = harness();
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		const message = h.controller.takeAside()!()!;
		h.controller.configure({ ...enabled, enabled: false });
		message[ASIDE_MESSAGE_COMMIT]?.();
		await h.timerClock.advance(600_000);
		expect(h.commit).not.toHaveBeenCalled();
		expect(h.disposers[0]).toHaveBeenCalledTimes(1);
		expect(h.timerClock.timers.size).toBe(0);
	});

	test("collection cannot overlap even across disable, re-enable and transcript reset", async () => {
		const deferred = Promise.withResolvers<StallReport>();
		const h = harness({ collect: () => deferred.promise });
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		h.controller.configure({ ...enabled, enabled: false });
		h.controller.configure(enabled);
		h.controller.suspend();
		h.controller.resume();
		await h.timerClock.advance(600_000);
		expect(h.collect).toHaveBeenCalledTimes(1);
		deferred.resolve(h.report);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.requestDelivery).not.toHaveBeenCalled();
		expect(h.commit).not.toHaveBeenCalled();
		await h.timerClock.advance(60_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
		expect(h.requestDelivery).toHaveBeenCalledTimes(1);
	});

	test("transcript transitions drop old receipts, dispose the old collector, and start a fresh full interval", async () => {
		const h = harness();
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		const message = h.controller.takeAside()!()!;
		h.controller.suspend();
		await h.timerClock.advance(600_000);
		expect(h.collect).toHaveBeenCalledTimes(1);
		h.controller.resume();
		message[ASIDE_MESSAGE_COMMIT]?.();
		expect(h.commit).not.toHaveBeenCalled();
		expect(h.createCollector).toHaveBeenCalledTimes(2);
		expect(h.disposers[0]).toHaveBeenCalledTimes(1);
		await h.timerClock.advance(60_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
	});

	test("discard rearms without committing so undelivered completion deltas remain available", async () => {
		const h = harness();
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		const message = h.controller.takeAside()!()!;
		message[ASIDE_MESSAGE_DISCARD]?.(new Error("aborted before boundary"));
		message[ASIDE_MESSAGE_COMMIT]?.();
		expect(h.commit).not.toHaveBeenCalled();
		await h.timerClock.advance(60_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
	});

	test("disposing during collection ignores its late completion and arms nothing", async () => {
		const deferred = Promise.withResolvers<StallReport>();
		const h = harness({ collect: () => deferred.promise });
		h.controller.configure(enabled);
		await h.timerClock.advance(60_000);
		h.controller.dispose();
		deferred.resolve(h.report);
		await Promise.resolve();
		await h.timerClock.advance(600_000);
		expect(h.requestDelivery).not.toHaveBeenCalled();
		expect(h.commit).not.toHaveBeenCalled();
		expect(h.timerClock.timers.size).toBe(0);
	});

	test("collection failure does not poison later intervals", async () => {
		const h = harness();
		h.collect.mockRejectedValueOnce(new Error("telemetry unavailable"));
		h.controller.configure(enabled);
		await h.timerClock.advance(120_000);
		expect(h.collect).toHaveBeenCalledTimes(2);
		expect(h.requestDelivery).toHaveBeenCalledTimes(1);
		expect(h.commit).not.toHaveBeenCalled();
	});

	test("huge finite intervals use bounded timer chunks instead of overflowing to immediate wake", async () => {
		const h = harness();
		h.controller.configure({ ...enabled, intervalMinutes: Number.MAX_VALUE });
		expect(h.timerClock.scheduledDelays).toEqual([2_147_483_647]);
		await h.timerClock.advance(2_147_483_647);
		expect(h.collect).not.toHaveBeenCalled();
		expect(h.timerClock.scheduledDelays).toEqual([2_147_483_647, 2_147_483_647]);
	});

	test("sub-millisecond positive intervals cannot form an immediate microtask spin", async () => {
		const h = harness();
		h.controller.configure({ ...enabled, intervalMinutes: Number.MIN_VALUE, policy: "unfinished-only" });
		expect(h.timerClock.scheduledDelays).toEqual([1]);
		await h.timerClock.advance(2);
		expect(h.collect).toHaveBeenCalledTimes(2);
		expect(h.timerClock.timers.size).toBe(1);
	});
});

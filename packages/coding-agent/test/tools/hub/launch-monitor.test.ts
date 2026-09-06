import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { DaemonBrokerClient, DaemonCompletionUnregisterOptions } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type {
	DaemonCompletionNotification,
	DaemonMonitorNotification,
	DaemonOperation,
	DaemonOutputSubscription,
	DaemonRpcResult,
	DaemonSnapshot,
	DaemonSpec,
} from "../../../src/launch/protocol";
import { DAEMON_OUTPUT_MONITOR_CAPABILITY } from "../../../src/launch/protocol";
import type { LaunchContextBoundary, ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";
import { PROGRESS_LIMITS } from "../../../src/async/progress-limits";

const OWNER = "owner-session";

const daemon: DaemonSnapshot = {
	name: "web",
	id: "daemon-id",
	state: "running",
	pid: 123,
	createdAt: 1,
	startedAt: 2,
	restartCount: 0,
	outputBytes: 0,
	owner: OWNER,
	persist: true,
	detached: false,
};

const spec: DaemonSpec = {
	name: daemon.name,
	application: process.execPath,
	args: [],
	env: {},
	cwd: process.cwd(),
	pty: false,
	restart: "no",
	persist: true,
	detached: false,
};

interface MonitorHarness {
	client: DaemonBrokerClient;
	session: ToolSession;
	requests: DaemonOperation[];
	progress: Array<{
		notification: Extract<DaemonMonitorNotification, { event: "daemon-output" }>;
		delivery: string;
		artifactId?: string;
	}>;
	completions: DaemonCompletionNotification[];
	active: Array<{ monitorId: string; delivery: string; active: boolean }>;
	completionPreservePending: boolean[];
	epochs: number[];
	disposeCallbacks: Array<() => void>;
	contextBoundaryCallbacks: Set<(boundary: LaunchContextBoundary) => void>;
	getOutputSink(): ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
	getCompletionSink(): ((notification: DaemonCompletionNotification) => void | Promise<void>) | undefined;
	getSubscription(): DaemonOutputSubscription | undefined;
	unregisterCount(): number;
	republishCount(): number;
	registrationCount(): number;
}

function createHarness(
	artifact?: { id: string; path: string },
	outputReady: Promise<void> = Promise.resolve(),
): MonitorHarness {
	const allocatedArtifact =
		artifact ??
		({
			id: `hub-progress-${crypto.randomUUID()}`,
			path: path.join(process.cwd(), `.hub-progress-${crypto.randomUUID()}.log`),
		} satisfies { id: string; path: string });
	const requests: DaemonOperation[] = [];
	const progress: MonitorHarness["progress"] = [];
	const completions: DaemonCompletionNotification[] = [];
	const active: MonitorHarness["active"] = [];
	const completionPreservePending: boolean[] = [];
	const epochs: number[] = [];
	const disposeCallbacks: Array<() => void> = [];
	const contextBoundaryCallbacks = new Set<(boundary: LaunchContextBoundary) => void>();
	let outputSink: ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
	let completionSink: ((notification: DaemonCompletionNotification) => void | Promise<void>) | undefined;
	let subscription: DaemonOutputSubscription | undefined;
	let unregisters = 0;
	let republishes = 0;
	const registrations = new Set<string>();
	const client = {
		projectDir: process.cwd(),
		onCompletion: (_owner: string, sink: (notification: DaemonCompletionNotification) => void | Promise<void>) => {
			completionSink = sink;
			return (options?: DaemonCompletionUnregisterOptions) => {
				completionPreservePending.push(options?.preservePending === true);
				if (completionSink === sink) completionSink = undefined;
			};
		},
		onOutput: (
			registered: DaemonOutputSubscription,
			sink: (notification: DaemonMonitorNotification) => void | Promise<void>,
		) => {
			subscription = registered;
			outputSink = sink;
			registrations.add(registered.id);
			const unregister = (): void => {
				unregisters++;
				registrations.delete(registered.id);
				if (subscription === registered) subscription = undefined;
				if (outputSink === sink) outputSink = undefined;
			};
			return Object.assign(unregister, {
				ready: outputReady,
				republish: () => {
					republishes++;
				},
			});
		},
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			requests.push(operation);
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "start") {
				// Starts subscribe before the launch so no early lines are missed.
				expect(subscription).toMatchObject({ name: daemon.name, owner: OWNER });
				return { op: "start", daemon, readyTimedOut: false };
			}
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			throw new Error(`Unexpected operation: ${operation.op}`);
		},
		close() {},
	} as DaemonBrokerClient;
	const session = {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		allocateOutputArtifact: async () => allocatedArtifact,
		getSessionId: () => OWNER,
		isDisposed: () => false,
		captureLaunchProgressEpoch: () => 17,
		queueLaunchProgress: (
			notification: Extract<DaemonMonitorNotification, { event: "daemon-output" }>,
			delivery: string,
			_startedAt: number,
			epoch: number,
			artifactId?: string,
		) => {
			epochs.push(epoch);
			progress.push({ notification, delivery, artifactId });
		},
		queueLaunchCompletion: async (notification: DaemonCompletionNotification) => {
			completions.push(notification);
		},
		setLaunchMonitorActive: (monitorId: string, delivery: string, isActive: boolean, epoch: number) => {
			epochs.push(epoch);
			active.push({ monitorId, delivery, active: isActive });
		},
		registerDisposeCallback: (callback: () => void) => {
			disposeCallbacks.push(callback);
		},
		registerContextBoundaryCallback: (callback: (boundary: LaunchContextBoundary) => void) => {
			contextBoundaryCallbacks.add(callback);
			return () => contextBoundaryCallbacks.delete(callback);
		},
	} as unknown as ToolSession;
	return {
		client,
		session,
		requests,
		progress,
		completions,
		active,
		completionPreservePending,
		disposeCallbacks,
		contextBoundaryCallbacks,
		epochs,
		getOutputSink: () => outputSink,
		getCompletionSink: () => completionSink,
		getSubscription: () => subscription,
		unregisterCount: () => unregisters,
		republishCount: () => republishes,
		registrationCount: () => registrations.size,
	};
}

/** Settle the speculative-flush promise chain deterministically — microtasks only, no timers. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hub process output monitoring", () => {
	it("advertises the output subscription before starting and routes live output", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});

		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "start"]);
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "ready",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.progress).toEqual([
			{
				notification: {
					event: "daemon-output",
					monitorId: subscription.id,
					name: daemon.name,
					daemonId: daemon.id,
					seq: 1,
					text: "ready",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				delivery: "wake",
				artifactId: expect.stringContaining("hub-progress-"),
			},
		]);
		expect(harness.active).toEqual([{ monitorId: subscription.id, delivery: "wake", active: true }]);
		expect(harness.epochs).toEqual([17, 17]);
	});

	it("rolls back a monitored start when subscription publication fails after launch", async () => {
		const publication = Promise.withResolvers<void>();
		const harness = createHarness(undefined, publication.promise);
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		const starting = executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			progress: "wake",
		});
		await drainMicrotasks();
		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "start"]);
		expect(harness.registrationCount()).toBe(1);

		publication.reject(new Error("publication failed"));
		await expect(starting).rejects.toThrow("publication failed");

		expect(harness.getSubscription()).toBeUndefined();
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.active).toEqual([
			{ monitorId: expect.any(String), delivery: "wake", active: true },
			{ monitorId: expect.any(String), delivery: "wake", active: false },
		]);
	});

	it("rejects an attach when the process completes during subscription publication", async () => {
		const publication = Promise.withResolvers<void>();
		const harness = createHarness(undefined, publication.promise);
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		const monitoring = executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "wake",
		});
		await drainMicrotasks();
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		const terminalDelivery = Promise.resolve(
			sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
			}),
		);
		publication.resolve();

		await expect(monitoring).rejects.toThrow(`Cannot monitor ${daemon.name}: process is exited`);
		await terminalDelivery;
		expect(harness.registrationCount()).toBe(0);
	});

	it("validates a monitored start before advertising its subscription", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				ready: { log: "(" },
				progress: "wake",
			}),
		).rejects.toThrow("Invalid readiness regex");

		expect(harness.requests).toEqual([]);
		expect(harness.getSubscription()).toBeUndefined();
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.active).toEqual([]);
	});

	it("rejects a monitored start without a session owner before launching", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const session = { ...harness.session, getSessionId: undefined } as unknown as ToolSession;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			harness.requests.push(operation);
			if (operation.op === "start") return { op: "start", daemon, readyTimedOut: false };
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		await expect(
			executeLaunch(session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				progress: "wake",
			}),
		).rejects.toThrow("Live progress monitoring requires a session owner");

		expect(harness.requests).toEqual([]);
		expect(harness.getSubscription()).toBeUndefined();

		const unmonitored = await executeLaunch(session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
		});
		expect(harness.requests).toEqual([expect.objectContaining({ op: "start", owner: undefined })]);
		expect(unmonitored.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Started") }),
		]);
	});

	it("never replays output that predates a successful monitor attach", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const request = harness.client.request;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			// Output produced while the attach is still validating must never
			// reach the session: the sink may only exist after the describe
			// result confirms the attach.
			if (operation.op === "describe") expect(harness.getOutputSink()).toBeUndefined();
			return request(operation);
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });

		expect(harness.progress).toHaveLength(0);
		expect(harness.getSubscription()).toMatchObject({ name: daemon.name, owner: OWNER });
		expect(harness.getOutputSink()).toBeDefined();
	});

	it("waits for broker publication before confirming an existing-process attach", async () => {
		const publication = Promise.withResolvers<void>();
		const harness = createHarness(undefined, publication.promise);
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		let resolved = false;
		const attach = executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "wake",
		}).then(result => {
			resolved = true;
			return result;
		});

		await drainMicrotasks();
		expect(harness.getSubscription()).toBeDefined();
		expect(resolved).toBeFalse();

		publication.resolve();
		await attach;
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "after attach",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.progress.map(item => item.notification.text)).toEqual(["after attach"]);
	});

	it("enqueues attached output before yielding to independent completion delivery", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		const delivery = sink({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "final ambient output",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.progress.map(item => item.notification.text)).toEqual(["final ambient output"]);
		await delivery;
	});

	it("attaches to an existing process and updates its delivery mode in place", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "after mode update",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "describe", "ping", "describe"]);
		expect(harness.getSubscription()?.id).toBe(subscription.id);
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.progress.map(item => item.delivery)).toEqual(["ambient"]);
		expect(harness.active).toEqual([
			{ monitorId: subscription.id, delivery: "wake", active: true },
			{ monitorId: subscription.id, delivery: "wake", active: false },
			{ monitorId: subscription.id, delivery: "ambient", active: true },
		]);
	});

	it("advertises delivery mode, attach time, and artifact on the subscription and re-advertises a retune", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const before = Date.now();

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		expect(subscription).toMatchObject({
			delivery: "wake",
			artifactId: expect.stringContaining("hub-progress-"),
		});
		expect(subscription.since).toBeGreaterThanOrEqual(before);
		expect(harness.republishCount()).toBe(0);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		// Same registration, updated wire metadata, one re-advertisement so the
		// broker's watcher rows switch to ambient without a new capture.
		expect(harness.getSubscription()).toBe(subscription);
		expect(subscription.delivery).toBe("ambient");
		expect(harness.republishCount()).toBe(1);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		expect(harness.republishCount()).toBe(1);
	});

	it("lists each process's watchers on ps and describe", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const other: DaemonSnapshot = { ...daemon, name: "worker", id: "worker-id", owner: "someone-else" };
		const monitors = [
			{
				name: daemon.name,
				id: "own-monitor",
				owner: OWNER,
				delivery: "wake" as const,
				since: Date.now() - 90_000,
				artifactId: "hub-progress-own",
				daemonId: daemon.id,
				connected: true,
			},
			{
				name: daemon.name,
				id: "stale-monitor",
				owner: "other-session",
				delivery: "ambient" as const,
				since: Date.now() - 5_000,
				artifactId: "hub-progress-other",
				daemonId: "previous-daemon-id",
				connected: false,
			},
			{ name: other.name, id: "pending-monitor", owner: "third-session", connected: true },
		];
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "list") return { op: "list", daemons: [daemon, other], monitors };
			if (operation.op === "describe") {
				return { op: "describe", daemon, spec, monitors: monitors.filter(item => item.name === daemon.name) };
			}
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		const listed = await executeLaunch(harness.session, { op: "list" });
		const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
		expect(listText.split("\n")).toEqual([
			expect.stringMatching(/^- web: running/),
			expect.stringMatching(
				/^ {2}watched by: this session \(wake, since 1m30s ago, artifact:\/\/hub-progress-own\); other-session \(ambient, since 5\.\ds ago, artifact:\/\/hub-progress-other, disconnected, previous incarnation\)$/,
			),
			expect.stringContaining("- worker:"),
			"  watched by: third-session (unknown mode, awaiting start)",
		]);
		expect(listed.details?.monitors).toEqual(monitors);

		const described = await executeLaunch(harness.session, { op: "describe", name: daemon.name });
		const describeText = described.content[0]?.type === "text" ? described.content[0].text : "";
		expect(describeText.split("\n").slice(-3)).toEqual([
			"Watchers:",
			expect.stringMatching(/^- this session \(wake, since 1m30s ago, artifact:\/\/hub-progress-own\)$/),
			expect.stringMatching(/^- other-session \(ambient, .*disconnected, previous incarnation\)$/),
		]);
		expect(described.details?.monitors).toHaveLength(2);

		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "describe") return { op: "describe", daemon, spec, monitors: [] };
			throw new Error(`Unexpected operation: ${operation.op}`);
		});
		const unwatched = await executeLaunch(harness.session, { op: "describe", name: daemon.name });
		const unwatchedText = unwatched.content[0]?.type === "text" ? unwatched.content[0].text : "";
		expect(unwatchedText.split("\n").at(-1)).toBe("Watchers: none");
		expect(unwatched.details?.monitors).toEqual([]);
	});

	it("tells the caller how to get output when a detached process cannot be monitored", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const remediation = /start it without detached: true, or read its output with logs \(follow: true\)/;

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				detached: true,
				progress: "wake",
			}),
		).rejects.toThrow(remediation);
		expect(harness.requests).toEqual([]);

		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "describe") return { op: "describe", daemon: { ...daemon, detached: true }, spec };
			throw new Error(`Unexpected operation: ${operation.op}`);
		});
		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" }),
		).rejects.toThrow(remediation);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.active).toEqual([]);
	});

	it("replaces an attached monitor when the same name describes a new incarnation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const request = harness.client.request;
		let describedDaemon = daemon;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			const result = await request(operation);
			return result.op === "describe" ? { ...result, daemon: describedDaemon } : result;
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const original = harness.getSubscription();
		if (!original) throw new Error("Expected original output subscription");
		describedDaemon = { ...daemon, id: "replacement-daemon-id", createdAt: daemon.createdAt + 1 };

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const replacement = harness.getSubscription();
		if (!replacement) throw new Error("Expected replacement output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: replacement.id,
			name: daemon.name,
			daemonId: describedDaemon.id,
			seq: 1,
			text: "replacement output",
			batchKind: "progress",
			suppressedEvents: 0,
		});

		expect(replacement).toMatchObject({ daemonId: describedDaemon.id });
		expect(replacement.id).not.toBe(original.id);
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.registrationCount()).toBe(1);
		expect(harness.progress).toEqual([
			expect.objectContaining({
				delivery: "ambient",
				notification: expect.objectContaining({ text: "replacement output" }),
			}),
		]);
	});

	it("restores an attached monitor when an overlapping replacement fails publication", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const firstAllocationStarted = Promise.withResolvers<void>();
		const secondAllocationStarted = Promise.withResolvers<void>();
		const releaseFirstAllocation = Promise.withResolvers<void>();
		const releaseSecondAllocation = Promise.withResolvers<void>();
		let allocationCount = 0;
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(async () => {
			const allocation = ++allocationCount;
			if (allocation === 1) {
				firstAllocationStarted.resolve();
				await releaseFirstAllocation.promise;
			}
			if (allocation === 2) {
				secondAllocationStarted.resolve();
				await releaseSecondAllocation.promise;
			}
			return {
				id: `hub-progress-${allocation}`,
				path: path.join(process.cwd(), `.hub-progress-${allocation}.log`),
			};
		});
		const onOutput = harness.client.onOutput;
		if (!onOutput) throw new Error("Expected output monitoring support");
		let publicationCount = 0;
		vi.spyOn(harness.client, "onOutput").mockImplementation((subscription, sink) => {
			publicationCount++;
			const unregister = onOutput.call(harness.client, subscription, sink);
			if (!unregister) throw new Error("Expected output registration");
			return Object.assign(unregister, {
				ready: publicationCount === 2 ? Promise.reject(new Error("publication failed")) : Promise.resolve(),
			});
		});

		const first = executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		await firstAllocationStarted.promise;
		const replacement = executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		await secondAllocationStarted.promise;

		releaseFirstAllocation.resolve();
		await first;
		const original = harness.getSubscription();
		if (!original) throw new Error("Expected original output subscription");
		releaseSecondAllocation.resolve();
		await expect(replacement).rejects.toThrow("publication failed");

		const restored = harness.getSubscription();
		const restoredSink = harness.getOutputSink();
		if (!restored || !restoredSink) throw new Error("Expected restored output registration");
		expect(restored.id).not.toBe(original.id);
		expect(restored.daemonId).toBe(daemon.id);
		expect(harness.registrationCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: restored.id, delivery: "ambient", active: true });
		await restoredSink({
			event: "daemon-output",
			monitorId: restored.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "restored output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress).toEqual([
			expect.objectContaining({
				delivery: "ambient",
				notification: expect.objectContaining({ text: "restored output" }),
			}),
		]);
	});

	it("keeps a newer monitor when an older artifact allocation finishes later", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });

		const olderAllocationStarted = Promise.withResolvers<void>();
		const olderArtifact = Promise.withResolvers<{ id: string; path: string }>();
		let allocationCount = 0;
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(async () => {
			allocationCount++;
			if (allocationCount === 1) {
				olderAllocationStarted.resolve();
				return olderArtifact.promise;
			}
			return {
				id: `hub-progress-newer-${allocationCount}`,
				path: path.join(process.cwd(), `.hub-progress-newer-${allocationCount}.log`),
			};
		});
		const request = harness.client.request;
		const olderDaemon = { ...daemon, id: "allocation-race-older", createdAt: daemon.createdAt + 1 };
		const newerDaemon = { ...daemon, id: "allocation-race-newer", createdAt: daemon.createdAt + 2 };
		let describedDaemon = olderDaemon;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			const result = await request(operation);
			return result.op === "describe" ? { ...result, daemon: describedDaemon } : result;
		});

		const older = executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		await olderAllocationStarted.promise;
		describedDaemon = newerDaemon;
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const winner = harness.getSubscription();
		const winnerSink = harness.getOutputSink();
		if (!winner || !winnerSink) throw new Error("Expected newer output registration");

		olderArtifact.resolve({
			id: "hub-progress-older",
			path: path.join(process.cwd(), ".hub-progress-older.log"),
		});
		await expect(older).rejects.toThrow("This session cannot accept process progress delivery");

		expect(harness.getSubscription()).toBe(winner);
		expect(winner.daemonId).toBe(newerDaemon.id);
		expect(harness.registrationCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: winner.id, delivery: "ambient", active: true });
		await winnerSink({
			event: "daemon-output",
			monitorId: winner.id,
			name: daemon.name,
			daemonId: newerDaemon.id,
			seq: 1,
			text: "newest monitor output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress).toEqual([
			expect.objectContaining({
				delivery: "ambient",
				notification: expect.objectContaining({ text: "newest monitor output" }),
			}),
		]);
	});

	it("does not let an old allocation cross an accepted monitor behind a newer allocation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });

		const olderAllocationStarted = Promise.withResolvers<void>();
		const newestAllocationStarted = Promise.withResolvers<void>();
		const olderArtifact = Promise.withResolvers<{ id: string; path: string }>();
		const newestArtifact = Promise.withResolvers<{ id: string; path: string }>();
		let allocationCount = 0;
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(async () => {
			allocationCount++;
			if (allocationCount === 1) {
				olderAllocationStarted.resolve();
				return olderArtifact.promise;
			}
			if (allocationCount === 3) {
				newestAllocationStarted.resolve();
				return newestArtifact.promise;
			}
			return {
				id: "hub-progress-accepted-middle",
				path: path.join(process.cwd(), ".hub-progress-accepted-middle.log"),
			};
		});
		const request = harness.client.request;
		const olderDaemon = { ...daemon, id: "three-way-older", createdAt: daemon.createdAt + 1 };
		const acceptedDaemon = { ...daemon, id: "three-way-accepted", createdAt: daemon.createdAt + 2 };
		const newestDaemon = { ...daemon, id: "three-way-newest", createdAt: daemon.createdAt + 3 };
		let describedDaemon = olderDaemon;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			const result = await request(operation);
			return result.op === "describe" ? { ...result, daemon: describedDaemon } : result;
		});

		const older = executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		await olderAllocationStarted.promise;
		describedDaemon = acceptedDaemon;
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const accepted = harness.getSubscription();
		if (!accepted) throw new Error("Expected accepted middle registration");

		describedDaemon = newestDaemon;
		const newest = executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		await newestAllocationStarted.promise;
		olderArtifact.resolve({
			id: "hub-progress-three-way-older",
			path: path.join(process.cwd(), ".hub-progress-three-way-older.log"),
		});
		const olderOutcome = await older.catch(error => error);
		const registrationBeforeNewest = harness.getSubscription();

		newestArtifact.resolve({
			id: "hub-progress-three-way-newest",
			path: path.join(process.cwd(), ".hub-progress-three-way-newest.log"),
		});
		await newest;

		expect(olderOutcome).toBeInstanceOf(Error);
		expect((olderOutcome as Error).message).toBe("This session cannot accept process progress delivery");
		expect(registrationBeforeNewest).toBe(accepted);
		expect(accepted.daemonId).toBe(acceptedDaemon.id);
		expect(harness.getSubscription()?.daemonId).toBe(newestDaemon.id);
		expect(harness.registrationCount()).toBe(1);
	});

	it("restores the prior monitor when replacement publication throws synchronously", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const original = harness.getSubscription();
		if (!original) throw new Error("Expected original output registration");

		const request = harness.client.request;
		const replacementDaemon = { ...daemon, id: "sync-publication-failure", createdAt: daemon.createdAt + 1 };
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			const result = await request(operation);
			return result.op === "describe" ? { ...result, daemon: replacementDaemon } : result;
		});
		const onOutput = harness.client.onOutput;
		if (!onOutput) throw new Error("Expected output monitoring support");
		vi.spyOn(harness.client, "onOutput")
			.mockImplementationOnce(() => {
				throw new Error("client closed during publication");
			})
			.mockImplementation((subscription, sink) => onOutput.call(harness.client, subscription, sink));

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" }),
		).rejects.toThrow("client closed during publication");

		const restored = harness.getSubscription();
		const restoredSink = harness.getOutputSink();
		if (!restored || !restoredSink) throw new Error("Expected restored output registration");
		expect(restored.id).not.toBe(original.id);
		expect(restored.daemonId).toBe(daemon.id);
		expect(harness.registrationCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: restored.id, delivery: "ambient", active: true });
		await restoredSink({
			event: "daemon-output",
			monitorId: restored.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "restored after sync failure",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress).toEqual([
			expect.objectContaining({
				delivery: "ambient",
				notification: expect.objectContaining({ text: "restored after sync failure" }),
			}),
		]);
	});

	it("keeps a newer monitor when an older replacement publication fails later", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const failedPublication = Promise.withResolvers<void>();
		const olderPublicationStarted = Promise.withResolvers<void>();
		const request = harness.client.request;
		const olderDaemon = { ...daemon, id: "older-replacement-daemon-id", createdAt: daemon.createdAt + 1 };
		const newerDaemon = { ...daemon, id: "newer-replacement-daemon-id", createdAt: daemon.createdAt + 2 };
		let describedDaemon = daemon;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			const result = await request(operation);
			return result.op === "describe" ? { ...result, daemon: describedDaemon } : result;
		});
		const onOutput = harness.client.onOutput;
		if (!onOutput) throw new Error("Expected output monitoring support");
		let publicationCount = 0;
		vi.spyOn(harness.client, "onOutput").mockImplementation((subscription, sink) => {
			publicationCount++;
			const unregister = onOutput.call(harness.client, subscription, sink);
			if (!unregister) throw new Error("Expected output registration");
			if (publicationCount === 2) olderPublicationStarted.resolve();
			return Object.assign(unregister, {
				ready: publicationCount === 2 ? failedPublication.promise : Promise.resolve(),
			});
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		describedDaemon = olderDaemon;
		const olderReplacement = executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "wake",
		});
		await olderPublicationStarted.promise;

		describedDaemon = newerDaemon;
		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const winner = harness.getSubscription();
		const winnerSink = harness.getOutputSink();
		if (!winner || !winnerSink) throw new Error("Expected newer output registration");

		failedPublication.reject(new Error("older publication failed"));
		await expect(olderReplacement).rejects.toThrow("older publication failed");

		expect(harness.getSubscription()).toBe(winner);
		expect(winner.daemonId).toBe(newerDaemon.id);
		expect(harness.registrationCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: winner.id, delivery: "wake", active: true });
		await winnerSink({
			event: "daemon-output",
			monitorId: winner.id,
			name: daemon.name,
			daemonId: newerDaemon.id,
			seq: 1,
			text: "newer output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress).toEqual([
			expect.objectContaining({
				delivery: "wake",
				notification: expect.objectContaining({ text: "newer output" }),
			}),
		]);
	});

	it("detaches with progress off without stopping the process", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		const detached = await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "off" });
		const alreadyDetached = await executeLaunch(harness.session, {
			op: "monitor",
			name: daemon.name,
			progress: "off",
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.requests.map(operation => operation.op)).toEqual(["ping", "describe", "describe", "describe"]);
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(detached.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Stopped monitoring web:") }),
		]);
		expect(alreadyDetached.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("No active monitor for web:") }),
		]);
	});

	it("keeps monitoring attached when an off request fails validation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		vi.spyOn(harness.client, "request").mockRejectedValue(new Error("broker unavailable"));
		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "off" }),
		).rejects.toThrow("broker unavailable");

		expect(harness.unregisterCount()).toBe(0);
		expect(harness.getOutputSink()).toBeDefined();
		expect(harness.active.at(-1)?.active).toBe(true);
	});

	it("rejects a broker that cannot provide recoverable raw monitor output", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockResolvedValue({
			op: "ping",
			projectDir: process.cwd(),
			capabilities: ["output-monitor-v1"],
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" }),
		).rejects.toThrow("restart it with this omp build");
		// The capability check fails before the attach, so no subscription was
		// ever registered and no monitor state was touched.
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.active).toHaveLength(0);
	});

	it("does not resurrect wake state when terminal cleanup races a retune", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			await sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
			});
			throw new Error("process exited during retune");
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" }),
		).rejects.toThrow("process exited during retune");

		expect(harness.unregisterCount()).toBe(1);
		// The retune fails before its registration exists, so the last state
		// change is the terminal cleanup of the original wake monitor - never
		// a resurrected active entry.
		expect(harness.active.at(-1)).toEqual({
			monitorId: subscription.id,
			delivery: "wake",
			active: false,
		});
	});

	it("session disposal removes monitoring but leaves process lifecycle untouched", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		expect(harness.disposeCallbacks).toHaveLength(2);
		for (const dispose of harness.disposeCallbacks) dispose();

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
		// The process outlives the CLI and its owner can reconnect: completions
		// stay retained for that replay.
		expect(harness.completionPreservePending).toEqual([true]);
	});

	it("a same-ID context reset disposes the monitor and discards its pending completions", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		const cleanups = [...harness.contextBoundaryCallbacks];
		if (!subscription || cleanups.length === 0) throw new Error("Expected context-bound output registration");
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "before reset",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => item.notification.text)).toEqual(["before reset"]);

		for (const cleanup of cleanups) cleanup("reset");
		// Idempotent: a second boundary cannot release anything twice.
		for (const cleanup of cleanups) cleanup("reset");

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.getCompletionSink()).toBeUndefined();
		// The conversation that started the process is gone under the same id: a
		// retained completion would replay into the emptied context the next
		// time a Hub call re-registers this owner, so it is discarded instead.
		expect(harness.completionPreservePending).toEqual([false]);
		expect(harness.contextBoundaryCallbacks.size).toBe(0);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
	});

	it("a committed session switch disposes the monitor but keeps its completions replayable", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");

		// Each cleanup deletes itself from the set; removing the current entry
		// during Set iteration is well-defined.
		for (const cleanup of harness.contextBoundaryCallbacks) cleanup("switch");

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.getCompletionSink()).toBeUndefined();
		// The outgoing session stays resumable, so the broker keeps the
		// completion for the owner's next registration.
		expect(harness.completionPreservePending).toEqual([true]);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "ambient", active: false });
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
	});

	it("terminal monitor notification cleans up without duplicating owner completion", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([]);
	});

	it("incarnation expiry deactivates the monitor without attributing replacement completion", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		expect(subscription.daemonId).toBe(daemon.id);
		await harness.getOutputSink()?.({
			event: "daemon-monitor-expired",
			monitorId: subscription.id,
			name: daemon.name,
			daemonId: daemon.id,
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([]);
	});

	it("suppresses the synthesized completion when the broker confirmed the owner was notified", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
			ownerNotified: true,
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([]);
	});

	it("delivers a terminal completion when a stop bypassed the owner notification", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		if (!subscription) throw new Error("Expected output subscription");
		// Another client stopped the daemon: the broker skipped the owner
		// completion (stopRequested) and this monitor notification is the only
		// terminal signal the owning session will ever receive.
		const stopped: DaemonSnapshot = { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 143 };
		await harness.getOutputSink()?.({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: stopped,
			ownerNotified: false,
		});

		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: false });
		expect(harness.completions).toEqual([
			{
				event: "daemon-completed",
				completionId: `monitor:${subscription.id}:${stopped.id}:3`,
				owner: OWNER,
				daemon: stopped,
			},
		]);
	});

	it("suppresses the synthesized completion when the monitoring session stopped the process itself", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const stopped: DaemonSnapshot = { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 143 };
		let terminalDelivery: Promise<void> | undefined;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			if (operation.op !== "stop") throw new Error(`Unexpected operation: ${operation.op}`);
			// A terminal monitor notification can race ahead of the stop RPC
			// response. Its delivery must wait for the response to establish that
			// the tool result is already the authoritative terminal surface.
			const subscription = harness.getSubscription();
			const sink = harness.getOutputSink();
			if (!subscription || !sink) throw new Error("Expected output subscription");
			terminalDelivery = Promise.resolve(
				sink({
					event: "daemon-monitor-completed",
					monitorId: subscription.id,
					daemon: stopped,
					ownerNotified: false,
				}),
			);
			return { op: "stop", daemon: stopped };
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const result = await executeLaunch(harness.session, { op: "stop", name: daemon.name, timeout: 1 });
		await terminalDelivery;

		// The in-flight stop call's own result is the single terminal surface.
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.completions).toEqual([]);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Stopped") }),
		]);
	});

	it.each(["exited", "failed"] as const)(
		"surfaces one %s completion when the local stop response is still nonterminal",
		async state => {
			const harness = createHarness();
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
			const stopping: DaemonSnapshot = { ...daemon, state: "stopping" };
			const settled: DaemonSnapshot =
				state === "exited"
					? { ...daemon, state, pid: undefined, exitedAt: 3, exitCode: 143 }
					: { ...daemon, state, pid: undefined, exitedAt: 3, exitReason: "stop timed out" };
			let terminalDelivery: Promise<void> | undefined;
			vi.spyOn(harness.client, "request").mockImplementation(async operation => {
				if (operation.op === "ping") {
					return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
				}
				if (operation.op === "describe") return { op: "describe", daemon, spec };
				if (operation.op !== "stop") throw new Error(`Unexpected operation: ${operation.op}`);
				const subscription = harness.getSubscription();
				const sink = harness.getOutputSink();
				if (!subscription || !sink) throw new Error("Expected output subscription");
				terminalDelivery = Promise.resolve(
					sink({
						event: "daemon-monitor-completed",
						monitorId: subscription.id,
						daemon: settled,
						ownerNotified: false,
					}),
				);
				return { op: "stop", daemon: stopping };
			});

			await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
			await executeLaunch(harness.session, { op: "stop", name: daemon.name, timeout: 1 });
			await terminalDelivery;

			const subscription = harness.getSubscription();
			expect(subscription).toBeUndefined();
			expect(harness.unregisterCount()).toBe(1);
			expect(harness.completions).toEqual([
				{
					event: "daemon-completed",
					completionId: expect.stringContaining(`:${settled.id}:3`),
					owner: OWNER,
					daemon: settled,
				},
			]);
		},
	);

	it("does not let a failed local stop suppress later monitor completion", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			if (operation.op === "stop") throw new Error("stop transport failed");
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		await expect(executeLaunch(harness.session, { op: "stop", name: daemon.name, timeout: 1 })).rejects.toThrow(
			"stop transport failed",
		);
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		const settled: DaemonSnapshot = {
			...daemon,
			state: "failed",
			pid: undefined,
			exitedAt: 4,
			exitReason: "later failure",
		};
		await sink({
			event: "daemon-monitor-completed",
			monitorId: subscription.id,
			daemon: settled,
			ownerNotified: false,
		});

		expect(harness.completions).toEqual([
			{
				event: "daemon-completed",
				completionId: `monitor:${subscription.id}:${settled.id}:4`,
				owner: OWNER,
				daemon: settled,
			},
		]);
	});

	it("buffers speculative progress until the start is retained, then flushes it", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			// The subscription advertised ahead of the start request is marked
			// start-pending so the broker defers stale terminal replay.
			expect(harness.getSubscription()?.startPending).toBeTrue();
			const subscription = harness.getSubscription();
			if (!subscription) throw new Error("Expected output subscription");
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "early",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			// Still speculative: nothing may wake the session before validation.
			expect(harness.progress).toEqual([]);
			return { op: "start", daemon, readyTimedOut: false };
		});

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		await drainMicrotasks();

		expect(harness.progress.map(item => item.notification.text)).toEqual(["early"]);
		expect(harness.getSubscription()?.startPending).toBeUndefined();
		expect(harness.unregisterCount()).toBe(0);
	});

	it("reports a started process whose monitor expired during the start instead of claiming live progress", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const subscription = harness.getSubscription();
			const sink = harness.getOutputSink();
			if (!subscription || !sink) throw new Error("Expected output subscription");
			// The broker could not persist the output artifact: it buffers early
			// output followed by an expiry while the start RPC is still pending.
			await sink({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "early",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			await sink({
				event: "daemon-monitor-expired",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
			});
			return { op: "start", daemon, readyTimedOut: false };
		});

		const result = await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		await drainMicrotasks();

		// The process did start: the call succeeds and the pre-expiry output is not lost.
		expect(result.isError).toBeUndefined();
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")[0]).toMatch(/^Started web/);
		expect(text).toMatch(
			/Progress monitoring for web stopped: the broker disabled the monitor .*\. Read its output with logs \(follow: true\)\./,
		);
		expect(result.details).toMatchObject({ op: "start", monitoring: "off" });
		expect(result.details?.monitorStopped).toMatch(/broker disabled the monitor/);
		expect(harness.progress.map(item => item.notification.text)).toEqual(["early"]);
		// No live monitor state survives: subscription torn down and the session told.
		expect(harness.registrationCount()).toBe(0);
		expect(harness.getSubscription()).toBeUndefined();
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: expect.any(String), delivery: "wake", active: false });
		expect(harness.requests.some(operation => operation.op === "stop")).toBeFalse();
	});

	it("reports the delivery mode of a start whose monitor stays live", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		const result = await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "ambient",
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("Progress monitoring");
		expect(result.details).toMatchObject({ op: "start", monitoring: "ambient" });
		expect(result.details?.monitorStopped).toBeUndefined();
		expect(harness.registrationCount()).toBe(1);
		expect(harness.active.at(-1)).toEqual({ monitorId: expect.any(String), delivery: "ambient", active: true });
	});

	it("bounds and coalesces speculative progress during a delayed monitored start", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const order: string[] = [];
		let deliveredProgress: Extract<DaemonMonitorNotification, { event: "daemon-output" }> | undefined;
		let deliveredTerminal: DaemonCompletionNotification | undefined;
		vi.spyOn(harness.session, "queueLaunchProgress").mockImplementation(notification => {
			deliveredProgress = notification;
			order.push("progress");
		});
		vi.spyOn(harness.session, "queueLaunchCompletion").mockImplementation(notification => {
			deliveredTerminal = notification;
			order.push(`terminal:${notification.daemon.state}`);
			return Promise.resolve();
		});
		const startBuffered = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const exited: DaemonSnapshot = {
			...daemon,
			state: "exited",
			pid: undefined,
			exitedAt: 3,
			exitCode: 0,
		};
		const batchCount = 32;
		const progressText = Array.from({ length: batchCount }, (_, index) => {
			let marker = `EVENT_${index}`;
			if (index === 0) marker = "FIRST";
			else if (index === 16) marker = "MIDDLE";
			else if (index === batchCount - 1) marker = "LAST";
			return `${marker}:${"x".repeat(220)}`;
		});
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const subscription = harness.getSubscription();
			const sink = harness.getOutputSink();
			if (!subscription || !sink) throw new Error("Expected output subscription");
			for (const [index, text] of progressText.entries()) {
				await sink({
					event: "daemon-output",
					monitorId: subscription.id,
					name: daemon.name,
					daemonId: daemon.id,
					seq: index + 1,
					text,
					batchKind: "progress",
					suppressedEvents: 1,
				});
			}
			await sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: exited,
				ownerNotified: false,
			});
			startBuffered.resolve();
			await releaseStart.promise;
			return { op: "start", daemon: exited, readyTimedOut: false };
		});

		const launch = executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		}).then(result => {
			order.push("resolved");
			return result;
		});
		await startBuffered.promise;
		expect(order).toEqual([]);

		releaseStart.resolve();
		await launch;

		expect(order).toEqual(["progress", "terminal:exited", "resolved"]);
		expect(Buffer.byteLength(deliveredProgress?.text ?? "", "utf8")).toBeLessThanOrEqual(
			PROGRESS_LIMITS.PREVIEW_BYTES,
		);
		expect(deliveredProgress).toMatchObject({
			seq: batchCount,
			suppressedEvents: batchCount,
			truncated: true,
		});
		expect(deliveredProgress?.text).toContain("FIRST:");
		expect(deliveredProgress?.text).not.toContain("MIDDLE:");
		expect(deliveredProgress?.text).toContain("LAST:");
		expect(deliveredTerminal?.daemon).toMatchObject({ state: "exited", exitCode: 0 });
		expect(harness.unregisterCount()).toBe(1);
	});

	it("discards coalesced speculative progress and terminal completion when the start fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const subscription = harness.getSubscription();
			const sink = harness.getOutputSink();
			if (!subscription || !sink) throw new Error("Expected output subscription");
			// An already-running process emits throughout the validation window,
			// including a terminal signal, before the broker rejects the start.
			for (let index = 0; index < 32; index++) {
				await sink({
					event: "daemon-output",
					monitorId: subscription.id,
					name: daemon.name,
					daemonId: daemon.id,
					seq: index + 1,
					text: `leaked-${index}:${"x".repeat(220)}`,
					batchKind: "progress",
					suppressedEvents: 1,
				});
			}
			await sink({
				event: "daemon-monitor-completed",
				monitorId: subscription.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
				ownerNotified: false,
			});
			throw new Error(`Daemon ${daemon.name} is already running`);
		});

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			}),
		).rejects.toThrow("already running");
		await drainMicrotasks();

		expect(harness.progress).toEqual([]);
		expect(harness.completions).toEqual([]);
		expect(harness.unregisterCount()).toBe(1);
		expect(harness.active.at(-1)?.active).toBe(false);
	});

	it("does not mark monitor-op subscriptions as start-pending", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });

		expect(harness.getSubscription()?.startPending).toBeUndefined();
	});

	it("replaces a stale registration when a monitored start reuses the name", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const stale = harness.getSubscription();
		if (!stale) throw new Error("Expected output subscription");

		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			// The start must advertise a fresh start-pending subscription — never
			// the stale one — so the broker cannot replay the old daemon's
			// terminal notification and tear the monitor down before launch.
			const advertised = harness.getSubscription();
			expect(advertised?.id).not.toBe(stale.id);
			expect(advertised?.startPending).toBeTrue();
			return { op: "start", daemon, readyTimedOut: false };
		});

		await executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		await drainMicrotasks();

		// The stale registration was torn down; the new one carries the start.
		expect(harness.unregisterCount()).toBe(1);
		const replacement = harness.getSubscription();
		if (!replacement) throw new Error("Expected replacement subscription");
		expect(replacement.startPending).toBeUndefined();
		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: replacement.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "fresh output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => ({ text: item.notification.text, delivery: item.delivery }))).toEqual([
			{ text: "fresh output", delivery: "wake" },
		]);
		expect(harness.active.at(-1)).toEqual({ monitorId: replacement.id, delivery: "wake", active: true });
	});

	it("restores the prior monitor mode when a replacement start fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const prior = harness.getSubscription();
		if (!prior) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			const advertised = harness.getSubscription();
			if (!advertised) throw new Error("Expected output subscription");
			expect(advertised.id).not.toBe(prior.id);
			// Output emitted while the failing start is still validating belongs
			// only to the speculative replacement and must be discarded.
			await harness.getOutputSink()?.({
				event: "daemon-output",
				monitorId: advertised.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "speculative",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			throw new Error(`Daemon ${daemon.name} is already running`);
		});

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			}),
		).rejects.toThrow("already running");
		await drainMicrotasks();

		const restored = harness.getSubscription();
		if (!restored) throw new Error("Expected restored output subscription");
		expect(restored.id).not.toBe(prior.id);
		expect(restored.startPending).toBeUndefined();
		expect(harness.progress).toEqual([]);
		expect(harness.active.at(-1)).toEqual({ monitorId: restored.id, delivery: "ambient", active: true });

		await harness.getOutputSink()?.({
			event: "daemon-output",
			monitorId: restored.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "still monitored",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => ({ text: item.notification.text, delivery: item.delivery }))).toEqual([
			{ text: "still monitored", delivery: "ambient" },
		]);
		expect(harness.unregisterCount()).toBe(2);
	});

	it("preserves the launch failure when restoring the prior monitor also fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		let allocationCount = 0;
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(async () => {
			allocationCount++;
			if (allocationCount === 3) throw new Error("restore failed");
			return {
				id: `hub-progress-${allocationCount}`,
				path: path.join(process.cwd(), `.hub-progress-${allocationCount}.log`),
			};
		});

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "start") throw new Error(`Daemon ${daemon.name} is already running`);
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		await expect(
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			}),
		).rejects.toThrow("already running");
		expect(allocationCount).toBe(3);
	});

	it("restores start-pending state when an overlapping replacement start fails", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);
		const firstStartEntered = Promise.withResolvers<void>();
		const releaseFirstStart = Promise.withResolvers<void>();
		let startCount = 0;
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			startCount++;
			if (startCount === 1) {
				firstStartEntered.resolve();
				await releaseFirstStart.promise;
				return { op: "start", daemon, readyTimedOut: false };
			}
			throw new Error(`Daemon ${daemon.name} is already running`);
		});
		const start = () =>
			executeLaunch(harness.session, {
				op: "start",
				name: daemon.name,
				application: process.execPath,
				pty: false,
				persist: true,
				progress: "wake",
			});

		const first = start();
		await firstStartEntered.promise;
		await expect(start()).rejects.toThrow("already running");
		const restored = harness.getSubscription();
		expect(restored?.startPending).toBeTrue();

		releaseFirstStart.resolve();
		await first;
		const sink = harness.getOutputSink();
		if (!restored || !sink) throw new Error("Expected restored output subscription");
		await sink({
			event: "daemon-output",
			monitorId: restored.id,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "first-start-output",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(harness.progress.map(item => item.notification.text)).toEqual(["first-start-output"]);
	});

	it("does not restore a monitor that completed during replacement artifact allocation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" });
		const prior = harness.getSubscription();
		const priorSink = harness.getOutputSink();
		if (!prior || !priorSink) throw new Error("Expected output subscription");

		const allocationStarted = Promise.withResolvers<void>();
		const artifact = Promise.withResolvers<{ id: string; path: string }>();
		vi.spyOn(harness.session, "allocateOutputArtifact").mockImplementation(() => {
			allocationStarted.resolve();
			return artifact.promise;
		});
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			if (operation.op === "start") throw new Error(`Daemon ${daemon.name} is already running`);
			throw new Error(`Unexpected operation: ${operation.op}`);
		});

		const replacement = executeLaunch(harness.session, {
			op: "start",
			name: daemon.name,
			application: process.execPath,
			pty: false,
			persist: true,
			progress: "wake",
		});
		const settlement = replacement.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await allocationStarted.promise;
		try {
			await priorSink({
				event: "daemon-monitor-completed",
				monitorId: prior.id,
				daemon: { ...daemon, state: "exited", pid: undefined, exitedAt: 3, exitCode: 0 },
				ownerNotified: false,
			});
		} finally {
			artifact.resolve({
				id: `hub-progress-${crypto.randomUUID()}`,
				path: path.join(process.cwd(), `.hub-progress-${crypto.randomUUID()}.log`),
			});
		}

		expect(await settlement).toEqual({
			ok: false,
			error: expect.objectContaining({ message: expect.stringContaining("already running") }),
		});
		await drainMicrotasks();

		expect(harness.completions).toHaveLength(1);
		expect(harness.registrationCount()).toBe(0);
		expect(harness.getOutputSink()).toBeUndefined();
		expect(harness.active.at(-1)?.active).toBeFalse();
	});

	it("keeps the prior delivery mode when a monitor retune fails validation", async () => {
		const harness = createHarness();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(harness.client);

		await executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "wake" });
		const subscription = harness.getSubscription();
		const sink = harness.getOutputSink();
		if (!subscription || !sink) throw new Error("Expected output subscription");
		vi.spyOn(harness.client, "request").mockImplementation(async operation => {
			if (operation.op === "ping") {
				return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			}
			// Output arrives while the retune is still validating, then the
			// describe fails: it must have been delivered under the prior mode.
			await sink({
				event: "daemon-output",
				monitorId: subscription.id,
				name: daemon.name,
				daemonId: daemon.id,
				seq: 1,
				text: "mid-retune",
				batchKind: "progress",
				suppressedEvents: 0,
			});
			throw new Error("broker unavailable");
		});

		await expect(
			executeLaunch(harness.session, { op: "monitor", name: daemon.name, progress: "ambient" }),
		).rejects.toThrow("broker unavailable");

		expect(harness.progress.map(item => item.delivery)).toEqual(["wake"]);
		expect(harness.unregisterCount()).toBe(0);
		expect(harness.active.at(-1)).toEqual({ monitorId: subscription.id, delivery: "wake", active: true });
	});
});

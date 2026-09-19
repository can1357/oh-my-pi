import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { Settings } from "../../src/config/settings";
import * as daemonClient from "../../src/launch/client";
import type { DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_OUTPUT_MONITOR_CAPABILITY,
	type DaemonCompletionNotification,
	type DaemonMonitorNotification,
	type DaemonOutputSubscription,
	type DaemonRpcResult,
} from "../../src/launch/protocol";
import {
	hasLiveOwnedService,
	listServices,
	monitorService,
	serviceLogsWithRows,
	startService,
	stopService,
	waitForOwnedServiceCompletion,
} from "../../src/launch/services";
import type { LaunchContextBoundary, ToolSession } from "../../src/tools";

const OWNER = "service-owner";
const daemon: DaemonSnapshot = {
	name: "web", id: "old-id", state: "running", createdAt: 1, startedAt: 1,
	restartCount: 0, outputBytes: 0, owner: OWNER, persist: false, detached: false,
};
const spec: DaemonSpec = {
	name: daemon.name, application: process.execPath, args: [], cwd: process.cwd(),
	env: {}, pty: false, restart: "no", persist: false, detached: false,
};
function completed(snapshot = daemon): DaemonCompletionNotification {
	return {
		event: "daemon-completed", completionId: `completed-${snapshot.id}`, owner: OWNER,
		daemon: { ...snapshot, state: "exited", exitedAt: 3, exitCode: 0 },
	};
}

function fixture() {
	let epoch = 11;
	let owner = OWNER;
	let completionSink: ((notification: DaemonCompletionNotification) => void | Promise<void>) | undefined;
	let outputSink: ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
	let subscription: DaemonOutputSubscription | undefined;
	const boundaries = new Set<(boundary: LaunchContextBoundary) => void>();
	const disposals = new Set<() => void>();
	const preserved: boolean[] = [];
	const queued: Array<{ id: string; epoch: number | undefined }> = [];
	const progress: string[] = [];
	const client: DaemonBrokerClient = {
		projectDir: process.cwd(),
		onCompletion: (_owner, sink) => {
			completionSink = sink;
			return options => {
				preserved.push(options?.preservePending === true);
				if (completionSink === sink) completionSink = undefined;
			};
		},
		onOutput: (registered, sink) => {
			subscription = registered;
			outputSink = sink;
			return Object.assign(() => {
				if (outputSink === sink) outputSink = undefined;
				if (subscription === registered) subscription = undefined;
			}, { ready: Promise.resolve(), republish() {} });
		},
		request: async operation => {
			if (operation.op === "ping") return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
			if (operation.op === "start") return { op: "start", daemon: { ...daemon, name: operation.spec.name }, readyTimedOut: false };
			if (operation.op === "list") return { op: "list", daemons: [daemon] };
			if (operation.op === "describe") return { op: "describe", daemon, spec };
			if (operation.op === "stop") return { op: "stop", daemon: completed().daemon };
			if (operation.op === "logs") return { op: "logs", name: daemon.name, text: "ready", cursor: 5, timedOut: false, state: "running" };
			throw new Error(`Unexpected operation: ${operation.op}`);
		},
		close() {},
	};
	const session: ToolSession = {
		cwd: process.cwd(), hasUI: false, settings: Settings.isolated(), processProgressMode: "session",
		getSessionFile: () => null, getSessionSpawns: () => "*", getSessionId: () => owner,
		captureLaunchProgressEpoch: () => epoch,
		allocateOutputArtifact: async () => ({ id: "service-progress", path: "/tmp/service-epoch-progress.log" }),
		queueLaunchProgress: notification => { progress.push(notification.text); },
		queueLaunchCompletion: async (notification, capturedEpoch) => { queued.push({ id: notification.daemon.id, epoch: capturedEpoch }); },
		registerContextBoundaryCallback: callback => {
			boundaries.add(callback);
			return () => { boundaries.delete(callback); };
		},
		registerDisposeCallback: callback => {
			disposals.add(callback);
			return () => { disposals.delete(callback); };
		},
	};
	vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
	return {
		client, session, queued, progress, preserved, boundaries, disposals,
		advance: () => { epoch++; },
		changeOwner: () => { owner = "other-session"; epoch++; },
		boundary: (boundary: LaunchContextBoundary) => {
			epoch++;
			for (const callback of [...boundaries]) callback(boundary);
		},
		sink: () => {
			if (!completionSink) throw new Error("No completion sink");
			return completionSink;
		},
		output: () => {
			if (!outputSink || !subscription) throw new Error("No output sink");
			return { sink: outputSink, subscription };
		},
	};
}

afterEach(() => { vi.restoreAllMocks(); });

describe("service operation epochs and completion replay", () => {
	it.each(["list", "logs", "stop"] as const)("restores the owner sink before resumed %s requests", async operation => {
		const f = fixture();
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			await f.sink()(completed());
			return request(...args);
		});
		if (operation === "list") await listServices(f.session);
		else if (operation === "logs") await serviceLogsWithRows(f.session, daemon.name);
		else await stopService(f.session, daemon.name);
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 11 }]);
	});

	it("retains replay even when listing finds no live service", async () => {
		const f = fixture();
		vi.spyOn(f.client, "request").mockResolvedValue({ op: "list", daemons: [] });
		await listServices(f.session);
		await f.sink()(completed());
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 11 }]);
		for (const dispose of [...f.disposals]) dispose();
		expect(f.preserved).toEqual([true]);
	});

	it.each(["reset", "switch", "new"] as const)("cleans up once and applies %s replay policy", async boundary => {
		const f = fixture();
		await startService(f.session, { name: daemon.name, command: "echo ready" });
		const callbacks = [...f.boundaries];
		const oldSink = f.sink();
		const finished = waitForOwnedServiceCompletion(f.session);
		f.boundary(boundary);
		for (const callback of callbacks) callback(boundary);
		await finished;
		expect(hasLiveOwnedService(f.session)).toBe(false);
		expect(f.preserved).toEqual([boundary !== "reset"]);
		if (boundary === "reset") await oldSink(completed());
		else await expect(Promise.resolve().then(() => oldSink(completed()))).rejects.toThrow("disposed");
		expect(f.queued).toEqual([]);
	});

	it("keeps old incarnations stale after reset re-registers the same owner", async () => {
		const f = fixture();
		await startService(f.session, { name: daemon.name, command: "echo old" });
		f.boundary("reset");
		await listServices(f.session);
		await f.sink()(completed());
		const fresh = { ...daemon, id: "fresh-after-reset", startedAt: 2 };
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			if (args[0].op === "start") return { op: "start", daemon: fresh, readyTimedOut: false };
			return request(...args);
		});
		await startService(f.session, { name: daemon.name, command: "echo fresh" });
		await f.sink()(completed(fresh));
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 11 }, { id: fresh.id, epoch: 12 }]);
	});

	it.each(["switch", "new", "dispose"] as const)("releases reset provenance on a later %s without a service call in between", async boundary => {
		const f = fixture();
		await startService(f.session, { name: daemon.name, command: "echo old" });
		f.boundary("reset");
		if (boundary === "dispose") {
			for (const dispose of [...f.disposals]) dispose();
			f.advance();
		} else f.boundary(boundary);
		await listServices(f.session);
		await f.sink()(completed());
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 13 }]);
	});

	it("keeps the initiating epoch if the ToolSession changes before completion", async () => {
		const f = fixture();
		await startService(f.session, { name: daemon.name, command: "echo ready" });
		f.changeOwner();
		await f.sink()(completed());
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 11 }]);
		for (const dispose of [...f.disposals]) dispose();
		expect(f.preserved).toEqual([true]);
	});

	it("does not launch or subscribe in a new context after broker acquisition crosses reset", async () => {
		const f = fixture();
		const acquired = Promise.withResolvers<DaemonBrokerClient>();
		vi.spyOn(daemonClient, "daemonClientForProject").mockReturnValue(acquired.promise);
		const request = vi.spyOn(f.client, "request");
		const starting = startService(f.session, { name: daemon.name, command: "echo ready" });
		f.boundary("reset");
		acquired.resolve(f.client);
		await expect(starting).rejects.toThrow("context changed");
		expect(request).not.toHaveBeenCalled();
		expect(() => f.sink()).toThrow("No completion sink");
	});

	it.each(["ping", "describe"] as const)("does not attach a monitor after reset during %s", async phase => {
		const f = fixture();
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			const result = await request(...args);
			if (args[0].op === phase) f.boundary("reset");
			return result;
		});
		await expect(monitorService(f.session, daemon.name, "wake")).rejects.toThrow("context changed");
		expect(() => f.output()).toThrow("No output sink");
		expect(f.queued).toEqual([]);
		expect(f.progress).toEqual([]);
	});

	it("drops a pending start completion and ownership after reset before the response", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<DaemonRpcResult>();
		vi.spyOn(f.client, "request").mockImplementation(async operation => {
			if (operation.op !== "start") throw new Error(`Unexpected operation: ${operation.op}`);
			entered.resolve();
			return response.promise;
		});
		const starting = startService(f.session, { name: daemon.name, command: "echo ready" });
		await entered.promise;
		const delivery = f.sink()(completed());
		f.boundary("reset");
		response.resolve({ op: "start", daemon, readyTimedOut: false });
		await starting;
		await delivery;
		expect(f.queued).toEqual([]);
		expect(hasLiveOwnedService(f.session)).toBe(false);
		expect(f.preserved).toEqual([false]);
		expect(() => f.sink()).toThrow("No completion sink");
	});

	it("correlates an early completion without waiting for its receipt inside the start RPC", async () => {
		const f = fixture();
		const receipt = Promise.withResolvers<void>();
		vi.spyOn(f.session, "queueLaunchCompletion").mockImplementation(() => receipt.promise);
		let delivery: void | Promise<void> = undefined;
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			if (args[0].op === "start") delivery = f.sink()(completed());
			return request(...args);
		});
		await startService(f.session, { name: daemon.name, command: "echo ready" });
		expect(hasLiveOwnedService(f.session)).toBe(false);
		receipt.resolve();
		await delivery;
	});

	it("keeps an old replay off a pending replacement start binding", async () => {
		const f = fixture();
		await startService(f.session, { name: daemon.name, command: "echo ready" });
		f.advance();
		const fresh = { ...daemon, id: "fresh-id", startedAt: 2 };
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<DaemonRpcResult>();
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			if (args[0].op !== "start") return request(...args);
			entered.resolve();
			return response.promise;
		});
		const starting = startService(f.session, { name: daemon.name, command: "echo replacement" });
		await entered.promise;
		const replay = f.sink()(completed({ ...daemon, id: "older-replay-id" }));
		response.resolve({ op: "start", daemon: fresh, readyTimedOut: false });
		await starting;
		await replay;
		await f.sink()(completed(fresh));
		expect(f.queued).toEqual([{ id: "older-replay-id", epoch: 11 }, { id: fresh.id, epoch: 12 }]);
	});

	it.each(["local", "rejected"] as const)("does not leave bindings behind after %s start failures", async failure => {
		const f = fixture();
		await listServices(f.session);
		vi.spyOn(f.client, "request").mockImplementation(async (_operation, _signal, onDispatch) => {
			if (failure === "rejected") {
				onDispatch?.("written");
				throw new daemonClient.DaemonBrokerRejectedError("broker rejected start");
			}
			throw new Error("socket failed before write");
		});
		for (let index = 0; index < 3; index++) {
			f.advance();
			await expect(startService(f.session, { name: "lost", command: "echo ready" })).rejects.toThrow();
		}
		await f.sink()(completed({ ...daemon, name: "lost", id: "unrelated" }));
		expect(f.queued).toEqual([{ id: "unrelated", epoch: 11 }]);
	});

	it("preserves a written replacement's epoch past the old completion and consumes it only once", async () => {
		const f = fixture();
		await listServices(f.session);
		f.advance();
		vi.spyOn(f.client, "request").mockImplementation(async (_operation, _signal, onDispatch) => {
			onDispatch?.("written");
			throw new Error("Broker accepted start but response was lost");
		});
		await expect(startService(f.session, { name: daemon.name, command: "echo ready" })).rejects.toThrow("response was lost");
		await f.sink()(completed());
		await f.sink()(completed({ ...daemon, id: "fresh-id" }));
		await f.sink()(completed({ ...daemon, id: "unrelated-id" }));
		expect(f.queued).toEqual([
			{ id: daemon.id, epoch: 11 }, { id: "fresh-id", epoch: 12 }, { id: "unrelated-id", epoch: 11 },
		]);
	});

	it("keeps a sibling's accepted start subscribed when another start fails", async () => {
		const f = fixture();
		const rejected = Promise.withResolvers<DaemonRpcResult>();
		const accepted = Promise.withResolvers<DaemonRpcResult>();
		const entered = Promise.withResolvers<void>();
		let count = 0;
		const request = f.client.request;
		vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
			if (args[0].op !== "start") return request(...args);
			if (++count === 2) entered.resolve();
			return args[0].spec.name === "first" ? rejected.promise : accepted.promise;
		});
		const first = startService(f.session, { name: "first", command: "echo first" });
		const firstOutcome = first.catch(error => error);
		const second = startService(f.session, { name: "second", command: "echo second" });
		await entered.promise;
		rejected.reject(new daemonClient.DaemonBrokerRejectedError("rejected"));
		expect(await firstOutcome).toBeInstanceOf(daemonClient.DaemonBrokerRejectedError);
		const fresh = { ...daemon, name: "second", id: "second-id" };
		accepted.resolve({ op: "start", daemon: fresh, readyTimedOut: false });
		await second;
		await f.sink()(completed(fresh));
		expect(f.queued).toEqual([{ id: fresh.id, epoch: 11 }]);
		expect(f.preserved).toEqual([]);
	});

	it("keeps replay subscribed after a rejected resumed operation", async () => {
		const f = fixture();
		vi.spyOn(f.client, "request").mockRejectedValue(new daemonClient.DaemonBrokerRejectedError("not found"));
		await expect(serviceLogsWithRows(f.session, "misspelled")).rejects.toThrow("not found");
		await f.sink()(completed());
		expect(f.queued).toEqual([{ id: daemon.id, epoch: 11 }]);
	});
});

describe("legacy broker log compatibility", () => {
	it("renders raw terminal text from an already-running broker", async () => {
		const f = fixture();
		vi.spyOn(f.client, "request").mockResolvedValue({
			op: "logs", name: daemon.name, text: "ready", terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
			cursor: 42, timedOut: false, state: "running",
		});
		const result = await serviceLogsWithRows(f.session, daemon.name);
		expect(result.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
	});

	it("keeps sanitized logs when optional terminal replay fails", async () => {
		const f = fixture();
		vi.spyOn(f.client, "request").mockResolvedValue({
			op: "logs", name: daemon.name, text: "ready", terminalText: "raw", cursor: 42, timedOut: false, state: "running",
		});
		class CleanExitWorker extends EventTarget {
			postMessage(): void { this.dispatchEvent(new Event("close")); }
			terminate(): void {}
		}
		const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: CleanExitWorker });
		try {
			expect(await serviceLogsWithRows(f.session, daemon.name)).toEqual({ text: "ready" });
		} finally {
			if (original) Object.defineProperty(globalThis, "Worker", original);
			else Reflect.deleteProperty(globalThis, "Worker");
		}
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { CUSTOM_NOTIFICATION_METHOD, CUSTOM_NOTIFICATION_PAYLOAD } from "./fixtures/notifications-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "notifications-mcp.ts");
const BUN_EXEC = process.execPath;

type CapturedFrame = { server: string; method: string; params: unknown };

function serverConfig(): MCPServerConfig {
	return { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };
}

/**
 * Bind a capturing listener that ALSO exposes a promise-based await for a
 * specific `(server, method)` pair. Lets each test wait for the exact frame it
 * cares about without polling — the frame arriving is the real signal, not a
 * timer. bun:test's per-test timeout backstops a genuine hang.
 */
function makeFrameCollector(): {
	listener: (server: string, method: string, params: unknown) => void;
	frames: CapturedFrame[];
	awaitFrame: (server: string, method: string) => Promise<CapturedFrame>;
} {
	const frames: CapturedFrame[] = [];
	const waiters = new Map<string, Array<(frame: CapturedFrame) => void>>();
	const key = (server: string, method: string) => `${server}\x00${method}`;
	return {
		frames,
		listener: (server, method, params) => {
			const frame: CapturedFrame = { server, method, params };
			frames.push(frame);
			const bucket = waiters.get(key(server, method));
			if (bucket && bucket.length > 0) {
				waiters.delete(key(server, method));
				for (const resolve of bucket) resolve(frame);
			}
		},
		awaitFrame: (server, method) => {
			const existing = frames.find(f => f.server === server && f.method === method);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<CapturedFrame>();
			const bucket = waiters.get(key(server, method)) ?? [];
			bucket.push(resolve);
			waiters.set(key(server, method), bucket);
			return promise;
		},
	};
}

describe("MCPManager notification listeners", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-notif-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("delivers known and server-custom notifications to a registered listener", async () => {
		const manager = new MCPManager(workDir);
		const collector = makeFrameCollector();
		const unsubscribe = manager.addNotificationListener(collector.listener);
		expect(typeof unsubscribe).toBe("function");

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});

			// Await both the known list_changed and the server-custom frame
			// independently. Arrival order across the two isn't guaranteed
			// because list_changed triggers an internal `tools/list` refresh
			// that MCPManager awaits before fanout (so listeners see fresh
			// `getTools()`), which lets a non-refresh frame like the custom
			// one overtake in the same batch. Both MUST still be delivered;
			// that's the actual contract this test exercises.
			const [listChanged, custom] = await Promise.all([
				collector.awaitFrame("alpha", "notifications/tools/list_changed"),
				collector.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(custom.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(listChanged.method).toBe("notifications/tools/list_changed");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("dispatches to every listener and isolates handler errors", async () => {
		const manager = new MCPManager(workDir);
		const collectorA = makeFrameCollector();
		const collectorC = makeFrameCollector();

		manager.addNotificationListener(collectorA.listener);
		manager.addNotificationListener(() => {
			// Middle listener throws synchronously. Must NOT prevent the third
			// listener from being invoked for the same frame.
			throw new Error("listener-B intentionally throws");
		});
		manager.addNotificationListener(collectorC.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			const [frameA, frameC] = await Promise.all([
				collectorA.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
				collectorC.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(frameA.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(frameC.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("unsubscribe stops delivery to that listener without affecting others", async () => {
		const manager = new MCPManager(workDir);
		const early = makeFrameCollector();
		const late = makeFrameCollector();

		const unsubscribeEarly = manager.addNotificationListener(early.listener);

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			await early.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD);
			const earlyCountBeforeUnsub = early.frames.length;

			unsubscribeEarly();

			// Add a fresh listener AFTER unsub, then connect a second server so
			// the fixture emits a new batch. The unsubscribed listener must not
			// grow; the fresh listener must observe the fresh batch. Dispatch
			// per frame is synchronous over the listener set, so once `late`
			// resolves for a `beta` frame, any concurrent delivery to `early`
			// would have already happened had the unsubscribe not landed.
			manager.addNotificationListener(late.listener);
			await manager.connectServers({ beta: serverConfig() }, {});
			await late.awaitFrame("beta", CUSTOM_NOTIFICATION_METHOD);

			expect(early.frames.length).toBe(earlyCountBeforeUnsub);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("buffers notifications received before any listener attaches, drains into first subscriber", async () => {
		const manager = new MCPManager(workDir);

		try {
			// Connect FIRST, before any listener is registered. The fixture
			// emits `notifications/tools/list_changed` plus a server-custom
			// notification during its `notifications/initialized` handshake,
			// so by the time connect resolves at least one notification frame
			// has already been received by the manager with no consumer.
			await manager.connectServers({ alpha: serverConfig() }, {});

			// Attach the FIRST listener AFTER frames were already dispatched.
			// Drain-on-first-subscribe must deliver the buffered frames now.
			const collector = makeFrameCollector();
			manager.addNotificationListener(collector.listener);
			// Both the known list_changed and the server-custom frame must
			// have been buffered and drained on attach. Await each
			// independently — arrival order between refresh-triggering and
			// non-refresh frames is not guaranteed (see the delivery test
			// for rationale), but both are always delivered.
			const [listChanged, custom] = await Promise.all([
				collector.awaitFrame("alpha", "notifications/tools/list_changed"),
				collector.awaitFrame("alpha", CUSTOM_NOTIFICATION_METHOD),
			]);
			expect(custom.params).toEqual(CUSTOM_NOTIFICATION_PAYLOAD);
			expect(listChanged.method).toBe("notifications/tools/list_changed");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("refreshServerTools awaits an async setOnToolsChanged handler before resolving", async () => {
		// Verifies the second-layer guarantee (issue raised in review):
		// #onToolsChanged in the sdk.ts wiring calls session.refreshMCPTools()
		// asynchronously. If refreshServerTools does not await the callback,
		// a mcp_notification listener acting on tools/list_changed can call
		// getAllTools() on the session before its registry has been rebound.
		// This test drives the same pattern by registering a slow async
		// setOnToolsChanged handler and confirming refreshServerTools blocks
		// on it before resolving — proving the fanout in
		// #handleServerNotification (which awaits refreshServerTools) sees
		// the callback complete.
		const manager = new MCPManager(workDir);
		const events: string[] = [];
		const { promise: hold, resolve: release } = Promise.withResolvers<void>();

		manager.setOnToolsChanged(async () => {
			events.push("cb:start");
			await hold;
			events.push("cb:end");
		});

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			// connectServers may kick the callback for the initial tool load via
			// its background continuation; drain that first so we can assert
			// specifically on the refresh path.
			await Bun.sleep(30);
			release();
			await Bun.sleep(30);
			const priorLen = events.length;

			// Trigger a fresh refresh and hold the callback again — this is the
			// path #handleServerNotification takes for tools/list_changed.
			const { promise: hold2, resolve: release2 } = Promise.withResolvers<void>();
			let cbState: "started" | "ended" | undefined;
			manager.setOnToolsChanged(async () => {
				cbState = "started";
				await hold2;
				cbState = "ended";
			});
			const refreshDone = manager.refreshServerTools("alpha");
			// Give the callback time to enter the await.
			await Bun.sleep(20);
			expect(cbState).toBe("started");
			// refreshServerTools has NOT resolved yet — proves it's awaiting.
			let refreshResolved = false;
			void refreshDone.then(() => {
				refreshResolved = true;
			});
			await Bun.sleep(10);
			expect(refreshResolved).toBe(false);
			// Release the callback; refresh should now resolve promptly.
			release2();
			await refreshDone;
			expect(cbState).toBe("ended");
			// Drain events reference — just to silence unused var if refactored.
			expect(events.length).toBeGreaterThanOrEqual(priorLen);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("mcp_notification listener for tools/list_changed fires only AFTER setOnToolsChanged callback resolves", async () => {
		// Option B integration test: exercises the full manager-side chain
		// #handleServerNotification → refreshServerTools → #onToolsChanged
		// → fanout to notification listeners. Uses a slow async
		// setOnToolsChanged callback that gates on a controllable promise
		// (matches the mcp-dispose-disconnect-bounded.test.ts gate pattern)
		// to prove that if the SDK's setOnToolsChanged handler is async and
		// its work isn't complete, the mcp_notification listener does NOT
		// fire prematurely. Regression guard: catches any future refactor
		// that reintroduces fire-and-forget in the callback chain (e.g. the
		// original sdk.ts:3411 `void (async () => ...)()` wrapper — which
		// was the specific race raised in review of #6535).
		const manager = new MCPManager(workDir);
		const events: string[] = [];
		let cbCall = 0;
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();

		manager.setOnToolsChanged(async () => {
			cbCall++;
			// Initial connect fires the callback via a background continuation
			// (manager.ts line ~555, fire-and-forget). Return immediately so
			// its floating promise resolves cleanly; only gate on the second
			// call, which is the one our simulated post-connect notification
			// triggers.
			if (cbCall === 1) {
				events.push("initial-cb:done");
				return;
			}
			events.push("cb:start");
			await gate;
			events.push("cb:end");
		});

		manager.addNotificationListener((_server, method) => {
			if (method === "notifications/tools/list_changed") {
				events.push("listener:fire");
			}
		});

		try {
			await manager.connectServers({ alpha: serverConfig() }, {});
			// Wait for the initial-connect background continuation to fire the
			// callback (call #1, ungated). Once it's recorded, we know the
			// callback is idle and the next invocation will be call #2.
			for (let i = 0; i < 20 && !events.includes("initial-cb:done"); i++) {
				await Bun.sleep(10);
			}
			expect(events).toContain("initial-cb:done");

			// Simulate a post-connect `notifications/tools/list_changed` frame
			// by driving the transport's onNotification hook directly — that's
			// exactly what the transport does when a server pushes a
			// notification after startup. Bypasses the fixture's initial
			// handshake burst so we exercise the connectionKnown=true path
			// (where refresh actually runs and the callback is awaited).
			const conn = manager.getConnection("alpha");
			if (!conn?.transport.onNotification) throw new Error("expected transport onNotification to be wired");
			void conn.transport.onNotification("notifications/tools/list_changed", {});

			// Give the async chain time to enter the callback's await.
			for (let i = 0; i < 20 && !events.includes("cb:start"); i++) {
				await Bun.sleep(10);
			}
			expect(events).toContain("cb:start");

			// CRITICAL: at this point the callback is holding, and the
			// listener MUST NOT have fired. If it has, the manager fanned
			// out before awaiting the callback — the exact race this test
			// guards against.
			expect(events).not.toContain("cb:end");
			expect(events).not.toContain("listener:fire");

			// Release the gate. Now the callback resolves, refresh completes,
			// and the listener fires — in that order.
			releaseGate();

			// Wait for the listener to fire (or bail on timeout).
			for (let i = 0; i < 50 && !events.includes("listener:fire"); i++) {
				await Bun.sleep(10);
			}

			const idxCbEnd = events.indexOf("cb:end");
			const idxFire = events.indexOf("listener:fire");
			expect(idxCbEnd).toBeGreaterThanOrEqual(0);
			expect(idxFire).toBeGreaterThanOrEqual(0);
			expect(idxFire).toBeGreaterThan(idxCbEnd);
		} finally {
			// Ensure gate is released even on early failure so no promise leaks.
			releaseGate();
			await manager.disconnectAll();
		}
	}, 15_000);
});

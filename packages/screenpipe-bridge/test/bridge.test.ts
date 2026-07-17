import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createGopkActivitySink,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import type { FrameSource } from "../src/bridge";
import { ScreenpipeBridge } from "../src/bridge";
import { createFileCursorStore } from "../src/cursor";
import { frame } from "./fixtures";

const consent: ConsentRecord = {
	userId: "user-1",
	deviceId: "device-1",
	identityVerified: true,
	enabled: true,
	scope: "device",
	remoteStorageEnabled: false,
	policyVersion: "context-retention/v1",
};

const policy: GopkClipIngestionPolicy = {
	enabled: true,
	allowedApplicationIds: [],
	deniedApplicationIds: ["1password"],
	maximumRawClipRetentionMs: 10 * 60_000,
};

const capture = { userId: "user-1", deviceId: "device-1", sessionId: "session-1" };

function fakeFrameSource(frames: readonly ReturnType<typeof frame>[]): FrameSource {
	return {
		async fetchRedactedFrames({ sinceFrameId, limit }) {
			return frames.filter(f => f.id > sinceFrameId).slice(0, limit);
		},
	};
}

describe("ScreenpipeBridge", () => {
	it("emits closed segments as corroborating screen evidence and advances the cursor", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString() }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString() }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({
				fetchedFrameCount: 2,
				emittedClipCount: 1,
				openSegmentCount: 0,
				cursorFrameId: 2,
			});
			const evidence = ledger.list();
			expect(evidence).toHaveLength(1);
			expect(evidence[0]).toMatchObject({ signal: "screen_active", strength: "corroborating" });
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("holds back a still-open segment and does not advance the cursor past it", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const frames = [frame({ id: 1, timestamp: new Date().toISOString() })];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({
				fetchedFrameCount: 1,
				emittedClipCount: 0,
				openSegmentCount: 1,
				cursorFrameId: 0,
			});
			expect(ledger.list()).toEqual([]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("never re-fetches or re-emits frames behind the cursor", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString() }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString() }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			await bridge.runOnce();
			const second = await bridge.runOnce();

			expect(second).toMatchObject({ fetchedFrameCount: 0, emittedClipCount: 0 });
			expect(ledger.list()).toHaveLength(1);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("holds a device's last segment open when the fetch page is full", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			// Both segments look time-closed, but the page is exactly full (limit 3),
			// so the newest segment may continue past the page and must be held open.
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString(), app_name: "code" }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString(), app_name: "code" }),
				frame({ id: 3, timestamp: new Date(longAgo + 120_000).toISOString(), app_name: "firefox" }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
				fetchLimit: 3,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({ emittedClipCount: 1, openSegmentCount: 1, cursorFrameId: 2 });
			const followUp = await bridge.runOnce();
			expect(followUp).toMatchObject({ fetchedFrameCount: 1, emittedClipCount: 1, cursorFrameId: 3 });
			expect(ledger.list()).toHaveLength(2);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("makes progress on a backlog segment longer than one fetch page", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			// One continuous 5-frame activity, fetch page of 2: every page comes back
			// full and the segment is always truncation-held, so the bridge must
			// force-emit page-sized chunks instead of stalling forever.
			const frames = [1, 2, 3, 4, 5].map(id =>
				frame({ id, timestamp: new Date(longAgo + id * 1_000).toISOString() }),
			);
			const cursorStore = createFileCursorStore(captureRoot);
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore,
				sessionId: "session-1",
				captureRoot,
				fetchLimit: 2,
			});

			const first = await bridge.runOnce();
			expect(first).toMatchObject({ fetchedFrameCount: 2, emittedClipCount: 1, cursorFrameId: 2 });

			const second = await bridge.runOnce();
			expect(second).toMatchObject({ fetchedFrameCount: 2, emittedClipCount: 1, cursorFrameId: 4 });

			// Final partial page closes normally by time.
			const third = await bridge.runOnce();
			expect(third).toMatchObject({ fetchedFrameCount: 1, emittedClipCount: 1, cursorFrameId: 5 });

			// Chunks are disjoint — no overlapping evidence windows.
			expect(ledger.list().map(record => record.sourceEventId)).toEqual([
				"session-1:device-1:1-2",
				"session-1:device-1:3-4",
				"session-1:device-1:5-5",
			]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("does not force-emit a truncation-held segment that reaches into another device's open frame range", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			// Device A's backlog (ids 1,2,4) is old and would be truncation-held on a
			// full page; device B's frame (id 3) sits inside that id range but is
			// recent (genuinely open). Force-emitting A's held segment anyway would
			// be re-fetched and re-emitted with an extended, overlapping clip ID once
			// B's segment closes.
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString(), device_name: "device-a" }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString(), device_name: "device-a" }),
				frame({ id: 3, timestamp: new Date().toISOString(), device_name: "device-b" }),
				frame({ id: 4, timestamp: new Date(longAgo + 120_000).toISOString(), device_name: "device-a" }),
				frame({ id: 5, timestamp: new Date(longAgo + 180_000).toISOString(), device_name: "device-a" }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
				fetchLimit: 4,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({ emittedClipCount: 0, cursorFrameId: 0 });
			expect(ledger.list()).toEqual([]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("rejects overlapping runOnce invocations", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			let release: ((frames: readonly ReturnType<typeof frame>[]) => void) | undefined;
			const blockedSource: FrameSource = {
				fetchRedactedFrames: () =>
					new Promise(resolve => {
						release = resolve;
					}),
			};
			const bridge = new ScreenpipeBridge({
				frameSource: blockedSource,
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const first = bridge.runOnce();
			await expect(bridge.runOnce()).rejects.toThrow("a bridge run is already in progress");
			while (!release) await new Promise(resolve => setTimeout(resolve, 1));
			release([]);
			await first;
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("rejects a denied application via the sink's own policy without bridge-side filtering", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [frame({ id: 1, timestamp: new Date(longAgo).toISOString(), app_name: "1Password" })];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary.emittedClipCount).toBe(1);
			expect(ledger.list()).toEqual([]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("caps the cursor behind an open segment on another device", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [
				// device-b's segment is still open (recent frames) but has LOWER ids
				frame({ id: 5, timestamp: new Date().toISOString(), device_name: "device-b" }),
				// device-a's segment closed long ago with HIGHER ids
				frame({ id: 10, timestamp: new Date(longAgo).toISOString(), device_name: "device-a" }),
				frame({ id: 20, timestamp: new Date(longAgo + 60_000).toISOString(), device_name: "device-a" }),
			];
			const cursorStore = createFileCursorStore(captureRoot);
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore,
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			// device-a's closed segment is emitted, but the cursor stops just
			// before device-b's open frame 5, not at device-a's frame 20.
			expect(summary).toMatchObject({ emittedClipCount: 1, openSegmentCount: 1, cursorFrameId: 4 });
			expect(await cursorStore.read()).toBe(4);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});
});

describe("createFileCursorStore", () => {
	it("returns 0 when no cursor file exists yet", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-cursor-"));
		try {
			expect(await createFileCursorStore(captureRoot).read()).toBe(0);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("throws on a corrupt cursor file instead of silently restarting from 0", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-cursor-"));
		try {
			await fs.writeFile(path.join(captureRoot, "cursor.json"), '{"lastFrameId": ');
			await expect(createFileCursorStore(captureRoot).read()).rejects.toThrow();

			await fs.writeFile(path.join(captureRoot, "cursor.json"), '{"lastFrameId": -3}');
			await expect(createFileCursorStore(captureRoot).read()).rejects.toThrow("bridge cursor file is malformed");
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("round-trips writes and leaves no temp file behind", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-cursor-"));
		try {
			const store = createFileCursorStore(captureRoot);
			await store.write(42);
			expect(await store.read()).toBe(42);
			const leftovers = (await fs.readdir(captureRoot)).filter(name => name.endsWith(".tmp"));
			expect(leftovers).toEqual([]);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});
});

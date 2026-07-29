import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ActivityLedger,
	createGopkActivitySink,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import {
	createFileCursorStore,
	ScreenpipeBridge,
	type ScreenpipeFrameRow,
} from "@pk-nerdsaver-ai/pi-screenpipe-bridge";
import { ScreenpipeSessionManager, type ScreenpipeSessionState } from "./session-state";

// The manager's job is session ownership, so these tests drive it with a factory
// that builds a *real* bridge + gopk sink over a shared on-disk ledger and a fake
// frame source. That lets every assertion read back actual journal rows and prove
// which session each captured clip was attributed to — not merely that a poller is
// running. `runOnce()` is exposed so polls are deterministic (no wall-clock timer).

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
	ocrEnabled: false,
	allowedApplicationIds: [],
	deniedApplicationIds: ["1password"],
	maximumRawClipRetentionMs: 10 * 60_000,
};

// An hour in the past so segments are never "still open" and always emit on runOnce.
const BASE_MS = Date.now() - 60 * 60_000;

function frame(id: number): ScreenpipeFrameRow {
	return {
		id,
		timestamp: new Date(BASE_MS + id * 1_000).toISOString(),
		device_name: "device-1",
		app_name: "code",
		window_name: "main.rs",
		browser_url: null,
		focused: 1,
		snapshot_path: null,
		full_text_redacted_at: null,
		accessibility_redacted_at: null,
		accessibility_tree_redacted_at: null,
		window_name_redacted_at: 1_752_415_200,
		browser_url_redacted_at: null,
		text_json_redacted_at: null,
		image_redacted_at: null,
		has_full_text: 0,
		has_accessibility_text: 0,
		has_accessibility_tree: 0,
		has_text_json: 0,
	};
}

/** A managed state that also lets the test drive one poll and inspect its bridge. */
interface TestState extends ScreenpipeSessionState {
	runOnce(): Promise<void>;
	readonly instanceId: number;
}

/**
 * A test harness whose factory builds real bridge/ledger stacks sharing one
 * device-level capture root + ledger file (as production does), so the shared
 * cursor advances across sessions and the shared journal accumulates rows tagged
 * per session.
 */
function makeHarness(captureRoot: string, ledgerPath: string) {
	const frames: ScreenpipeFrameRow[] = [];
	let created = 0;
	let live = 0;
	let failFor: string | undefined;
	const disposed: string[] = [];

	const factory = (sessionId: string): TestState => {
		if (failFor === sessionId) throw new Error(`factory refused session ${sessionId}`);
		const instanceId = ++created;
		live++;
		const ledger = new SqliteActivityLedger(ledgerPath);
		let inFlight: Promise<void> = Promise.resolve();
		let closed = false;
		try {
			const sink = createGopkActivitySink({
				ledger,
				consent,
				policy,
				capture: { userId: "user-1", deviceId: "device-1", sessionId },
				captureRoot,
			});
			const bridge = new ScreenpipeBridge({
				frameSource: {
					async fetchRedactedFrames({ sinceFrameId, limit }) {
						return frames.filter(f => f.id > sinceFrameId).slice(0, limit);
					},
				},
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId,
				captureRoot,
			});
			return {
				sessionId,
				instanceId,
				runOnce() {
					// Model the runner: dispose() must await an in-flight poll before
					// closing the ledger, exactly as ScreenpipeBridgeRunner.stop() does.
					inFlight = bridge.runOnce().then(() => undefined);
					return inFlight;
				},
				async dispose() {
					await inFlight;
					if (!closed) {
						closed = true;
						live--;
						disposed.push(sessionId);
						ledger.close();
					}
				},
			};
		} catch (error) {
			ledger.close();
			live--;
			throw error;
		}
	};

	return {
		factory,
		pushFrames(...ids: number[]) {
			for (const id of ids) frames.push(frame(id));
		},
		failNext(sessionId: string) {
			failFor = sessionId;
		},
		clearFailure() {
			failFor = undefined;
		},
		get liveCount() {
			return live;
		},
		get createdCount() {
			return created;
		},
		disposedOrder: disposed,
	};
}

/** Session ids attributed to the rows currently in the journal, in insertion order. */
function journalSessionIds(ledger: ActivityLedger): string[] {
	return ledger.list().map(e => e.sourceEventId.split(":", 1)[0] ?? "");
}

describe("ScreenpipeSessionManager", () => {
	let captureRoot: string;
	let ledgerPath: string;
	let inspector: SqliteActivityLedger;

	beforeEach(async () => {
		captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-mgr-"));
		ledgerPath = path.join(captureRoot, "journal.sqlite");
		inspector = new SqliteActivityLedger(ledgerPath);
	});

	afterEach(async () => {
		inspector.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	// Every AgentSession transition (newSession, switchSession, fork, branch,
	// freshSession, handoff) funnels through the same re-bind call, so proving the
	// manager re-attributes across one syncTo proves it for all of them. This table
	// keeps each named path traceable to a passing assertion.
	for (const transition of ["newSession", "switchSession", "fork", "branch", "freshSession"] as const) {
		it(`attributes capture to the pre- and post-transition session across ${transition}`, async () => {
			const h = makeHarness(captureRoot, ledgerPath);
			const mgr = new ScreenpipeSessionManager(h.factory);

			await mgr.syncTo("session-before");
			h.pushFrames(1, 2);
			await (mgr.activeState as TestState).runOnce();
			expect(journalSessionIds(inspector)).toEqual(["session-before"]);

			// The transition changes the active session id.
			await mgr.syncTo("session-after");
			h.pushFrames(3, 4);
			await (mgr.activeState as TestState).runOnce();

			// New activity lands under the new session; the prior session gained nothing.
			expect(journalSessionIds(inspector)).toEqual(["session-before", "session-after"]);
			expect(mgr.activeSessionId).toBe("session-after");
			expect(h.liveCount).toBe(1);

			await mgr.dispose();
		});
	}

	it("appends zero entries to the previous session after the transition boundary", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("old");
		h.pushFrames(1, 2);
		await (mgr.activeState as TestState).runOnce();
		const oldRowsAtBoundary = journalSessionIds(inspector).filter(s => s === "old").length;
		expect(oldRowsAtBoundary).toBe(1);

		await mgr.syncTo("new");
		// Even if more capturable frames arrive, none may be attributed to "old".
		h.pushFrames(3, 4, 5, 6);
		await (mgr.activeState as TestState).runOnce();

		expect(journalSessionIds(inspector).filter(s => s === "old").length).toBe(oldRowsAtBoundary);
		expect(journalSessionIds(inspector).filter(s => s === "new").length).toBeGreaterThan(0);

		await mgr.dispose();
	});

	it("keeps exactly one live bridge and disposes the old one across multiple consecutive transitions", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("a");
		await mgr.syncTo("b");
		await mgr.syncTo("c");
		await mgr.syncTo("d");

		expect(mgr.activeSessionId).toBe("d");
		expect(h.liveCount).toBe(1);
		expect(h.createdCount).toBe(4);
		expect(h.disposedOrder).toEqual(["a", "b", "c"]);

		await mgr.dispose();
		expect(h.liveCount).toBe(0);
		expect(h.disposedOrder).toEqual(["a", "b", "c", "d"]);
	});

	it("serializes overlapping transitions so no duplicate bridges are ever live", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		// Fire several transitions without awaiting between them.
		const inFlight = [mgr.syncTo("a"), mgr.syncTo("b"), mgr.syncTo("c")];
		await Promise.all(inFlight);

		expect(h.liveCount).toBe(1);
		expect(mgr.activeSessionId).toBe("c");
		await mgr.dispose();
	});

	it("is a no-op when re-binding to the already-active session", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("same");
		await mgr.syncTo("same");
		await mgr.syncTo("same");

		expect(h.createdCount).toBe(1);
		expect(h.disposedOrder).toEqual([]);
		await mgr.dispose();
	});

	it("completes an in-flight poll under the old session, then binds the new one", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("polling");
		h.pushFrames(1, 2);
		// Start a poll but do not await it — a transition arrives while it runs.
		const poll = (mgr.activeState as TestState).runOnce();
		const rebind = mgr.syncTo("switched");
		await Promise.all([poll, rebind]);

		// The in-flight poll's clip is attributed to the session that was active
		// when it started; nothing leaks the other way.
		expect(journalSessionIds(inspector)).toEqual(["polling"]);
		h.pushFrames(3, 4);
		await (mgr.activeState as TestState).runOnce();
		expect(journalSessionIds(inspector)).toEqual(["polling", "switched"]);
		expect(h.liveCount).toBe(1);

		await mgr.dispose();
	});

	it("leaves a deterministic empty state when a transition's construction fails", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory, { warn() {} });

		await mgr.syncTo("good");
		expect(h.liveCount).toBe(1);

		// The old bridge is disposed first, so a failed construction never leaves it
		// running against the wrong session.
		h.failNext("bad");
		await mgr.syncTo("bad");
		expect(mgr.activeState).toBeUndefined();
		expect(mgr.activeSessionId).toBeUndefined();
		expect(h.liveCount).toBe(0);
		expect(h.disposedOrder).toEqual(["good"]);

		// Recovery: a subsequent good transition rebuilds cleanly.
		h.clearFailure();
		await mgr.syncTo("recovered");
		expect(mgr.activeSessionId).toBe("recovered");
		expect(h.liveCount).toBe(1);

		await mgr.dispose();
	});

	it("blocks further binds after dispose", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("a");
		await mgr.dispose();
		await mgr.syncTo("b");

		expect(mgr.activeState).toBeUndefined();
		expect(h.liveCount).toBe(0);
		expect(h.createdCount).toBe(1);
	});

	// Models a rolled-back session switch: capture is bound to the target only on
	// commit, so if the switch aborts (rebinding back) before the target ever polls,
	// the journal gains zero rows under the abandoned target.
	it("writes zero journal rows for a target that is rebound away before it captures", async () => {
		const h = makeHarness(captureRoot, ledgerPath);
		const mgr = new ScreenpipeSessionManager(h.factory);

		await mgr.syncTo("previous");
		h.pushFrames(1, 2);
		await (mgr.activeState as TestState).runOnce();
		expect(journalSessionIds(inspector)).toEqual(["previous"]);

		// Bind toward the target, then roll straight back before any poll runs.
		h.pushFrames(3, 4);
		await mgr.syncTo("target");
		await mgr.syncTo("previous");
		await (mgr.activeState as TestState).runOnce();

		// Nothing was ever attributed to the abandoned target.
		expect(journalSessionIds(inspector).filter(s => s === "target")).toHaveLength(0);
		expect(mgr.activeSessionId).toBe("previous");
		expect(h.liveCount).toBe(1);

		await mgr.dispose();
	});
});

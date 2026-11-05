import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	loadPinnedSessionIds,
	setSessionPinned,
	sortPinnedFirst,
	toggleSessionPin,
} from "@oh-my-pi/pi-coding-agent/session/session-pins";

describe("session-pins", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-pins-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns an empty set when no pins file exists", async () => {
		const pins = await loadPinnedSessionIds(tempDir);
		expect(pins.size).toBe(0);
	});

	it("recovers gracefully from a corrupt pins file", async () => {
		await Bun.write(path.join(tempDir, "session-pins.json"), "invalid json {");
		const pins = await loadPinnedSessionIds(tempDir);
		expect(pins.size).toBe(0);
	});

	it("toggles pin state and persists to disk", async () => {
		const id1 = "session-aaa-111";
		const id2 = "session-bbb-222";

		// Pin id1
		const pinned1 = await toggleSessionPin(id1, tempDir);
		expect(pinned1).toBe(true);
		let loaded = await loadPinnedSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(true);
		expect(loaded.size).toBe(1);

		// Pin id2
		const pinned2 = await toggleSessionPin(id2, tempDir);
		expect(pinned2).toBe(true);
		loaded = await loadPinnedSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(true);
		expect(loaded.has(id2)).toBe(true);
		expect(loaded.size).toBe(2);

		// Unpin id1
		const unpinned1 = await toggleSessionPin(id1, tempDir);
		expect(unpinned1).toBe(false);
		loaded = await loadPinnedSessionIds(tempDir);
		expect(loaded.has(id1)).toBe(false);
		expect(loaded.has(id2)).toBe(true);
		expect(loaded.size).toBe(1);
	});

	it("sets an explicit pin state instead of toggling when repeated", async () => {
		await setSessionPinned("kept", true, tempDir);
		await setSessionPinned("s", true, tempDir);
		await setSessionPinned("s", true, tempDir);
		expect(await loadPinnedSessionIds(tempDir)).toEqual(new Set(["kept", "s"]));

		await setSessionPinned("s", false, tempDir);
		await setSessionPinned("s", false, tempDir);
		expect(await loadPinnedSessionIds(tempDir)).toEqual(new Set(["kept"]));
	});

	it("sorts pinned sessions first while preserving relative recency order", () => {
		const s1: SessionInfo = {
			id: "s1",
			path: "/s1",
			cwd: "/cwd",
			created: new Date(1000),
			modified: new Date(4000),
			messageCount: 1,
			size: 100,
			firstMessage: "one",
			allMessagesText: "one",
		};
		const s2: SessionInfo = {
			id: "s2",
			path: "/s2",
			cwd: "/cwd",
			created: new Date(1000),
			modified: new Date(3000),
			messageCount: 1,
			size: 100,
			firstMessage: "two",
			allMessagesText: "two",
		};
		const s3: SessionInfo = {
			id: "s3",
			path: "/s3",
			cwd: "/cwd",
			created: new Date(1000),
			modified: new Date(2000),
			messageCount: 1,
			size: 100,
			firstMessage: "three",
			allMessagesText: "three",
		};
		const s4: SessionInfo = {
			id: "s4",
			path: "/s4",
			cwd: "/cwd",
			created: new Date(1000),
			modified: new Date(1000),
			messageCount: 1,
			size: 100,
			firstMessage: "four",
			allMessagesText: "four",
		};

		// Input in recency order: s1, s2, s3, s4
		const all = [s1, s2, s3, s4];

		// Pin s3 and s1 -> s1, s3 should be top, then s2, s4
		const sorted = sortPinnedFirst(all, new Set(["s3", "s1"]));
		expect(sorted.map(s => s.id)).toEqual(["s1", "s3", "s2", "s4"]);

		// Pin none -> unchanged
		expect(sortPinnedFirst(all, new Set())).toEqual(all);

		// Pin unknown id -> no change to order
		expect(sortPinnedFirst(all, new Set(["unknown-id"])).map(s => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
	});

	it("keeps every pin when many toggles race concurrently", async () => {
		// Regression: toggleSessionPin used to load-modify-write without a lock,
		// so overlapping toggles from multiple omp instances (CLI picker,
		// interactive mode, collab guest) interleaved load-load-write-write and
		// silently dropped each other's pins.
		const ids = Array.from({ length: 24 }, (_, i) => `session-race-${i}`);
		await Promise.all(ids.map(id => toggleSessionPin(id, tempDir)));

		const loaded = await loadPinnedSessionIds(tempDir);
		expect(loaded.size).toBe(ids.length);
		for (const id of ids) expect(loaded.has(id)).toBe(true);
	});

	it("never exposes a truncated pins file while writes are in flight", async () => {
		// Regression: Bun.write truncated in place, so a crash mid-write
		// stranded a truncated file the next launch degraded to an empty set.
		// The sampler observes on-disk states CONCURRENTLY with the toggles:
		// every observed state must parse (or be absent); a torn write or a
		// rename window that exposes partial content fails the parse.
		// Completion is polled WITHOUT awaiting the aggregate promise, so the
		// loop keeps reading between writes; a rejected toggle propagates via
		// the final Promise.all instead of hanging the sampler.
		const ids = Array.from({ length: 12 }, (_, i) => `session-torn-${i}`);
		const pinsFile = path.join(tempDir, "session-pins.json");
		let settledCount = 0;
		const toggles = ids.map(id =>
			toggleSessionPin(id, tempDir).finally(() => {
				settledCount++;
			}),
		);
		let samples = 0;
		const sampler = (async () => {
			while (settledCount < toggles.length) {
				try {
					const raw = await fs.readFile(pinsFile, "utf-8");
					JSON.parse(raw);
					samples++;
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code;
					if (code !== "ENOENT") throw err;
				}
			}
		})();
		await Promise.all([sampler, ...toggles]);
		expect(samples).toBeGreaterThan(0);

		const raw = await fs.readFile(pinsFile, "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
		expect((JSON.parse(raw) as string[]).length).toBe(ids.length);
		const files = await fs.readdir(tempDir);
		expect(files.some(f => f.endsWith(".tmp"))).toBe(false);
	});

	// Two profiles whose pins files link at one target now write one file. The
	// lock is named after the path it is given, so locking the link would let
	// both profiles into the read-modify-write at once and lose a pin.
	it("keeps both pins when two profiles share one pins file through a symlink", async () => {
		// Inside an omp root, which is the only place a config write follows a
		// link; under a bare temp directory it would not, and the test would pass
		// while observing nothing.
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir);
		const shared = path.join(tempDir, "shared");
		const profileA = path.join(tempDir, "a");
		const profileB = path.join(tempDir, "b");
		for (const dir of [shared, profileA, profileB]) await fs.mkdir(dir, { recursive: true });
		const target = path.join(shared, "session-pins.json");
		await fs.writeFile(target, "[]");
		await fs.symlink(target, path.join(profileA, "session-pins.json"));
		await fs.symlink(target, path.join(profileB, "session-pins.json"));

		await Promise.all([setSessionPinned("session-A", true, profileA), setSessionPinned("session-B", true, profileB)]);

		try {
			expect([...(await loadPinnedSessionIds(shared))].sort()).toEqual(["session-A", "session-B"]);
			expect((await fs.lstat(path.join(profileA, "session-pins.json"))).isSymbolicLink()).toBe(true);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});

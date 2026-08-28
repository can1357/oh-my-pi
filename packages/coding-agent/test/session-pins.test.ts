import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	loadPinnedSessionIds,
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
});

import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("SessionManager.findLastBranchEntry", () => {
	it("returns the newest metadata-matching entry on the active branch", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("digest", "first");
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const newestId = manager.appendCustomEntry("digest", "second");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		const found = manager.findLastBranchEntry(
			metadata => metadata.type === "custom" && metadata.customType === "digest",
		);
		expect(found?.id).toBe(newestId);
	});

	it("skips candidates the payload check rejects and ignores abandoned branches", () => {
		const manager = SessionManager.inMemory();
		const keptId = manager.appendCustomEntry("digest", "kept");
		const forkPoint = manager.appendCustomEntry("digest", "malformed-on-purpose");
		manager.appendCustomEntry("digest", "abandoned");
		manager.branch(forkPoint);

		const found = manager.findLastBranchEntry(
			metadata => metadata.type === "custom" && metadata.customType === "digest",
			(entry): entry is SessionEntry => entry.type === "custom" && entry.data === "kept",
		);
		expect(found?.id).toBe(keptId);

		const newest = manager.findLastBranchEntry(
			metadata => metadata.type === "custom" && metadata.customType === "digest",
		);
		expect(newest?.id).toBe(forkPoint);
	});

	it("returns undefined when nothing matches", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		expect(manager.findLastBranchEntry(metadata => metadata.type === "compaction")).toBeUndefined();
	});
});

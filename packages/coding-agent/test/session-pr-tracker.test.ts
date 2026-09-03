import { describe, expect, test } from "bun:test";
import {
	getTrackedPullRequestStatus,
	getTrackedPullRequests,
	recordTrackedPullRequestTerminal,
	registerTrackedPullRequest,
	TRACKED_PR_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/pr-tracker";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

describe("session PR tracker persistence", () => {
	test("persists a structured registration, reconstructs it, and removes it after terminal acknowledgement", async () => {
		const entries: SessionEntry[] = [];
		let ensureCalls = 0;
		const sessionManager = {
			getBranch: () => entries,
			ensureOnDisk: async () => {
				ensureCalls += 1;
			},
			appendCustomEntry: (customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					customType,
					data,
					id: String(entries.length),
					parentId: null,
					timestamp: "2026-09-02T00:00:00.000Z",
				});
				return String(entries.length);
			},
		};
		const pullRequest = {
			repo: "owner/repo",
			number: 42,
			url: "https://github.com/owner/repo/pull/42",
			title: "Track me",
			source: "github" as const,
		};

		expect(await registerTrackedPullRequest(sessionManager, pullRequest)).toBe(true);
		expect(ensureCalls).toBe(1);
		expect(getTrackedPullRequests(structuredClone(entries))).toEqual([pullRequest]);
		expect(await registerTrackedPullRequest(sessionManager, pullRequest)).toBe(false);
		expect(entries).toHaveLength(1);

		recordTrackedPullRequestTerminal(sessionManager, pullRequest, "MERGED");
		expect(getTrackedPullRequests(entries)).toEqual([]);
	});

	test("ignores prose-shaped and malformed custom records", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom",
				customType: TRACKED_PR_ENTRY_TYPE,
				data: { action: "register", pullRequest: "Created PR #99" },
				id: "1",
				parentId: null,
				timestamp: "2026-09-02T00:00:00.000Z",
			},
			{
				type: "custom",
				customType: "unrelated",
				data: { action: "register", pullRequest: { number: 99 } },
				id: "2",
				parentId: "1",
				timestamp: "2026-09-02T00:00:01.000Z",
			},
		];
		expect(getTrackedPullRequests(entries)).toEqual([]);
	});
});
describe("session PR tracker status rendering", () => {
	test("derives concise dynamic states and treats closed PRs as terminal", () => {
		expect(getTrackedPullRequestStatus({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED" })).toEqual({
			label: "changes",
			terminal: false,
		});
		expect(getTrackedPullRequestStatus({ state: "OPEN", isDraft: true })).toEqual({
			label: "draft",
			terminal: false,
		});
		expect(getTrackedPullRequestStatus({ state: "MERGED" })).toEqual({
			label: "merged",
			terminal: true,
			terminalState: "MERGED",
		});
	});
});

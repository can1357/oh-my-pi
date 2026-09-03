import { afterEach, describe, expect, test, vi } from "bun:test";
import { getTrackedPullRequests } from "@oh-my-pi/pi-coding-agent/session/pr-tracker";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { executePrCreate } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("github pr_create session tracking", () => {
	test("registers only after the structured creation result supplies a PR URL", async () => {
		const entries: SessionEntry[] = [];
		const sessionManager = {
			getBranch: () => entries,
			ensureOnDisk: async () => {},
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
		vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/owner/repo/pull/42\n");
		vi.spyOn(git.github, "json").mockRejectedValue(new Error("optional PR detail unavailable"));

		await executePrCreate(
			{ cwd: "/repo", sessionManager } as ToolSession,
			{ op: "pr_create", title: "Track structured creation" },
			undefined,
		);

		expect(getTrackedPullRequests(entries)).toEqual([
			{
				repo: "owner/repo",
				number: 42,
				url: "https://github.com/owner/repo/pull/42",
				title: "Track structured creation",
				source: "github",
			},
		]);
	});
});

/**
 * Regression: the status line's background reads (git status, `gh pr view`)
 * outlive `dispose()`. A late result then reached the host after tests reset
 * the global settings (or after the session's status line was replaced),
 * hitting the settings proxy and throwing "Settings not initialized".
 *
 * Contract: after `dispose()`, a background read that resolves later neither
 * reports to the host (`onPullRequest`) nor publishes new facts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

const prSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git", "pr"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function mockFeatureCheckout(): void {
	const git = {
		headSync: () => ({
			kind: "ref",
			branch: "feature/x",
			refName: "refs/heads/feature/x",
		}),
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
	const repo = {
		kind: () => "git",
		asGit: () => git,
		asJj: () => null,
		root: () => "/repo/dispose",
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "repo").mockReturnValue(repo);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repo);
	vi.spyOn(vcs, "watch").mockReturnValue(() => {});
}

describe("status line dispose guards background reads", () => {
	it("drops a PR lookup that resolves after dispose()", async () => {
		mockFeatureCheckout();
		const ghStarted = Promise.withResolvers<void>();
		const releaseGh = Promise.withResolvers<void>();
		vi.spyOn(github, "run").mockImplementation(async () => {
			ghStarted.resolve();
			await releaseGh.promise;
			return {
				exitCode: 0,
				stdout: '{"number":7,"url":"https://example.test/x/7"}',
				stderr: "",
			};
		});
		const line = statusLine(statusSession(), prSettings);
		const onPullRequest = vi.fn();
		line.onPullRequest = onPullRequest;

		lineText(line);
		await ghStarted.promise;
		const before = line.facts();
		line.dispose();

		releaseGh.resolve();
		await flushStatus();

		expect(onPullRequest).not.toHaveBeenCalled();
		expect(line.facts()).toBe(before);
	});

	it("drops a PR lookup that resolves after the file reset the global settings", async () => {
		mockFeatureCheckout();
		const ghStarted = Promise.withResolvers<void>();
		const releaseGh = Promise.withResolvers<void>();
		vi.spyOn(github, "run").mockImplementation(async () => {
			ghStarted.resolve();
			await releaseGh.promise;
			return { exitCode: 1, stdout: "", stderr: "" };
		});
		const line = statusLine(statusSession(), prSettings);
		const onPullRequest = vi.fn();
		line.onPullRequest = onPullRequest;

		lineText(line);
		await ghStarted.promise;
		line.dispose();
		resetSettingsForTest();
		try {
			releaseGh.resolve();
			await flushStatus();
			expect(onPullRequest).not.toHaveBeenCalled();
		} finally {
			await Settings.init({ inMemory: true });
		}
	});
});

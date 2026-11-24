/**
 * Regression (#4234): the status line's PR lookup called `gh pr view`
 * through Bun's raw `$` with no signal or non-interactive env. A stalled `gh`
 * (keychain prompt, network hang, auth deadlock) wedged the child forever and
 * the PR segment never refreshed again.
 *
 * Contract: the lookup MUST go through `github.run(cwd, args, signal)` with an
 * `AbortSignal`, and a failed lookup must not freeze the segment: the branch is
 * looked up again once its lookup expires.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

const fakeRefHead: VcsHeadState = {
	kind: "ref",
	branch: "feature/x",
	refName: "refs/heads/feature/x",
	commit: undefined,
};

const prSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
	rightSegments: ["session_name"],
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

/** Fires the HEAD watcher the status line installs (a checkout, a commit). */
let headMoved = (): void => {};

beforeEach(() => {
	const gitRepository = {
		headSync: () => fakeRefHead,
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
	const repository = {
		kind: () => "git",
		asGit: () => gitRepository,
		asJj: () => null,
		root: () => "/fake",
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "repo").mockReturnValue(repository);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repository);
	// No repository to read a default branch from: it stays `main`.
	vi.spyOn(vcs, "git").mockReturnValue(null);
	vi.spyOn(vcs, "watch").mockImplementation((_repo, onChange) => {
		headMoved = onChange as () => void;
		return () => {};
	});
});

afterEach(() => {
	disposeStatusLines();
	setSystemTime();
	vi.restoreAllMocks();
});

function prStatusLine() {
	return statusLine(
		statusSession({
			sessionManager: { getSessionName: () => "pr-lookup-timeout test" },
		}),
		prSettings,
	);
}

describe("status line PR lookup timeout guard", () => {
	it("routes gh pr view through github.run with a bounded abort signal", async () => {
		const ghCalled = Promise.withResolvers<{
			args: readonly string[];
			signal: AbortSignal | undefined;
		}>();
		const ghUnblock = Promise.withResolvers<void>();
		vi.spyOn(github, "run").mockImplementation(async (_cwd, args, signal) => {
			ghCalled.resolve({ args, signal });
			await ghUnblock.promise;
			return { exitCode: 1, stdout: "", stderr: "" };
		});

		const line = prStatusLine();
		try {
			// Painting the bar starts the PR lookup.
			lineText(line);
			const call = await ghCalled.promise;
			expect(call.args).toEqual(["pr", "view", "--json", "number,url"]);
			// A raw `$` would drop the signal entirely; the bounded one has not fired yet.
			expect(call.signal).toBeInstanceOf(AbortSignal);
			expect(call.signal?.aborted).toBe(false);
		} finally {
			ghUnblock.resolve();
		}
	});

	it("looks the branch up again after a rejected lookup expires", async () => {
		const start = Date.now();
		setSystemTime(start);
		const run = vi.spyOn(github, "run").mockRejectedValue(new Error("simulated timeout"));
		const line = prStatusLine();

		lineText(line);
		await flushStatus();
		expect(run).toHaveBeenCalledTimes(1);

		run.mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({
				number: 42,
				url: "https://github.com/x/y/pull/42",
			}),
			stderr: "",
		});
		setSystemTime(start + 61_000);
		headMoved();
		lineText(line);
		await flushStatus();

		expect(run).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("#42");
	});
});

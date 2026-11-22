/**
 * A repository whose metadata a contained command created is refused by the
 * sandbox's repo guard (`vcs.setRepoGuard`): every async git operation on it
 * rejects. The status line still paints, and a refused lookup (default branch,
 * status) never surfaces as an unhandled rejection.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

const originalProjectDir = getProjectDir();

const settings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["path", "git", "pr"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

/** Writes a checkout's on-disk shape on `branch`, without invoking git (no hooks, signing or user config). */
function writeCheckout(repo: string, branch: string): void {
	const gitDir = path.join(repo, ".git");
	for (const dir of ["objects", path.join("refs", "heads")]) fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	vcs.setRepoGuard(undefined);
	setProjectDir(originalProjectDir);
});

it("paints a repository the sandbox guard refuses, raising no unhandled rejection", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refused-git-"));
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		writeCheckout(repo, "feature/parity");
		setProjectDir(repo);

		// Sandbox-created metadata: every async git operation on this repository is refused.
		vcs.setRepoGuard(() => false);
		await expect(vcs.git(repo)!.defaultBranch()).rejects.toMatchObject({ code: "Refused" });

		// The `pr` segment looks a pull request up only after the default-branch lookup settled
		// on a branch other than the default: that lookup is the refresh's last step.
		const lookedUp = Promise.withResolvers<void>();
		vi.spyOn(github, "run").mockImplementation(async () => {
			lookedUp.resolve();
			return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
		});
		const line = statusLine(statusSession(), settings);
		lineText(line);
		await lookedUp.promise;
		await flushStatus();
		expect(lineText(line)).toContain("feature/parity");

		// Integration exception: `unhandledRejection` is emitted only after the microtask queue
		// drains, so there is no promise to await; one macrotask turn lets it surface.
		const turn = Promise.withResolvers<void>();
		setTimeout(turn.resolve, 0);
		await turn.promise;
		expect(unhandled).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		process.off("unhandledRejection", onUnhandled);
		removeSyncWithRetries(repo);
	}
});

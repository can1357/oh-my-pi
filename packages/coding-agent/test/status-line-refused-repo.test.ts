/**
 * A repository whose metadata a contained command created is refused by the
 * sandbox's repo guard (`vcs.setRepoGuard`): every git operation on it is
 * refused, `headSync` included. The status line still paints and shows no
 * branch for it (a branch read before the refusal keeps rendering), and a
 * refused lookup (default branch, status) never surfaces as an unhandled
 * rejection.
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

/** Runs `body` with unhandled rejections collected; asserts none surfaced once `body` and one macrotask turn passed. */
async function withoutUnhandledRejection(body: () => Promise<void>): Promise<void> {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		await body();
		// Integration exception: `unhandledRejection` is emitted only after the microtask queue
		// drains, so there is no promise to await; one macrotask turn lets it surface.
		await Bun.sleep(0);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

it("keeps rendering a branch read before the guard refused the repository, raising no unhandled rejection", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refused-git-"));
	try {
		writeCheckout(repo, "feature/parity");
		setProjectDir(repo);
		await withoutUnhandledRejection(async () => {
			// A refresh reads HEAD first, then its status and default-branch lookups: the repository is
			// allowed for that first operation only, so the branch is cached and the lookups are refused.
			let consulted = 0;
			vcs.setRepoGuard(() => ++consulted === 1);
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
			// Every later git operation on this repository is refused.
			await expect(vcs.git(repo)!.defaultBranch()).rejects.toMatchObject({ code: "Refused" });
			expect(consulted).toBeGreaterThan(2);
		});
	} finally {
		vi.restoreAllMocks();
		removeSyncWithRetries(repo);
	}
});

it("shows no branch for a refused repository on a fresh render, raising no unhandled rejection", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refused-git-"));
	try {
		writeCheckout(repo, "feature/parity");
		setProjectDir(repo);
		await withoutUnhandledRejection(async () => {
			// Sandbox-created metadata: every git operation on this repository is refused from the start.
			vcs.setRepoGuard(() => false);
			expect(() => vcs.git(repo)!.headSync()).toThrow(expect.objectContaining({ code: "Refused" }));
			// Were HEAD readable, the refresh would go on to the `pr` segment's pull request lookup.
			const lookedUp = Promise.withResolvers<void>();
			const lookup = vi.spyOn(github, "run").mockImplementation(async () => {
				lookedUp.resolve();
				return { exitCode: 1, stdout: "", stderr: "" };
			});
			const line = statusLine(statusSession(), settings);
			// A fresh read is refused: the line renders without a branch instead of throwing.
			const text = lineText(line);
			expect(text).toContain(path.basename(repo));
			expect(text).not.toContain("feature/parity");
			await Promise.race([lookedUp.promise, Bun.sleep(100)]);
			await flushStatus();
			expect(lineText(line)).not.toContain("feature/parity");
			expect(lookup).not.toHaveBeenCalled();
		});
	} finally {
		vi.restoreAllMocks();
		removeSyncWithRetries(repo);
	}
});

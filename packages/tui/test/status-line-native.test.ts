import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { StatusLineComponent } from "../src/status-line/component";
import { describeSegment, type SegmentContext } from "../src/status-line/segments";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

function statusLine(settings: StatusLineSettings, gitEnabled = false): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

/** The `seg` facts of the composer's extras, in order. */
function facts(line: StatusLineComponent): { key: string; props: TspProps<"seg"> }[] {
	const extras = line.describeComposerFacts().extras;
	expect(extras.k).toBe("status");
	return (extras.c ?? [])
		.filter(isNode)
		.flatMap(child =>
			child.k === "seg" && child.key !== undefined ? [{ key: child.key, props: child.p ?? {} }] : [],
		);
}

describe("native composer facts", () => {
	it("keeps the configured segments without another home, outer edges dropping last", () => {
		setNativeRendering(true);
		const segs = facts(
			statusLine({
				preset: "custom",
				leftSegments: ["hostname", "path", "session", "model"],
				rightSegments: ["session_name", "time", "context_pct", "cost"],
			}),
		);

		// Path goes to Tern's pane header, the session name to the tab title, the
		// model to its chip, context and cost to the hairline and usage text.
		expect(segs.map(seg => seg.key)).toEqual(["hostname", "session", "time"]);
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.hostname!).toBeGreaterThan(priority.session!);
	});

	it("reorders priorities when the configured order changes", () => {
		setNativeRendering(true);
		const segs = facts(statusLine({ preset: "custom", leftSegments: ["session", "hostname"], rightSegments: [] }));
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.session!).toBeGreaterThan(priority.hostname!);
	});

	it("keeps the git branch by the model chip, outlasting the other facts and opening /git", () => {
		setNativeRendering(true);
		const originalProjectDir = getProjectDir();
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-composer-git-"));
		try {
			// The repository's on-disk shape, written without invoking git (no hooks, signing or user config).
			const gitDir = path.join(repo, ".git");
			for (const dir of ["objects", path.join("refs", "heads")])
				fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
			fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/parity\n");
			fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
			setProjectDir(repo);

			const segs = facts(
				statusLine(
					{ preset: "custom", leftSegments: ["hostname", "model", "path", "git"], rightSegments: [] },
					true,
				),
			);
			expect(segs.map(seg => seg.key)).toEqual(["hostname", "git"]);
			const [hostname, branch] = segs;
			expect(branch!.props).toMatchObject({
				icon: "branch",
				spans: [{ t: "feature/parity", s: "statusLineGitClean" }],
				actions: { click: "status.git" },
			});
			expect(branch!.props.priority!).toBeGreaterThan(hostname!.props.priority!);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(repo);
		}
	});

	it("spaces the git counts apart from the branch and each other", () => {
		const text = (branch: string | null, showBranch = true) =>
			describeSegment("git", {
				git: { branch, status: { staged: 2, unstaged: 3, untracked: 1 }, pr: null },
				options: { git: { showBranch } },
			} as unknown as SegmentContext)
				?.spans.map(part => part.t)
				.join("");
		expect(text("main")).toBe("main *3 +2 ?1");
		expect(text("main", false)).toBe("*3 +2 ?1");
	});

	it("describes spans without ANSI escapes or separator glyphs", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "full", separator: "powerline" });
		const json = JSON.stringify(line.describeComposerFacts());
		expect(json).not.toContain("\\u001b");
		for (const glyph of ["\ue0b0", "\ue0b2", "\ue0b1", "\ue0b3", "─", "│"]) expect(json).not.toContain(glyph);
		expect(facts(line).length).toBeGreaterThan(0);
	});

	it("returns the same facts while nothing changed and new ones after a change", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: ["path", "mode"], rightSegments: [] });
		const first = line.describeComposerFacts();
		expect(line.describeComposerFacts()).toBe(first);

		line.setPlanModeStatus({ enabled: true, paused: false });
		expect(line.describeComposerFacts()).not.toBe(first);
		expect(facts(line).map(seg => seg.key)).toEqual(["mode"]);
	});
});

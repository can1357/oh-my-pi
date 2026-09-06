/**
 * The git segment renders upstream divergence counts next to the branch:
 * `⇡N` commits ahead of upstream (statusLineStaged) and `⇣N` behind
 * (statusLineDirty). Counts come from the native statusSummary; they are
 * absent (undefined) for jj workspaces and branches without an upstream,
 * and zero when in sync — both render nothing. `showAheadBehind: false`
 * and the ascii symbol preset (`^`/`v`) are honored.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false, "unicode");
});

afterAll(async () => {
	// Other test files share this process; restore the default symbol preset.
	await initTheme(false, "unicode");
});

type GitStatus = NonNullable<SegmentContext["git"]["status"]>;

function ctxWith(status: GitStatus | null, showAheadBehind?: boolean): SegmentContext {
	return {
		git: { branch: "main", status, pr: null },
		options: { git: { showBranch: true, showAheadBehind } },
		startupPlaceholder: false,
	} as unknown as SegmentContext;
}

function plain(status: GitStatus | null, showAheadBehind?: boolean): string {
	return stripVTControlCharacters(renderSegment("git", ctxWith(status, showAheadBehind)).content);
}

describe("git segment upstream indicators", () => {
	it("renders ahead and behind counts before the dirty indicators", () => {
		const text = plain({ staged: 1, unstaged: 1, untracked: 0, ahead: 2, behind: 1 });
		expect(text).toContain("⇡2");
		expect(text).toContain("⇣1");
		expect(text.indexOf("⇡2")).toBeLessThan(text.indexOf("⇣1"));
		expect(text.indexOf("⇣1")).toBeLessThan(text.indexOf("*1"));
	});

	it("renders only the nonzero direction", () => {
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 3, behind: 0 })).toContain("⇡3");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 3, behind: 0 })).not.toContain("⇣");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 4 })).toContain("⇣4");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 4 })).not.toContain("⇡");
	});

	it("renders nothing when in sync or when counts are absent (jj / no upstream)", () => {
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 })).not.toContain("⇡");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0 })).not.toContain("⇡");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0 })).not.toContain("⇣");
	});

	it("honors showAheadBehind: false", () => {
		const text = plain({ staged: 1, unstaged: 0, untracked: 0, ahead: 2, behind: 1 }, false);
		expect(text).not.toContain("⇡");
		expect(text).not.toContain("⇣");
		expect(text).toContain("+1");
	});

	it("falls back to ASCII arrows under the ascii symbol preset", async () => {
		await initTheme(false, "ascii");
		const text = plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 2, behind: 1 });
		expect(text).toContain("^2");
		expect(text).toContain("v1");
		expect(text).not.toContain("⇡");
		await initTheme(false, "unicode");
	});
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSegmentId } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

/** Minimal SegmentContext factory — only path/git fields matter for these tests. */
function createCtx(overrides?: {
	pathMaxLength?: number;
	branch?: string | null;
	sessionName?: string;
	sessionAccent?: boolean;
	previewTitle?: string;
}): SegmentContext {
	const hasName = overrides?.sessionName !== undefined;
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: hasName ? { getSessionName: () => overrides.sessionName } : undefined,
		} as unknown as SegmentContext["session"],
		sessionAccent: overrides?.sessionAccent,
		previewTitle: overrides?.previewTitle,
		width: 120,
		compactThinkingLevel: false,
		options: {
			path: {
				abbreviate: false,
				maxLength: overrides?.pathMaxLength ?? 40,
				stripWorkPrefix: false,
			},
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: {
			branch: overrides?.branch ?? null,
			status: null,
			pr: null,
		},
		usage: null,
		advisorUsage: null,
	};
}

function createStatusLineSession(sessionName: string, modelName?: string) {
	const model = modelName ? { name: modelName, contextWindow: 128000 } : undefined;
	return {
		state: { messages: [], model },
		messages: [],
		model: model ?? { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
		getGoalModeState: () => null,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("status line session accent", () => {
	function buildComponent(sessionAccent: boolean) {
		const component = new StatusLineComponent(createStatusLineSession("Named session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent,
		});
		return component;
	}

	// Computed lazily: `theme` is assigned by initTheme() in beforeAll, after module evaluation.
	const accentAnsi = (): string => {
		const ansi = getSessionAccentAnsi(getSessionAccentHex("Named session", theme.sessionAccentInputs));
		if (!ansi) throw new Error("expected a session accent ANSI sequence for the test theme");
		return ansi;
	};

	it("paints the gap with the session accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(true).getTopBorder(80).content;
		expect(border).toContain(`${ansi}${theme.boxRound.horizontal}`);
	});

	it("paints the gap with the border color and omits the session accent when disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(false).getTopBorder(80).content;
		// Positive: gap is rendered with the theme border color.
		expect(border).toContain(`${theme.getFgAnsi("border")}${theme.boxRound.horizontal}`);
		// Negative: neither the gap nor the session-name segment may emit the
		// hash-derived session accent when the effective setting is disabled.
		expect(border).not.toContain(ansi);
	});

	it("renders the session name with the theme accent color when the accent is disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const disabled = renderSegment("session_name", createCtx({ sessionName: "Named session", sessionAccent: false }));
		expect(disabled.visible).toBe(true);
		// Positive: the name uses the theme accent color, not the hash-derived session ANSI.
		expect(disabled.content).toContain(theme.getFgAnsi("accent"));
		// Negative: the hash-derived session ANSI must not appear for the name text.
		expect(disabled.content).not.toContain(ansi);
	});

	it("still renders the session name with the hash-derived accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const enabled = renderSegment("session_name", createCtx({ sessionName: "Named session", sessionAccent: true }));
		expect(enabled.visible).toBe(true);
		expect(enabled.content).toContain(ansi);
	});
});

describe("session_name preview-title fallback", () => {
	it("renders the stand-in title when the session is unnamed", () => {
		const seg = renderSegment("session_name", createCtx({ previewTitle: "omp" }));
		expect(seg.visible).toBe(true);
		expect(stripAnsi(seg.content)).toBe("omp");
	});

	it("prefers the real session name over the stand-in", () => {
		const seg = renderSegment("session_name", createCtx({ sessionName: "Named session", previewTitle: "omp" }));
		expect(stripAnsi(seg.content)).toBe("Named session");
	});

	it("right-aligns the stand-in title through the box border pipeline", () => {
		const component = new StatusLineComponent(createStatusLineSession(""));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		const withTitle = component.getTopBorder(80, "omp");
		// The gauge fill pads the group gap, so the title chip lands flush right.
		expect(withTitle.width).toBe(80);
		expect(stripAnsi(withTitle.content).trimEnd().endsWith("omp")).toBe(true);
		// Live render path passes no preview title: unnamed sessions show none.
		expect(stripAnsi(component.getTopBorder(80).content)).not.toContain("omp");
	});
});

describe("status line focused-agent dimming", () => {
	it("keeps powerline end caps at full intensity while text stays dimmed", () => {
		const component = new StatusLineComponent(createStatusLineSession("Focused session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		component.setSession(createStatusLineSession("Focused session"), "agent-1");

		const border = component.getTopBorder(80).content;

		expect(border).toStartWith("\x1b[2m");
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineLeft}\x1b[0m\x1b[2m`);
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineRight}\x1b[0m\x1b[2m`);
		expect(border).toContain("\x1b[0m\x1b[2m");
		expect(border).toEndWith("\x1b[22m");
	});
});

describe("path segment truncation at varying maxLength", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-very-long-directory-name-for-testing-"));
		setProjectDir(tmpDir);
	});

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		const full = renderSegment("path", createCtx({ pathMaxLength: 200 }));
		const short = renderSegment("path", createCtx({ pathMaxLength: 10 }));

		expect(full.visible).toBe(true);
		expect(short.visible).toBe(true);
		expect(visibleWidth(short.content)).toBeLessThan(visibleWidth(full.content));
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLen => {
			const rendered = renderSegment("path", createCtx({ pathMaxLength: maxLen }));
			return visibleWidth(rendered.content);
		});

		for (let i = 1; i < widths.length; i++) {
			expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
		}
	});

	it("still renders a visible segment at maxLength=4", () => {
		const rendered = renderSegment("path", createCtx({ pathMaxLength: 4 }));
		expect(rendered.visible).toBe(true);
		expect(visibleWidth(rendered.content)).toBeGreaterThan(0);
	});
});

describe("overflow: path shrinks before git is dropped", () => {
	let tmpDir: string;

	beforeAll(() => {
		// Long dir name guarantees the path segment is wide
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-a-very-long-worktree-directory-name-here-"));
		setProjectDir(tmpDir);
	});

	/**
	 * Simulates the overflow algorithm from #buildStatusLine:
	 * render left segments, then shrink path before popping, same as production code.
	 */
	function simulateOverflow(
		width: number,
		leftSegmentIds: StatusLineSegmentId[],
		ctx: SegmentContext,
	): { surviving: StatusLineSegmentId[]; contents: string[]; overflow: string[] } {
		const left: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of leftSegmentIds) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				left.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		// Simplified groupWidth: sum of visible widths + padding between segments
		const groupWidth = () => {
			if (left.length === 0) return 0;
			const partsWidth = left.reduce((sum, p) => sum + visibleWidth(p), 0);
			// Each separator gap ~ 3 chars, plus 2 for outer padding
			return partsWidth + Math.max(0, left.length - 1) * 3 + 2;
		};

		// Path shrink step (mirrors production code)
		const pathIdx = leftSegIds.indexOf("path");
		if (pathIdx >= 0 && groupWidth() > width) {
			const overflow = groupWidth() - width;
			const currentPathVW = visibleWidth(left[pathIdx]);
			const minPathVW = 8;
			const shrinkable = currentPathVW - minPathVW;
			if (shrinkable > 0) {
				const shrinkBy = Math.min(shrinkable, overflow);
				const currentMaxLen = ctx.options.path?.maxLength ?? 40;
				let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
				const pathCtx = (maxLen: number): SegmentContext => ({
					...ctx,
					options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
				});
				let reRendered = renderSegment("path", pathCtx(newMaxLen));
				if (reRendered.visible && reRendered.content) {
					for (let i = 0; i < 8; i++) {
						const saved = currentPathVW - visibleWidth(reRendered.content);
						if (saved >= shrinkBy) break;
						const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
						if (nextMaxLen >= newMaxLen) break;
						newMaxLen = nextMaxLen;
						const adjusted = renderSegment("path", pathCtx(newMaxLen));
						if (!adjusted.visible || !adjusted.content) break;
						reRendered = adjusted;
					}
					left[pathIdx] = reRendered.content;
				}
			}
		}

		// Left-segment fallback loop.
		const leftOverflowDropIndex = (): number => {
			for (let i = leftSegIds.length - 1; i >= 0; i--) {
				if (leftSegIds[i] !== "path") return i;
			}
			return left.length - 1;
		};
		// Segment contents shed by the budget, in original (left-group reading) order —
		// mirrors production, which moves these to the overflow line instead of losing them.
		const overflow: string[] = [];
		while (groupWidth() > width && left.length > 0) {
			const dropIdx = leftOverflowDropIndex();
			overflow.push(left[dropIdx]);
			left.splice(dropIdx, 1);
			leftSegIds.splice(dropIdx, 1);
		}

		return { surviving: [...leftSegIds], contents: [...left], overflow: [...overflow].reverse() };
	}

	it("keeps git segment when path can be shrunk to fit", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "feat/long-branch-name" });
		// Use a width that's tight but should fit both after path shrinks
		const fullPath = renderSegment("path", ctx);
		const fullGit = renderSegment("git", ctx);
		const bothWidth = visibleWidth(fullPath.content) + visibleWidth(fullGit.content);
		// Set width to ~60% of both segments — forces shrink but should keep both
		const tightWidth = Math.floor(bothWidth * 0.6) + 10;

		const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

		expect(result.surviving).toContain("git");
		expect(result.surviving).toContain("path");
		expect(result.overflow).toEqual([]);
	});

	it("drops git only when terminal is extremely narrow", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		// Absurdly narrow — even minimally-truncated path won't fit with git
		const result = simulateOverflow(5, ["path", "git"], ctx);

		// At 5 columns, nothing fits
		expect(result.surviving.length).toBeLessThanOrEqual(1);
	});

	it("is a no-op when there is enough space", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		const result = simulateOverflow(200, ["path", "git"], ctx);

		expect(result.surviving).toEqual(["path", "git"]);
		expect(result.overflow).toEqual([]);
	});

	it("shrinks a short path when maxLength exceeds actual path length", () => {
		// Short dir name — rendered path is well under the configured maxLength.
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-short-"));
		setProjectDir(shortDir);
		try {
			const maxLength = 160;
			const ctx = createCtx({ pathMaxLength: maxLength, branch: "feat/long-branch-name" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Sanity: path is shorter than maxLength — this is the bug scenario.
			// macOS temp paths can exceed 80 columns once the path icon is included.
			expect(pathVW).toBeLessThan(maxLength);

			// Width that fits a shrunken path + git but not the full path + git
			const tightWidth = Math.floor(pathVW * 0.5) + gitVW + 10;

			const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");
		} finally {
			// Restore for other tests
			setProjectDir(tmpDir);
		}
	});
	it("preserves git when overflow is only 1-2 columns", () => {
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-narrow-ovf-"));
		setProjectDir(shortDir);
		try {
			const ctx = createCtx({ pathMaxLength: 80, branch: "main" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Compute exact full width using the test's groupWidth formula:
			// partsWidth + (numParts - 1) * 3 + 2
			const fullWidth = pathVW + gitVW + (2 - 1) * 3 + 2;

			// Overflow by exactly 2 columns — the scenario the single-pass missed
			const result = simulateOverflow(fullWidth - 2, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");

			// Path must have actually shrunk (proves the loop ran)
			const shrunkPathVW = visibleWidth(result.contents[result.surviving.indexOf("path")]);
			expect(shrunkPathVW).toBeLessThan(pathVW);
		} finally {
			setProjectDir(tmpDir);
		}
	});
});

describe("overflow: path survives before model", () => {
	it("drops the model segment before the cwd path when both cannot fit", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-statusline-overflow-"));
		const cwd = path.join(root, "cwdxyz");
		fs.mkdirSync(cwd);
		setProjectDir(cwd);

		const modelName = `MODEL_SHOULD_DROP_${"x".repeat(24)}`;
		const session = createStatusLineSession("overflow test", modelName);
		const component = new StatusLineComponent(session);
		const pathOptions = {
			abbreviate: false,
			maxLength: 32,
			stripWorkPrefix: false,
		};
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		});

		const ctx = {
			...createCtx({ pathMaxLength: pathOptions.maxLength }),
			session,
			options: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		} as SegmentContext;
		const pi = renderSegment("pi", ctx).content;
		const model = renderSegment("model", ctx).content;
		const minPath = renderSegment("path", {
			...ctx,
			options: { ...ctx.options, path: { ...pathOptions, maxLength: 4 } },
		}).content;
		const separatorWidth = visibleWidth(theme.sep.space);
		const groupWidth = (parts: string[]) =>
			parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
			Math.max(0, parts.length - 1) * (separatorWidth + 2) +
			2;
		const width = groupWidth([pi, model]) + 1;

		expect(groupWidth([pi, model, minPath])).toBeGreaterThan(width);
		expect(groupWidth([pi, minPath])).toBeLessThanOrEqual(width);

		const border = component.getTopBorder(width);
		const lines = border.content.split("\n");
		// Line 1 keeps the cwd path and sheds the model segment — kept-set unchanged.
		expect(stripAnsi(lines[0])).toContain("xyz");
		expect(stripAnsi(lines[0])).not.toContain("MODEL_SHOULD_DROP");
		// The shed segment is preserved on the overflow line instead of being lost.
		expect(lines.length).toBe(2);
		expect(stripAnsi(lines[1])).toContain("MODEL_SHOULD_DROP");
	});
});

describe("status line two-line overflow", () => {
	/**
	 * Component whose left group (pi, model, path) overflows a tight width and
	 * sheds the model segment; a generous width keeps everything on one line.
	 */
	function buildLeftOverflow() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-statusline-twoline-"));
		const cwd = path.join(root, "cwdxyz");
		fs.mkdirSync(cwd);
		setProjectDir(cwd);

		const modelName = `MODEL_KEPT_ON_LINE2_${"x".repeat(20)}`;
		const component = new StatusLineComponent(createStatusLineSession("two line overflow", modelName));
		const pathOptions = { abbreviate: false, maxLength: 32, stripWorkPrefix: false };
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		});
		return { component, modelName, pathOptions };
	}

	function leftOverflowWidth(
		session: object,
		pathOptions: { abbreviate: boolean; maxLength: number; stripWorkPrefix: boolean },
	): number {
		const ctx = {
			...createCtx({ pathMaxLength: pathOptions.maxLength }),
			session,
			options: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		} as SegmentContext;
		const pi = renderSegment("pi", ctx).content;
		const model = renderSegment("model", ctx).content;
		const separatorWidth = visibleWidth(theme.sep.space);
		const groupWidth = (parts: string[]) =>
			parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
			Math.max(0, parts.length - 1) * (separatorWidth + 2) +
			2;
		return groupWidth([pi, model]) + 1;
	}

	it("moves the dropped left segment to a second line instead of losing it", () => {
		const { component, modelName, pathOptions } = buildLeftOverflow();
		const width = leftOverflowWidth(createStatusLineSession("two line overflow", modelName), pathOptions);

		const border = component.getTopBorder(width);
		const lines = border.content.split("\n");
		// Line 1 sheds the model (same kept-set as before); line 2 keeps its text.
		expect(lines.length).toBe(2);
		expect(stripAnsi(lines[0])).toContain("xyz");
		expect(stripAnsi(lines[0])).not.toContain(modelName);
		expect(stripAnsi(lines[1])).toContain(modelName);
	});

	it("stays single-line at a generous width (no regression)", () => {
		const { component, modelName } = buildLeftOverflow();
		const border = component.getTopBorder(500);
		expect(border.content).not.toContain("\n");
		expect(stripAnsi(border.content)).toContain(modelName);
	});

	it("reports the max visible line width for a two-line overflow", () => {
		const { component, modelName, pathOptions } = buildLeftOverflow();
		const session = createStatusLineSession("two line overflow", modelName);
		const width = leftOverflowWidth(session, pathOptions);

		const border = component.getTopBorder(width);
		const lines = border.content.split("\n");
		expect(lines.length).toBe(2);
		const lineWidths = lines.map(line => visibleWidth(line));
		expect(border.width).toBe(Math.max(...lineWidths));
	});

	it("moves popped right segments to a second line instead of losing them", () => {
		const session = createStatusLineSession("Right session", `MODEL_RIGHT_${"z".repeat(24)}`);
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["model", "session_name"],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: { model: { showThinkingLevel: false } },
		});

		// Generous width: everything fits on line 1.
		const wide = component.getTopBorder(500).content;
		expect(wide).not.toContain("\n");
		expect(stripAnsi(wide)).toContain("Right session");
		expect(stripAnsi(wide)).toContain("MODEL_RIGHT_");

		// Very narrow width pops the right group's segments to the overflow line.
		const border = component.getTopBorder(8);
		const lines = border.content.split("\n");
		expect(lines.length).toBe(2);
		expect(stripAnsi(lines[0])).not.toContain("Right session");
		const line2 = stripAnsi(lines[1]);
		// Line-1 budgeting may truncate the elastic title before it pops;
		// it must still land on the overflow row instead of being lost.
		expect(line2).toContain("Right s");
		expect(line2).toContain("MODEL_RIGHT_");
	});
});

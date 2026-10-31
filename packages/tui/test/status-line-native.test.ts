import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { StatusLineComponent } from "../src/status-line/component";
import type { PromptCacheStatus, StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { type PromptCacheDetailsView, promptCacheDetails } from "../src/status-line/prompt-cache";
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

const NO_USAGE = {
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
};

/** A status line over a session that reports `cacheStatus(nowMs)` as its prompt cache and `contextTokens` as its context size. */
function cacheStatusLine(
	settings: StatusLineSettings,
	cacheStatus: (nowMs: number, nextTokens?: number) => PromptCacheStatus | undefined,
	contextTokens?: number,
): StatusLineComponent {
	const session: StatusLineSession = {
		state: { messages: [] },
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "",
			getUsageStatistics: () => NO_USAGE,
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () =>
			contextTokens === undefined ? undefined : { tokens: contextTokens, contextWindow: 1_000_000, percent: 32 },
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
		getPromptCacheStatus: cacheStatus,
	};
	const host: StatusLineHost = {
		getSettings: () => settings,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};
	return new StatusLineComponent(session, host);
}

const TOUCHED_AT = Date.UTC(2026, 9, 29, 16, 0);
const TTL_MS = 5 * 60_000;
const WARM: PromptCacheStatus = {
	state: "warm",
	inferred: false,
	tier: "short",
	touchedAt: TOUCHED_AT,
	ttlMs: TTL_MS,
	cachedTokens: 316_000,
	nextTokens: 320_000,
};
const COLD_MODEL: PromptCacheStatus = {
	...WARM,
	state: "cold",
	reason: { kind: "model", from: "claude-opus-4-5", to: "claude-sonnet-4-5" },
};
const CACHE_SETTINGS: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["hostname"],
	rightSegments: ["cache", "cost"],
};

/** The composer's cache chip props; undefined when it has none. */
function cacheChip(line: StatusLineComponent): TspProps<"seg"> | undefined {
	const cache = line.describeComposerFacts().cache;
	if (!cache) return undefined;
	expect(cache.k).toBe("seg");
	return cache.p as TspProps<"seg">;
}

describe("native prompt-cache chip", () => {
	it("shows a cached prefix as a quiet chip beside the usage, outside the extras, opening /session", () => {
		setNativeRendering(true);
		const line = cacheStatusLine(CACHE_SETTINGS, () => WARM);
		const chip = cacheChip(line);
		expect(chip).toMatchObject({ role: "omp.composer.cache", actions: { click: "status.cache" } });
		expect(chip!.tone).toBeUndefined();
		expect(chip!.spans!.map(part => part.s)).toEqual(["muted"]);
		expect(chip!.spans!.map(part => part.t).join("")).toEndWith(" cached");
		expect(chip!.title).toContain("reads 316K from cache");
		expect(facts(line).map(seg => seg.key)).toEqual(["hostname"]);
	});

	it("marks an uncached prefix as a warning whose hover card carries the reason and the snapcompact hint", () => {
		setNativeRendering(true);
		const chip = cacheChip(cacheStatusLine(CACHE_SETTINGS, () => COLD_MODEL));
		expect(chip!.tone).toBe("warning");
		expect(chip!.spans!.map(part => part.t).join("")).toEndWith(" not cached");
		// Another model leaves nothing cached: the whole prompt is re-sent.
		expect(chip!.title).toContain("re-sends ~320K");
		const card = JSON.stringify(chip!.hovercard);
		expect(card).toContain("omp.composer.cache.card");
		expect(card).toContain("model changed: claude-opus-4-5 → claude-sonnet-4-5");
		expect(card).toContain("/compact snapcompact first to send less");
	});

	it("bounds the re-sent tokens when the change keeps the cached blocks ahead of it", () => {
		setNativeRendering(true);
		const compacted: PromptCacheStatus = { ...COLD_MODEL, reason: { kind: "compaction" } };
		const chip = cacheChip(cacheStatusLine(CACHE_SETTINGS, () => compacted));
		expect(chip!.title).toContain("re-sends up to ~320K");
	});

	it("names a rotated provider cache session as the reason, with the whole prompt re-sent", () => {
		setNativeRendering(true);
		const rekeyed: PromptCacheStatus = { ...COLD_MODEL, reason: { kind: "cache-key" } };
		const chip = cacheChip(cacheStatusLine(CACHE_SETTINGS, () => rekeyed));
		expect(chip!.spans!.map(part => part.t).join("")).toEndWith(" not cached");
		expect(chip!.title).toContain("re-sends ~320K uncached");
		expect(JSON.stringify(chip!.hovercard)).toContain("provider cache session changed");
	});

	it("has no chip when the session reports no prompt-cache status", () => {
		setNativeRendering(true);
		expect(cacheChip(cacheStatusLine(CACHE_SETTINGS, () => undefined))).toBeUndefined();
	});

	it("has no chip when the cache segment is not configured", () => {
		setNativeRendering(true);
		const line = cacheStatusLine(
			{ preset: "custom", leftSegments: ["hostname"], rightSegments: ["cost"] },
			() => WARM,
		);
		expect(cacheChip(line)).toBeUndefined();
	});

	it("hands the session the context size the status line already counted", () => {
		setNativeRendering(true);
		const cacheStatus = vi.fn((_nowMs: number, _nextTokens?: number) => WARM);
		cacheChip(cacheStatusLine(CACHE_SETTINGS, cacheStatus, 320_000));
		expect(cacheStatus).toHaveBeenCalledWith(expect.any(Number), 320_000);
	});
});

describe("prompt-cache expiry wakeup", () => {
	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	it("turns the chip to not cached at expiry with a single render request", () => {
		setNativeRendering(true);
		vi.useFakeTimers();
		setSystemTime(TOUCHED_AT);
		const expiresAt = TOUCHED_AT + TTL_MS;
		const line = cacheStatusLine(CACHE_SETTINGS, nowMs =>
			nowMs < expiresAt ? WARM : { ...WARM, state: "cold", reason: { kind: "expired", at: expiresAt } },
		);
		const repaint = vi.fn();
		line.watchBranch(repaint);
		try {
			// The first build arms the one wakeup for the whole lifetime.
			expect(cacheChip(line)!.tone).toBeUndefined();
			vi.advanceTimersByTime(TTL_MS - 1);
			expect(repaint).not.toHaveBeenCalled();
			expect(cacheChip(line)!.tone).toBeUndefined();

			vi.advanceTimersByTime(2);
			expect(repaint).toHaveBeenCalledTimes(1);
			expect(cacheChip(line)!.tone).toBe("warning");
		} finally {
			line.dispose();
		}
	});

	it("rebuilds a not-cached card once the local day turns, so its times carry their date", () => {
		setNativeRendering(true);
		vi.useFakeTimers();
		const expiredAt = new Date(2026, 9, 29, 23, 50).getTime();
		setSystemTime(expiredAt + 60_000);
		const cold: PromptCacheStatus = { ...WARM, state: "cold", reason: { kind: "expired", at: expiredAt } };
		const line = cacheStatusLine(CACHE_SETTINGS, () => cold);
		const repaint = vi.fn();
		line.watchBranch(repaint);
		const card = () => JSON.stringify(cacheChip(line)!.hovercard);
		try {
			expect(card()).not.toContain("Oct");
			vi.advanceTimersByTime(9 * 60_000 - 1);
			expect(repaint).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(repaint).toHaveBeenCalledTimes(1);
			expect(card()).toContain("Oct 29");
		} finally {
			line.dispose();
		}
	});
});

describe("promptCacheDetails", () => {
	it("reads times relative to now only in a snapshot", () => {
		const expired: PromptCacheStatus = { ...WARM, state: "cold", reason: { kind: "expired", at: TOUCHED_AT } };
		const now = TOUCHED_AT + 14 * 60_000;
		const why = (view: PromptCacheDetailsView) =>
			promptCacheDetails(expired, now, view).find(row => row.label === "Why not cached")!.value;
		expect(why("snapshot")).toEndWith(" (14 min ago)");
		expect(why("card")).not.toContain("ago");
		expect(why("snapshot").startsWith(why("card"))).toBe(true);

		const expires = (view: PromptCacheDetailsView) =>
			promptCacheDetails(WARM, TOUCHED_AT + 60_000, view).find(row => row.label === "Expires")!.value;
		expect(expires("snapshot")).toEndWith(" (in 4 min)");
		expect(expires("card")).not.toContain("(in");
		const longAgo: PromptCacheStatus = { ...expired, reason: { kind: "expired", at: now - 12 * 24 * 3_600_000 } };
		expect(promptCacheDetails(longAgo, now, "snapshot")[1]!.value).toEndWith(" (12 days ago)");
	});

	it("dates a time on another local day, so yesterday's never reads as later today", () => {
		const now = new Date(2026, 9, 29, 0, 10).getTime();
		const month = new Date(now).toLocaleString([], { month: "short" });
		const expiredAt = (at: number) =>
			promptCacheDetails({ ...WARM, state: "cold", reason: { kind: "expired", at } }, now, "card").find(
				row => row.label === "Why not cached",
			)!.value;
		const yesterday = expiredAt(new Date(2026, 9, 28, 23, 50).getTime());
		expect(yesterday).toContain(month);
		expect(yesterday).toContain("28");
		const today = expiredAt(new Date(2026, 9, 29, 0, 5).getTime());
		expect(today).toStartWith("expired at ");
		expect(today).not.toContain(month);

		// An expiry past midnight is dated the same way.
		const lateTonight = new Date(2026, 9, 29, 23, 40).getTime();
		const hourTier: PromptCacheStatus = { ...WARM, touchedAt: lateTonight, ttlMs: 3_600_000 };
		const expires = promptCacheDetails(hourTier, lateTonight, "card").find(row => row.label === "Expires")!.value;
		expect(expires).toContain(month);
		expect(expires).toContain("30");
	});
});

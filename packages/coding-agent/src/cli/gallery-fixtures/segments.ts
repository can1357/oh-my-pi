import { truncateToWidth } from "@oh-my-pi/pi-tui";
import type { StatusLineSegmentId } from "../../config/settings-schema";
import { ALL_SEGMENT_IDS, renderSegment } from "../../modes/components/status-line/segments";
import type { SegmentContext } from "../../modes/components/status-line/types";
import { theme } from "../../modes/theme/theme";
import type { GallerySessionOptions } from "./preview-session";
import { createGallerySession, GALLERY_CONTEXT_WINDOW } from "./preview-session";
import type { GalleryPreviewEntry } from "./types";

const FIXED_NOW = new Date(2026, 7, 29, 14, 7, 9);

interface SegmentVariantSpec {
	label: string;
	context?: Partial<SegmentContext>;
	session?: GallerySessionOptions;
}

/** Production status-segment registry in display order. */
export function getSegmentGalleryInventory(): readonly StatusLineSegmentId[] {
	return [...ALL_SEGMENT_IDS];
}

/** Deterministic full context for isolated status-segment previews and tests. */
export function createGallerySegmentContext(sessionOptions?: GallerySessionOptions): SegmentContext {
	return {
		session: createGallerySession(sessionOptions),
		now: FIXED_NOW,
		hostname: "gallery-host",
		sessionAccent: false,
		activeRepo: {
			cwd: "/workspace/oh-my-pi",
			repoRoot: "/workspace/oh-my-pi",
			relativeRepoRoot: "oh-my-pi",
			source: "single-direct-child-repo",
		},
		width: 100,
		options: {
			model: { showThinkingLevel: true },
			path: { abbreviate: false, maxLength: 40, stripWorkPrefix: false },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: true },
		},
		compactThinkingLevel: false,
		planMode: { enabled: true, paused: false },
		prewalk: null,
		loopMode: null,
		goalMode: null,
		vibeMode: null,
		collab: { role: "host", participantCount: 3 },
		usageStats: {
			input: 12_400,
			output: 3_600,
			cacheRead: 48_000,
			cacheWrite: 1_200,
			totalTokens: 65_200,
			orchestrationInput: 900,
			orchestrationOutput: 240,
			orchestrationCacheRead: 3_000,
			premiumRequests: sessionOptions?.premiumRequests ?? 2,
			cost: sessionOptions?.cost ?? 0.42,
			tokensPerSecond: 87.3,
		},
		contextPercent: 62,
		contextTokens: 124_000,
		contextWindow: GALLERY_CONTEXT_WINDOW,
		autoCompactEnabled: true,
		compactionSpeculation: "idle",
		speculationBlinkOn: false,
		subagentCount: 3,
		activeMs: 372_000,
		turnElapsedMs: null,
		git: {
			branch: "gallery/reference",
			status: { staged: 2, unstaged: 3, untracked: 1 },
			pr: { number: 1842, url: "https://github.com/can1357/oh-my-pi/pull/1842" },
		},
		worktree: null,
		usage: {
			tier: "Pro",
			fiveHour: { percent: 32, resetMinutes: 71 },
			sevenDay: { percent: 68, resetHours: 52 },
		},
	};
}

function variantsFor(id: StatusLineSegmentId): readonly SegmentVariantSpec[] {
	switch (id) {
		case "pi":
			return [
				{ label: "idle", context: { turnElapsedMs: null } },
				{ label: "active", context: { turnElapsedMs: 92_000 } },
				{ label: "focused subagent", context: { focusedAgentId: "Scout" } },
			];
		case "status":
			return [
				{ label: "multiple extension statuses", context: { hookStatuses: ["Indexer ready", "Tests passing"] } },
			];
		case "model":
			return [
				{ label: "normal" },
				{ label: "fast + advisor active", session: { fastMode: true, advisorStatus: "running" } },
				{ label: "advisor warning", session: { advisorStatus: "quota_exhausted" } },
				{ label: "advisor error", session: { advisorStatus: "error" } },
				{ label: "advisor paused", session: { advisorStatus: "paused" } },
				{ label: "advisor done (yielded)", session: { advisorStatus: "running", advisorYielded: true } },
			];
		case "mode":
			return [
				{ label: "active", context: { planMode: { enabled: true, paused: false } } },
				{ label: "warning / paused", context: { planMode: { enabled: true, paused: true } } },
				{ label: "prewalk active", context: { planMode: null, prewalk: { enabled: true } } },
				{ label: "vibe active", context: { planMode: null, vibeMode: { enabled: true } } },
				{
					label: "loop active",
					context: {
						planMode: null,
						loopMode: { state: "running", limit: { kind: "iterations", initial: 10, remaining: 4 } },
					},
				},
				{
					label: "loop paused",
					context: {
						planMode: null,
						loopMode: { state: "paused", limit: { kind: "iterations", initial: 10, remaining: 4 } },
					},
				},
				{
					label: "goal active",
					context: { planMode: null, goalMode: { enabled: true, paused: false } },
					session: { goalStatus: "active" },
				},
				{
					label: "goal paused",
					context: { planMode: null, goalMode: { enabled: true, paused: true } },
					session: { goalStatus: "paused" },
				},
				{
					label: "goal complete",
					context: { planMode: null, goalMode: { enabled: true, paused: false } },
					session: { goalStatus: "complete" },
				},
				{
					label: "goal budget warning",
					context: { planMode: null, goalMode: { enabled: true, paused: false } },
					session: { goalStatus: "budget-limited" },
				},
				{
					label: "goal dropped",
					context: { planMode: null, goalMode: { enabled: true, paused: false } },
					session: { goalStatus: "dropped" },
				},
			];
		case "path":
			return [
				{ label: "workspace path" },
				{
					label: "linked worktree",
					context: {
						options: { path: { stripWorkPrefix: true } },
						worktree: { projectName: "oh-my-pi", worktreeName: "gallery-reference" },
						git: { branch: "gallery-reference", status: null, pr: null },
					},
				},
			];
		case "git":
			return [
				{
					label: "clean",
					context: { git: { branch: "main", status: { staged: 0, unstaged: 0, untracked: 0 }, pr: null } },
				},
				{ label: "dirty" },
			];
		case "cost":
			return [
				{ label: "metered + premium + advisor" },
				{
					label: "subscription",
					session: { usingSubscription: true, cost: 0, premiumRequests: 0, advisorCost: 0 },
				},
				{
					label: "premium requests",
					session: { cost: 0, premiumRequests: 2, advisorCost: 0 },
				},
			];
		case "context_pct":
			return [
				{ label: "normal", context: { contextPercent: 22, contextTokens: 44_000 } },
				{ label: "warning", context: { contextPercent: 72, contextTokens: 144_000 } },
				{ label: "error", context: { contextPercent: 96, contextTokens: 192_000 } },
				{
					label: "active compaction",
					context: {
						contextPercent: 72,
						contextTokens: 144_000,
						compactionSpeculation: "running",
						speculationBlinkOn: true,
					},
				},
				{
					label: "armed compaction",
					context: { contextPercent: 72, contextTokens: 144_000, compactionSpeculation: "armed" },
				},
			];
		case "time":
			return [
				{ label: "24-hour with seconds" },
				{ label: "12-hour", context: { options: { time: { format: "12h", showSeconds: false } } } },
			];
		case "usage":
			return [
				{
					label: "all windows",
					context: {
						usage: {
							tier: "Pro",
							fiveHour: { percent: 32, resetMinutes: 71 },
							daily: { percent: 44, resetMinutes: 310 },
							sevenDay: { percent: 68, resetHours: 52 },
							monthly: { percent: 77, resetHours: 216 },
						},
					},
				},
				{
					label: "normal",
					context: { usage: { tier: "Pro", fiveHour: { percent: 24, resetMinutes: 75 } } },
				},
				{
					label: "warning",
					context: { usage: { tier: "Pro", fiveHour: { percent: 65, resetMinutes: 75 } } },
				},
				{
					label: "error",
					context: { usage: { tier: "Pro", fiveHour: { percent: 92, resetMinutes: 75 } } },
				},
			];
		case "collab":
			return [
				{ label: "host active", context: { collab: { role: "host", participantCount: 3 } } },
				{ label: "guest active", context: { collab: { role: "guest", participantCount: 3 } } },
			];
		default:
			return [{ label: "canonical" }];
	}
}

function renderIsolatedSegment(id: StatusLineSegmentId, spec: SegmentVariantSpec, width: number): readonly string[] {
	const base = createGallerySegmentContext(spec.session);
	const override = spec.context;
	const context: SegmentContext = {
		...base,
		...override,
		width,
		options: { ...base.options, ...override?.options },
		usageStats: { ...base.usageStats, ...override?.usageStats },
		git: { ...base.git, ...override?.git },
	};
	const rendered = renderSegment(id, context);
	const content = rendered.visible ? rendered.content : theme.fg("dim", "(hidden for this sample)");
	return [truncateToWidth(`  ${content}`, width)];
}

/** Every registered segment rendered directly through its production implementation. */
export function getSegmentGalleryEntries(): readonly GalleryPreviewEntry[] {
	return ALL_SEGMENT_IDS.map(id => ({
		id,
		heading: `segment · ${id}`,
		variants: variantsFor(id).map(spec => ({
			label: spec.label,
			render: width => renderIsolatedSegment(id, spec, width),
		})),
	}));
}

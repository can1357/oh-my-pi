/**
 * `omp gallery --surface segment`: every status-line segment alone on a bar,
 * in the variants that change how it reads, over the gallery session's
 * status facts.
 */
import { STATUS_LINE_SEGMENT_IDS, type StatusLineSegmentId } from "../../config/status-line-schema";
import type { StatusLineSegmentOptions } from "../../modes/view-model/status-line/types";
import { printRows } from "../../ui/print-rows";
import type { StatusFacts } from "../../ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../ui/status/segments";
import { createStatusLine } from "../../ui/status/status-line";
import "../../ui/styles/composer";
import "../../ui/styles/status";
import {
	GALLERY_BAR_PLACEMENT,
	GALLERY_CONTEXT_WINDOW,
	GALLERY_NOW,
	GALLERY_PROMPT_CACHE,
	galleryStatusFacts,
	galleryStatusSettings,
} from "./status-facts";
import type { GalleryPreviewEntry } from "./types";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

interface SegmentVariantSpec {
	label: string;
	facts?: Partial<StatusFacts>;
	options?: StatusLineSegmentOptions;
}

/** Segment options of the gallery bar (variants override per segment). */
const BASE_OPTIONS: StatusLineSegmentOptions = {
	model: { showThinkingLevel: true },
	path: { abbreviate: false, maxLength: 40, stripWorkPrefix: false },
	git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
	time: { format: "24h", showSeconds: true },
};

/** Production status-segment registry in display order. */
export function getSegmentGalleryInventory(): readonly StatusLineSegmentId[] {
	return [...STATUS_LINE_SEGMENT_IDS];
}

const LOOP_LIMIT = { kind: "iterations", initial: 10, remaining: 4 } as const;

/** A model served through a gateway, for the `model` segment's provider and id options. */
const GALLERY_ROUTED_MODEL: NonNullable<StatusFacts["model"]> = {
	id: "anthropic/claude-sonnet-4.5",
	name: "Claude Sonnet 4.5",
	provider: "openrouter",
	thinking: true,
	contextWindow: GALLERY_CONTEXT_WINDOW,
};

function variantsFor(id: StatusLineSegmentId): readonly SegmentVariantSpec[] {
	switch (id) {
		case "pi":
			return [
				{ label: "idle" },
				{ label: "active", facts: { turnStartedAt: GALLERY_NOW - 92_000 } },
				{ label: "focused subagent", facts: { focusedAgentId: "Scout" } },
			];
		case "status":
			return [
				{ label: "multiple extension statuses", facts: { hooks: ["Indexer ready", "Tests passing"] } },
				{
					label: "coloured extension status",
					facts: { hooks: ["\x1b[33mbuilding\x1b[39m", "\x1b[1;38;2;255;95;135mfailed\x1b[0m", "queued"] },
				},
			];
		case "model":
			return [
				{ label: "normal" },
				{
					label: "fast + advisor active",
					facts: { fastMode: true, advisor: { status: "running", yielded: false } },
				},
				{ label: "advisor warning", facts: { advisor: { status: "quota_exhausted", yielded: false } } },
				{ label: "advisor error", facts: { advisor: { status: "error", yielded: false } } },
				{ label: "advisor idle", facts: { advisor: { status: "idle", yielded: false } } },
				{ label: "advisor done (yielded)", facts: { advisor: { status: "running", yielded: true } } },
				{
					label: "provider prefix",
					options: { model: { showProvider: true } },
					facts: { model: GALLERY_ROUTED_MODEL },
				},
				{
					label: "provider + model id",
					options: { model: { showProvider: true, display: "id" } },
					facts: { model: GALLERY_ROUTED_MODEL },
				},
				{
					label: "model id + name",
					options: { model: { display: "full" } },
					facts: { model: GALLERY_ROUTED_MODEL },
				},
				{
					label: "provider + model id, max length 24",
					options: { model: { showProvider: true, display: "id", maxLength: 24 } },
					facts: { model: GALLERY_ROUTED_MODEL },
				},
			];
		case "mode": {
			const goal = (status: NonNullable<StatusFacts["goal"]>["status"], paused = false): Partial<StatusFacts> => ({
				plan: undefined,
				goal: { enabled: true, paused, status, tokensUsed: 12_400, tokenBudget: 50_000, showBudget: true },
			});
			return [
				{ label: "active", facts: { plan: { enabled: true, paused: false } } },
				{ label: "warning / paused", facts: { plan: { enabled: true, paused: true } } },
				{ label: "prewalk active", facts: { plan: undefined, prewalk: true } },
				{ label: "vibe active", facts: { plan: undefined, vibe: true } },
				{ label: "loop active", facts: { plan: undefined, loop: { state: "running", limit: LOOP_LIMIT } } },
				{ label: "loop paused", facts: { plan: undefined, loop: { state: "paused", limit: LOOP_LIMIT } } },
				{ label: "goal active", facts: goal("active") },
				{ label: "goal paused", facts: goal("paused", true) },
				{ label: "goal complete", facts: goal("complete") },
				{ label: "goal budget warning", facts: goal("budget-limited") },
				{ label: "goal dropped", facts: goal("dropped") },
			];
		}
		case "path":
			return [
				{ label: "workspace path", facts: { activeRepoRoot: "oh-my-pi" } },
				{
					label: "linked worktree",
					options: { path: { stripWorkPrefix: true } },
					facts: {
						worktree: { projectName: "oh-my-pi", worktreeName: "gallery-reference" },
						git: { branch: "gallery-reference", status: null, pr: null },
					},
				},
			];
		case "git":
			return [
				{
					label: "clean",
					facts: { git: { branch: "main", status: { staged: 0, unstaged: 0, untracked: 0 }, pr: null } },
				},
				{ label: "dirty" },
			];
		case "cost": {
			const usage = galleryStatusFacts().usage;
			return [
				{ label: "metered + premium + advisor" },
				{
					label: "subscription",
					facts: {
						usingSubscription: true,
						usage: { ...usage, cost: 0, premiumRequests: 0 },
						advisorCost: { cost: 0, usingSubscription: false },
					},
				},
				{
					label: "subscription + subagents",
					facts: {
						usingSubscription: true,
						usage: { ...usage, cost: 0.38, premiumRequests: 0 },
						advisorCost: { cost: 0, usingSubscription: false },
						subagentTreeCost: 1.27,
					},
				},
				{
					label: "premium requests",
					facts: {
						usage: { ...usage, cost: 0, premiumRequests: 2 },
						advisorCost: { cost: 0, usingSubscription: false },
					},
				},
			];
		}
		case "context_pct": {
			const context = (percent: number): Partial<StatusFacts> => ({
				context: { tokens: percent * 2_000, window: 200_000, percent },
			});
			return [
				{ label: "normal", facts: context(22) },
				{ label: "warning", facts: context(72) },
				{ label: "error", facts: context(96) },
				{ label: "active compaction", facts: { ...context(72), speculation: "running" } },
				{ label: "armed compaction", facts: { ...context(72), speculation: "armed" } },
			];
		}
		case "time":
			return [
				{ label: "24-hour with seconds" },
				{ label: "12-hour", options: { time: { format: "12h", showSeconds: false } } },
			];
		case "usage":
			return [
				{
					label: "all windows",
					facts: {
						quota: {
							tier: "Pro",
							fiveHour: { percent: 32, resetMinutes: 71 },
							daily: { percent: 44, resetMinutes: 310 },
							sevenDay: { percent: 68, resetHours: 52 },
							monthly: { percent: 77, resetHours: 216 },
						},
					},
				},
				{ label: "normal", facts: { quota: { tier: "Pro", fiveHour: { percent: 24, resetMinutes: 75 } } } },
				{ label: "warning", facts: { quota: { tier: "Pro", fiveHour: { percent: 65, resetMinutes: 75 } } } },
				{ label: "error", facts: { quota: { tier: "Pro", fiveHour: { percent: 92, resetMinutes: 75 } } } },
			];
		case "tree":
			return [
				{ label: "rewound", facts: { treePosition: { ahead: 3 } } },
				{ label: "on a branch", facts: { treePosition: { branch: { index: 2, count: 3 }, ahead: 0 } } },
				{ label: "rewound on a branch", facts: { treePosition: { branch: { index: 1, count: 2 }, ahead: 1 } } },
				{ label: "hidden (tip of a single line)" },
			];
		case "collab":
			return [
				{ label: "host active", facts: { collab: { role: "host", participantCount: 3 } } },
				{ label: "guest active", facts: { collab: { role: "guest", participantCount: 3 } } },
			];
		case "vim":
			return [
				{ label: "normal", facts: { vim: { mode: "normal", pending: "", selectedLines: 0, display: "text" } } },
				{ label: "insert", facts: { vim: { mode: "insert", pending: "", selectedLines: 0, display: "text" } } },
				{
					label: "visual with count",
					facts: { vim: { mode: "visual-line", pending: "2d", selectedLines: 4, display: "text" } },
				},
				{ label: "icon mode", facts: { vim: { mode: "normal", pending: "", selectedLines: 0, display: "icon" } } },
			];
		case "cache":
			return [
				{ label: "cached", facts: { promptCache: GALLERY_PROMPT_CACHE.warm } },
				{ label: "likely cached (inferred)", facts: { promptCache: GALLERY_PROMPT_CACHE.likelyWarm } },
				{ label: "not cached — expired", facts: { promptCache: GALLERY_PROMPT_CACHE.coldExpired } },
				{ label: "not cached — model changed", facts: { promptCache: GALLERY_PROMPT_CACHE.coldModel } },
				{ label: "hidden (nothing to report)" },
			];
		case "subagents":
			return [{ label: "running", facts: { subagents: 3 } }];
		default:
			return [{ label: "canonical" }];
	}
}

/** Segment `id` alone on a bar, or a dim note when the sample hides it. */
function renderIsolatedSegment(id: StatusLineSegmentId, spec: SegmentVariantSpec, width: number): readonly string[] {
	const facts = galleryStatusFacts(spec.facts);
	const segmentOptions: StatusLineSegmentOptions = { ...BASE_OPTIONS };
	const overrides = spec.options ?? {};
	for (const key in overrides) {
		const name = key as keyof StatusLineSegmentOptions;
		(segmentOptions as Record<string, unknown>)[name] = { ...BASE_OPTIONS[name], ...overrides[name] };
	}
	const settings = galleryStatusSettings([id], [], { segmentOptions });
	// A running subagent count shows as the bar's badge rather than the segment.
	const shown = segmentView(id, facts, effectiveStatusSettings(settings)) !== null || facts.subagents > 0;
	if (!shown) return [currentTheme().fg("dim", "  (hidden for this sample)")];
	return printRows(
		() =>
			createStatusLine({
				settings: () => settings,
				facts: () => facts,
				placement: () => GALLERY_BAR_PLACEMENT,
			}).preview(undefined),
		width,
		{ now: GALLERY_NOW },
	);
}

/** Every registered segment rendered directly through its production implementation. */
export function getSegmentGalleryEntries(): readonly GalleryPreviewEntry[] {
	return STATUS_LINE_SEGMENT_IDS.map(id => ({
		id,
		heading: `segment · ${id}`,
		variants: variantsFor(id).map(spec => ({
			label: spec.label,
			render: width => renderIsolatedSegment(id, spec, width),
		})),
	}));
}

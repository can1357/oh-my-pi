/**
 * Status-line segments: each configured segment id becomes a `seg` view —
 * native spans, icon and tone, plus its terminal look ({@link SegLook}) —
 * or nothing while it has nothing to show.
 */
import { pathToFileURL } from "node:url";
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { StatusLineSegmentId } from "../../config/status-line-schema";
import { STATUS_LINE_PRESETS } from "../../modes/view-model/status-line/presets";
import type { StatusLineSegmentOptions, StatusLineSettings } from "../../modes/view-model/status-line/types";
import { sanitizeStatusText } from "../../modes/view-model/chrome/shared";
import { truncateToWidth } from "../../utils/text-width";
import type { StatusFacts } from "./facts";
import {
	billingSummary,
	clampStart,
	contextColor,
	contextLevel,
	contextTone,
	displayCwd,
	formatContextUsage,
} from "./format";
import type { IconPiece, LookPiece, SegLook, TextPiece } from "./look";

/** Settings after the preset is applied. */
export interface EffectiveStatusSettings extends StatusLineSettings {
	readonly leftSegments: StatusLineSegmentId[];
	readonly rightSegments: StatusLineSegmentId[];
	readonly segmentOptions: StatusLineSegmentOptions;
}

/** The preset's segments and options under the user's overrides; segment lists apply to `custom` only. */
export function effectiveStatusSettings(settings: StatusLineSettings): EffectiveStatusSettings {
	const preset = STATUS_LINE_PRESETS[settings.preset ?? "default"] ?? STATUS_LINE_PRESETS.default;
	const custom = settings.preset === "custom";
	const options: Record<string, Record<string, unknown>> = {};
	for (const source of [preset.segmentOptions, settings.segmentOptions] as Record<string, object>[]) {
		for (const id in source) options[id] = { ...options[id], ...source[id] };
	}
	return {
		...settings,
		leftSegments: custom ? (settings.leftSegments ?? preset.leftSegments) : preset.leftSegments,
		rightSegments: custom ? (settings.rightSegments ?? preset.rightSegments) : preset.rightSegments,
		separator: settings.separator ?? preset.separator,
		segmentOptions: options as StatusLineSegmentOptions,
	};
}

/** A terminal-clocked readout a native `seg` carries as a child instead of text. */
export type SegMotion =
	| { readonly kind: "rate"; readonly value: number; readonly unit: string }
	| { readonly kind: "elapsed"; readonly age: number; readonly stopped?: number };

/** One visible segment. */
export interface SegView {
	readonly spans: TspSpan[];
	readonly icon?: string;
	readonly tone?: TspTone;
	readonly title?: string;
	readonly motion?: SegMotion;
	readonly look: SegLook;
}

/** Inputs every segment reads. */
interface SegInput {
	readonly facts: StatusFacts;
	readonly options: StatusLineSegmentOptions;
	readonly compactThinking: boolean;
	/** Seed of the session accent; undefined when it is off or the session is unnamed. */
	readonly accent: string | undefined;
	readonly symbols: SymbolSet;
}

const glyph = (input: SegInput, key: string): string => input.symbols.symbol(key);

const span = (t: string, s?: string): TspSpan => (s ? { t, s } : { t });

function view(input: SegInput, spans: TspSpan[], pieces: LookPiece[], icon?: string, tone?: TspTone): SegView {
	const look: SegLook = input.accent ? { pieces, title: input.accent } : { pieces };
	return { spans, look, ...(icon !== undefined ? { icon } : {}), ...(tone !== undefined ? { tone } : {}) };
}

/** Native token of session-accented text. */
function nativeAccent(input: SegInput, color: string): string {
	return input.accent ? "accent" : color;
}

/** Terminal token of session-accented text. */
function lookAccent(input: SegInput, color: string): string {
	return input.accent ? "sessionAccent" : color;
}

function toneOf(color: string): TspTone | undefined {
	return color === "warning" || color === "error" || color === "success" ? color : undefined;
}

/** The thinking-effort word, or undefined when the model has no thinking. */
export function thinkingWord(facts: StatusFacts): string | undefined {
	if (!facts.model?.thinking) return undefined;
	if (facts.autoThinking) return facts.autoResolvedLevel ?? "auto";
	return facts.thinkingLevel ?? "off";
}

/** Look pieces of the thinking display (`◒ high`, `⦸ off`, `⟳ auto`, `⟳ high`); empty when hidden. */
function thinkingPieces(facts: StatusFacts, s: string): [] | [IconPiece, ...TextPiece[]] {
	if (!facts.model?.thinking) return [];
	if (facts.autoThinking) {
		// Keep the auto indicator on a resolved level so it reads differently from a pinned one.
		return [
			{ icon: "thinking.autoPending", s },
			{ t: facts.autoResolvedLevel ?? "auto", s },
		];
	}
	const level = facts.thinkingLevel ?? "off";
	if (level === "off")
		return [
			{ icon: "status.disabled", s },
			{ t: "off", s },
		];
	return [{ icon: `thinking.${level}`, else: level, s, space: "none" }];
}

/**
 * `id` and `full` show the selector instead of the display name; `showProvider` prefixes the provider;
 * `maxLength` cuts the end with `…`.
 */
function modelLabel(facts: StatusFacts, options: StatusLineSegmentOptions["model"] = {}): string {
	const model = facts.model;
	const id = model?.id || "no-model";
	const raw = model?.name || id;
	const name = raw.startsWith("Claude ") ? raw.slice(7) : raw;
	let label = name;
	if (options.display === "id") label = id;
	else if (options.display === "full") label = name !== id ? `${id} (${name})` : id;
	if (options.showProvider && model?.provider) label = `${model.provider}/${label}`;
	// Ids and providers can come from custom configs; keep the bar on one row.
	label = sanitizeStatusText(label);
	return options.maxLength !== undefined ? truncateToWidth(label, options.maxLength) : label;
}

const ADVISOR_COLORS = { error: "error", quota_exhausted: "warning", running: "success", idle: "dim" } as const;

function piSeg(input: SegInput): SegView {
	const { facts } = input;
	if (facts.focusedAgentId) {
		return view(
			input,
			[span(facts.focusedAgentId, "warning")],
			[
				{ icon: "ghost", s: "warning" },
				{ t: facts.focusedAgentId, s: "warning" },
			],
			"ghost",
			"warning",
		);
	}
	const profile = input.options.pi?.showProfile !== false && facts.profile ? sanitizeStatusText(facts.profile) : "";
	const working = facts.turnStartedAt !== undefined;
	const piece: LookPiece = {
		brand: working ? facts.turnStartedAt! : null,
		s: working ? lookAccent(input, "accent") : "dim",
		...(facts.brandEdgeAt !== undefined
			? { fadeFrom: working ? "dim" : lookAccent(input, "accent"), fadeAt: facts.brandEdgeAt }
			: {}),
		...(facts.awaitingAnswer ? { awaiting: true } : {}),
		...(profile ? { profile } : {}),
	};
	return view(input, profile ? [span(profile, "muted")] : [], [piece], "omp", "muted");
}

function statusSeg(input: SegInput): SegView | null {
	const statuses = input.facts.hooks.filter(status => sanitizeStatusText(status) !== "");
	if (statuses.length === 0) return null;
	// The dot between statuses is dim natively too, apart from the accent statuses (#15740).
	const accent = nativeAccent(input, "accent");
	const spans: TspSpan[] = [];
	for (const status of statuses) {
		if (spans.length > 0) spans.push(span(glyph(input, "sep.dot"), "dim"));
		spans.push(span(sanitizeStatusText(status), accent));
	}
	return view(input, spans, [{ statuses, s: lookAccent(input, "accent") }]);
}

function modelSeg(input: SegInput): SegView {
	const { facts } = input;
	const name = modelLabel(facts, input.options.model);
	const native = nativeAccent(input, "statusLineModel");
	const look = lookAccent(input, "statusLineModel");
	const showLevel = input.options.model?.showThinkingLevel !== false;
	const thinking = showLevel ? thinkingPieces(facts, look) : [];
	const compact = input.compactThinking && thinking.length > 0;
	const pieces: LookPiece[] = [
		thinking.length > 0 && compact ? { ...thinking[0], lead: true, space: "after" } : { icon: "model", s: look },
		{ t: name, s: look },
	];
	const spans: TspSpan[] = [span(name, native)];
	const advisor = facts.advisor;
	if (advisor) {
		const color = ADVISOR_COLORS[advisor.status];
		const icon = advisor.yielded ? ["advisorClosed", "advisor"] : ["advisor"];
		pieces.push({ icon, s: color, space: "before" });
		spans.push(span(` ${glyph(input, `icon.${icon[0]}`) || glyph(input, "icon.advisor")}`, color));
	}
	if (facts.fastMode) {
		pieces.push({ icon: "fast", s: look, space: "before" });
		spans.push(span(` ${glyph(input, "icon.fast")}`, native));
	}
	if (!compact && thinking.length > 0) pieces.push({ icon: "sep.dot", s: look, space: "none" }, ...thinking);
	const level = showLevel ? thinkingWord(facts) : undefined;
	if (level !== undefined) spans.push(span(" · ", "dim"), span(level, thinkingToken(level)));
	if (facts.slowModeLabel) {
		pieces.push({ icon: "sep.dot", s: "warning", space: "none" }, { t: facts.slowModeLabel, s: "warning" });
		spans.push(span(`${glyph(input, "sep.dot")}${facts.slowModeLabel}`, "warning"));
	}
	return view(input, spans, pieces, "model", facts.slowModeLabel ? "warning" : undefined);
}

/** Theme token of a thinking level's color. */
function thinkingToken(level: string): string {
	const known = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return known.includes(level) ? `thinking${level[0]!.toUpperCase()}${level.slice(1)}` : "muted";
}

function loopLimit(limit: NonNullable<StatusFacts["loop"]>["limit"], now: number): string | undefined {
	if (!limit) return undefined;
	if (limit.kind === "iterations") return `${limit.remaining}/${limit.initial}`;
	const total = Math.max(0, Math.ceil((limit.deadlineMs - now) / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""} left`;
	if (minutes > 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""} left`;
	return `${seconds}s left`;
}

/** Loop condition as `until: <command>`, cut to 40 columns. */
function loopCondition(condition: NonNullable<NonNullable<StatusFacts["loop"]>["condition"]>): string {
	const label = condition.until ? "until" : "while";
	const command = sanitizeStatusText(condition.command);
	const room = Math.max(1, 40 - label.length - 2);
	return `${label}: ${command.length > room ? `${command.slice(0, Math.max(0, room - 1))}…` : command}`;
}

function modeSeg(input: SegInput): SegView | null {
	const { facts } = input;
	const accent = lookAccent(input, "accent");
	const plan = facts.plan;
	if (plan && (plan.enabled || plan.paused)) {
		if (plan.paused) {
			return view(
				input,
				[span("Plan (paused)", "warning")],
				[
					{ icon: "plan", s: "warning" },
					{ t: "Plan", s: "warning" },
					{ icon: "pause", s: "warning", space: "before", else: " (paused)" },
				],
				"plan",
				"warning",
			);
		}
		return view(
			input,
			[span("Plan", nativeAccent(input, "accent"))],
			[
				{ icon: "plan", s: accent },
				{ t: "Plan", s: accent },
			],
			"plan",
		);
	}
	if (facts.prewalk) {
		return view(
			input,
			[span("Prewalk", nativeAccent(input, "accent"))],
			[
				{ icon: "prewalk", s: accent },
				{ t: "Prewalk", s: accent },
			],
			"prewalk",
		);
	}
	const goal = facts.goal;
	if (goal && (goal.enabled || goal.paused)) {
		const status = goal.status ?? (goal.paused ? "paused" : "active");
		const looks: Record<string, { icon: string[]; native: string; color: string }> = {
			active: { icon: ["goal"], native: "goal", color: "accent" },
			paused: { icon: ["pause", "status.pending"], native: "pause", color: "warning" },
			complete: { icon: ["status.success"], native: "success", color: "success" },
			"budget-limited": { icon: ["status.warning"], native: "warning", color: "warning" },
			dropped: { icon: ["status.aborted"], native: "aborted", color: "dim" },
		};
		const goalLook = looks[status] ?? looks.active!;
		let label = "Goal";
		if (goal.showBudget && goal.tokensUsed !== undefined) {
			label += ` ${formatNumber(goal.tokensUsed)}${goal.tokenBudget !== undefined ? `/${formatNumber(goal.tokenBudget)}` : ""}`;
		}
		const s = goalLook.color === "accent" ? accent : goalLook.color;
		return view(
			input,
			[span(label, goalLook.color === "accent" ? nativeAccent(input, "accent") : goalLook.color)],
			[
				{ icon: goalLook.icon, s },
				{ t: label, s },
			],
			goalLook.native,
			toneOf(goalLook.color),
		);
	}
	if (facts.vibe) {
		return view(
			input,
			[span("Vibe", nativeAccent(input, "accent"))],
			[
				{ icon: "agents", s: accent },
				{ t: "Vibe", s: accent },
			],
			"agents",
		);
	}
	const loop = facts.loop;
	if (loop) {
		const paused = loop.state === "paused";
		const color = paused ? "warning" : "customMessageLabel";
		const state = loop.state === "waiting" ? "next prompt repeats" : loop.state;
		const parts = [`Loop${loop.state === "waiting" ? ":" : ""} ${state}`];
		const limit = loopLimit(loop.limit, facts.now);
		if (limit) parts.push(limit);
		if (loop.condition) parts.push(loopCondition(loop.condition));
		const text = parts.join(" ");
		return view(
			input,
			[span(text, color)],
			[
				{ icon: paused ? ["pause", "loop"] : ["loop"], s: color },
				{ t: text, s: color },
			],
			paused ? "pause" : "loop",
			paused ? "warning" : undefined,
		);
	}
	return null;
}

/** Native path spans: the parent dims, the leaf reads strong. */
function pathSpans(value: string): TspSpan[] {
	const slash = value.lastIndexOf("/", value.length - 2);
	if (slash < 0 || slash + 1 >= value.length) return [span(value, "statusLinePath strong")];
	return [
		span(value.slice(0, slash + 1), "statusLinePath dim"),
		span(value.slice(slash + 1), "statusLinePath strong"),
	];
}

function pathSeg(input: SegInput): SegView {
	const { facts } = input;
	const opts = input.options.path ?? {};
	const strip = opts.stripWorkPrefix !== false;
	const max = opts.maxLength ?? 40;
	const href = pathToFileURL(facts.cwd).href;
	const s = "statusLinePath";
	if (strip && facts.worktree) {
		const { projectName, worktreeName } = facts.worktree;
		const label = facts.git?.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
		const out = view(
			input,
			pathSpans(label),
			[
				{ icon: "worktree", s },
				{ t: clampStart(label, max), s, href },
			],
			"worktree",
		);
		return { ...out, look: { ...out.look, truncate: "start" } };
	}
	const shown = displayCwd(facts.cwd, { home: facts.home, strip, abbreviate: opts.abbreviate !== false });
	const repo = facts.activeRepoRoot !== undefined ? ` ↳ ${facts.activeRepoRoot}` : "";
	const spans = pathSpans(opts.maxLength !== undefined ? clampStart(shown.text, opts.maxLength) : shown.text);
	if (repo) spans.push(span(repo, "statusLinePath dim"));
	const pieces: LookPiece[] = [
		{ icon: shown.scratch && strip ? "scratchFolder" : "folder", s },
		{ t: clampStart(shown.text, max), s, href },
	];
	if (repo) pieces.push({ t: repo, s });
	const out = view(input, spans, pieces, shown.scratch && strip ? "scratch-folder" : "folder");
	return { ...out, look: { ...out.look, truncate: "start" } };
}

function gitSeg(input: SegInput): SegView | null {
	const git = input.facts.git;
	if (!git || (!git.branch && !git.status)) return null;
	const opts = input.options.git ?? {};
	const status = git.status;
	const dirty = status !== null && (status.staged > 0 || status.unstaged > 0 || status.untracked > 0);
	const color = dirty ? "statusLineGitDirty" : "statusLineGitClean";
	const showBranch = opts.showBranch !== false;
	const counts: [string, string][] = [];
	if (status) {
		if (opts.showUnstaged !== false && status.unstaged > 0) counts.push([`*${status.unstaged}`, "statusLineDirty"]);
		if (opts.showStaged !== false && status.staged > 0) counts.push([`+${status.staged}`, "statusLineStaged"]);
		if (opts.showUntracked !== false && status.untracked > 0)
			counts.push([`?${status.untracked}`, "statusLineUntracked"]);
	}
	const branch = showBranch && git.branch ? git.branch : undefined;
	if (!branch && counts.length === 0) return null;
	const pieces: LookPiece[] = [];
	const spans: TspSpan[] = [];
	if (branch) {
		pieces.push({ icon: "branch", s: color }, { t: branch, s: color });
		spans.push(span(branch, color));
	} else if (!showBranch) pieces.push({ icon: "git", s: color });
	counts.forEach(([text, token], index) => {
		if (index > 0 || branch) pieces.push({ t: " ", s: index > 0 ? undefined : color });
		pieces.push({ t: text, s: token });
		spans.push(span(spans.length > 0 ? ` ${text}` : text, token));
	});
	return view(input, spans, pieces, branch ? "branch" : "git", dirty ? "warning" : undefined);
}

function prSeg(input: SegInput): SegView | null {
	const pr = input.facts.git?.pr;
	if (!pr) return null;
	const s = lookAccent(input, "accent");
	const label = `#${pr.number}`;
	return view(
		input,
		[{ t: label, s: `${nativeAccent(input, "accent")} link`, href: pr.url }],
		[
			{ icon: "pr", s, href: pr.url },
			{ t: label, s, href: pr.url },
		],
		"pr",
	);
}

function statSeg(input: SegInput, value: number, icon: string, color: string): SegView | null {
	if (!value) return null;
	const text = formatNumber(value);
	return view(
		input,
		[span(text, color)],
		[
			{ icon, s: color },
			{ t: text, s: color },
		],
		icon,
	);
}

/** The session's own spend and its subagent tree's, as the cost segment bills them. */
function sessionSpend(facts: SegInput["facts"]): { own: number; subagents: number } {
	return {
		own: Math.max(0, facts.usage.cost - (facts.usage.subagentCost ?? 0)),
		subagents: Math.max(facts.subagentTreeCost ?? 0, facts.usage.subagentCost ?? 0),
	};
}

/**
 * Everything the session spent, split by billing: `paid` in dollars, `subscription` on a plan
 * (the session and its subagents bill as the session does, an advisor as itself). Hosts with
 * little room (Tern's phone) show one total from these rather than the cost segment's text.
 */
export function spendTotals(facts: SegInput["facts"]): { paid: number; subscription: number } {
	const { own, subagents } = sessionSpend(facts);
	const totals = { paid: 0, subscription: 0 };
	totals[facts.usingSubscription ? "subscription" : "paid"] += own + subagents;
	const advisor = facts.advisorCost;
	if (advisor) totals[advisor.usingSubscription ? "subscription" : "paid"] += advisor.cost;
	return totals;
}

function costSeg(input: SegInput): SegView | null {
	const { facts, symbols } = input;
	const { own, subagents } = sessionSpend(facts);
	const text = billingSummary(
		{
			cost: own,
			subagentCost: subagents,
			usingSubscription: facts.usingSubscription,
			premiumRequests: facts.usage.premiumRequests,
			digits: 2,
			pricingPeriod: facts.pricingPeriod,
			advisor: facts.advisorCost,
			aiu: facts.usage.aiu,
		},
		symbols,
	);
	if (!text) return null;
	return view(input, [span(text, "statusLineCost")], [{ t: text, s: "statusLineCost" }]);
}

function contextSeg(input: SegInput): SegView {
	const { facts } = input;
	const { percent, window, tokens } = facts.context;
	const level = contextLevel(percent ?? 0, window);
	const color = contextColor(level);
	const text = percent === null && window > 0 ? formatNumber(window) : formatContextUsage(percent, window, tokens);
	const spans: TspSpan[] = [span(text, color)];
	const pieces: LookPiece[] = [{ icon: "context" }, { t: text, s: color }];
	if (facts.autoCompact) {
		const speculation = facts.speculation ?? "idle";
		const lit = speculation !== "idle";
		pieces.push({ icon: "auto", s: lit ? lookAccent(input, "accent") : color, space: "before", bare: true });
		const auto: TspSpan = { t: ` ${glyph(input, "icon.auto")}`, s: lit ? nativeAccent(input, "accent") : color };
		spans.push(speculation === "running" ? { ...auto, fx: "pulse" } : auto);
	}
	return view(input, spans, pieces, "context", contextTone(level));
}

function clock(now: number, opts: StatusLineSegmentOptions["time"]): string {
	const date = new Date(now);
	let hours = date.getHours();
	let suffix = "";
	if (opts?.format === "12h") {
		suffix = hours >= 12 ? "pm" : "am";
		hours = hours % 12 || 12;
	}
	let text = `${hours}:${date.getMinutes().toString().padStart(2, "0")}`;
	if (opts?.showSeconds) text += `:${date.getSeconds().toString().padStart(2, "0")}`;
	return text + suffix;
}

function quotaColor(percent: number): string {
	return percent >= 80 ? "error" : percent >= 50 ? "warning" : "muted";
}

function resetSpan(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		if (value < 60) return `${value}m`;
		const minutes = value % 60;
		return minutes > 0 ? `${Math.floor(value / 60)}h ${minutes}m` : `${Math.floor(value / 60)}h`;
	}
	if (value < 24) return `${value}h`;
	const hours = value % 24;
	return hours > 0 ? `${Math.floor(value / 24)}d ${hours}h` : `${Math.floor(value / 24)}d`;
}

function usageSeg(input: SegInput): SegView | null {
	const quota = input.facts.quota;
	if (!quota || (!quota.fiveHour && !quota.daily && !quota.sevenDay && !quota.monthly && !quota.resetCredits)) {
		return null;
	}
	const groups: TspSpan[][] = [];
	if (quota.tier) {
		const tier = sanitizeStatusText(quota.tier);
		if (tier) groups.push([span(tier.length > 40 ? `${tier.slice(0, 39)}…` : tier, nativeAccent(input, "accent"))]);
	}
	const window = (label: string, percent: number, reset: number | undefined, unit: "m" | "h", floor: boolean) => {
		const whole = floor ? Math.floor(percent) : Math.round(percent);
		const spans = [span(`${label} `), span(`${whole}%`, quotaColor(percent))];
		if (reset !== undefined) spans.push(span(` (${resetSpan(reset, unit)})`, "muted"));
		groups.push(spans);
	};
	if (quota.fiveHour) window("5h", quota.fiveHour.percent, quota.fiveHour.resetMinutes, "m", false);
	if (quota.daily) window("1d", quota.daily.percent, quota.daily.resetMinutes, "m", false);
	if (quota.sevenDay) window("7d", quota.sevenDay.percent, quota.sevenDay.resetHours, "h", false);
	if (quota.monthly) window("mo", quota.monthly.percent, quota.monthly.resetHours, "h", true);
	const resets = quota.resetCredits;
	if (resets) {
		let text = `✦ ${resets.bankedCount}`;
		if (resets.redeemableCount !== resets.bankedCount) text += ` (${resets.redeemableCount} usable)`;
		if (resets.expiryHours !== undefined) {
			text += ` ${resets.expiring ? `▲ ${resets.expiring.count} ` : ""}exp ${resetSpan(resets.expiryHours, "h")}`;
		} else if (resets.expired) text += " expired";
		if (resets.redeemableCount === 0 && resets.unavailableReason) {
			const reason = sanitizeStatusText(resets.unavailableReason);
			if (reason) text += ` ${reason}`;
		}
		const color = resets.expiring
			? resets.expiring.tier === "imminent"
				? "error"
				: "warning"
			: resets.redeemableCount > 0
				? "success"
				: "warning";
		groups.push([span(text, color)]);
	}
	const spans: TspSpan[] = [];
	const pieces: LookPiece[] = [{ icon: "time" }];
	for (const group of groups) {
		if (spans.length > 0) {
			spans.push(span(glyph(input, "sep.dot"), "dim"));
			pieces.push({ icon: "sep.dot", space: "none" });
		}
		spans.push(...group);
		for (const part of group)
			pieces.push({ t: part.t, s: part.s === "accent" ? lookAccent(input, "accent") : part.s });
	}
	return view(input, spans, pieces, "time");
}

function vimSeg(input: SegInput): SegView | null {
	const vim = input.facts.vim;
	if (!vim) return null;
	// With the mode hidden, the command being typed still shows: like Vim's showcmd, it is the one
	// sign that a half-typed `15d` waits for its last key.
	if (vim.display === "none") {
		return vim.pending ? view(input, [span(vim.pending, "muted")], [{ t: vim.pending, s: "muted" }]) : null;
	}
	const labels = { insert: "INSERT", normal: "NORMAL", visual: "VISUAL", "visual-line": "V-LINE", replace: "REPLACE" };
	const icons = {
		insert: "vimInsert",
		normal: "vimNormal",
		visual: "vimVisual",
		"visual-line": "vimVisualLine",
		replace: "vimReplace",
	};
	const colors = {
		insert: "success",
		normal: "accent",
		visual: "warning",
		"visual-line": "warning",
		replace: "accent",
	};
	const color = colors[vim.mode];
	const lines = vim.selectedLines > 1 ? `${vim.selectedLines}L` : "";
	const pieces: LookPiece[] = [];
	const spans: TspSpan[] = [];
	if (vim.display === "icon") {
		pieces.push({ icon: icons[vim.mode], s: color, space: "none" });
		if (lines) {
			pieces.push({ t: ` ${lines}`, s: color });
			spans.push(span(lines, color));
		}
	} else {
		const label = lines ? `${labels[vim.mode]} ${lines}` : labels[vim.mode];
		pieces.push({ t: label, s: color });
		spans.push(span(label, color));
	}
	if (vim.pending) {
		pieces.push({ t: ` ${vim.pending}`, s: "muted" });
		spans.push(span(` ${vim.pending}`, "muted"));
	}
	return view(input, spans, pieces, vim.display === "icon" ? `vim-${vim.mode}` : undefined, toneOf(color));
}

function treeSeg(input: SegInput): SegView | null {
	const position = input.facts.treePosition;
	if (!position) return null;
	const parts: string[] = [];
	if (position.branch) parts.push(`${position.branch.index}/${position.branch.count}`);
	if (position.ahead > 0) parts.push(`${position.ahead} ahead`);
	const label = parts.join(" · ");
	if (!label) return null;
	const facts: string[] = [];
	if (position.branch) facts.push(`branch ${position.branch.index} of ${position.branch.count}`);
	if (position.ahead > 0) facts.push(`${position.ahead} ${position.ahead === 1 ? "turn" : "turns"} ahead`);
	return {
		...view(
			input,
			[span(label, "accent")],
			[{ icon: "tree", s: "accent" }, { t: label, s: "accent" }, { t: " " }, { t: "/tree", s: "dim" }],
			"tree",
		),
		title: `Session tree: ${facts.join(", ")}\nOpen /tree to move between branches`,
	};
}

/** The view of segment `id` in the active theme, or null while it shows nothing. */
export function segmentView(
	id: StatusLineSegmentId,
	facts: StatusFacts,
	settings: EffectiveStatusSettings,
): SegView | null {
	const input: SegInput = {
		facts,
		options: settings.segmentOptions,
		compactThinking: settings.compactThinkingLevel ?? false,
		accent: settings.sessionAccent !== false ? facts.sessionName || undefined : undefined,
		symbols: currentTheme().symbols,
	};
	const usage = facts.usage;
	switch (id) {
		case "pi":
			return piSeg(input);
		case "status":
			return statusSeg(input);
		case "model":
			return modelSeg(input);
		case "mode":
			return modeSeg(input);
		case "path":
			return pathSeg(input);
		case "git":
			return gitSeg(input);
		case "pr":
			return prSeg(input);
		case "subagents":
			return facts.subagents > 0 ? statSeg(input, facts.subagents, "agents", "statusLineSubagents") : null;
		case "token_in":
			return statSeg(input, usage.input, "input", "statusLineSpend");
		case "token_out":
			return statSeg(input, usage.output, "output", "statusLineOutput");
		case "token_total": {
			const total =
				usage.input +
				usage.output +
				usage.cacheWrite +
				(usage.orchestrationInput ?? 0) +
				(usage.orchestrationOutput ?? 0);
			return statSeg(input, total, "tokens", "statusLineSpend");
		}
		case "token_rate": {
			const rate = facts.tokensPerSecond;
			if (!rate) return null;
			const text = `${rate.toFixed(1)} tok/s`;
			const pieces: LookPiece[] = [
				{ icon: "throughput", s: "statusLineOutput" },
				{ t: text, s: "statusLineOutput" },
			];
			// The terminal eases the readout between updates.
			const motion: SegMotion = { kind: "rate", value: Number(rate.toFixed(1)), unit: "tok/s" };
			return { ...view(input, [], pieces, "throughput"), motion };
		}
		case "cost":
			return costSeg(input);
		case "context_pct":
			return contextSeg(input);
		case "context_total": {
			const window = facts.context.window;
			if (!window) return null;
			const text = formatNumber(window);
			return view(
				input,
				[span(text, "statusLineContext")],
				[
					{ icon: "context", s: "statusLineContext" },
					{ t: text, s: "statusLineContext" },
				],
				"context",
			);
		}
		case "time_spent": {
			if (facts.activeMs < 1000) return null;
			const text = formatDuration(facts.activeMs);
			const running = facts.turnStartedAt !== undefined;
			const motion: SegMotion = running
				? { kind: "elapsed", age: facts.activeMs }
				: { kind: "elapsed", age: facts.activeMs, stopped: facts.activeMs };
			return { ...view(input, [], [{ icon: "time" }, { t: text }], "time"), motion };
		}
		case "time": {
			const text = clock(facts.now, settings.segmentOptions.time);
			return view(input, [span(text)], [{ icon: "time" }, { t: text }], "time");
		}
		case "session": {
			const text = facts.sessionId?.slice(0, 13) || "new"; // full UUIDv7 timestamp; 8 chars collide for ~65s
			return view(input, [span(text)], [{ icon: "session" }, { t: text }], "session");
		}
		case "hostname": {
			const name = facts.hostname ?? "";
			const s = input.accent ? "sessionAccent" : undefined;
			return view(
				input,
				[span(name, input.accent ? "accent" : undefined)],
				[
					{ icon: "host", s },
					{ t: name, s },
				],
				"host",
			);
		}
		case "cache_read":
			return statSeg(input, usage.cacheRead, "cache", "statusLineSpend");
		case "cache_write":
			return statSeg(input, usage.cacheWrite, "cache", "statusLineOutput");
		case "cache_hit": {
			if (!usage.cacheRead) return null;
			const rate = `${((usage.cacheRead / (usage.cacheRead + usage.cacheWrite + usage.input)) * 100).toFixed(2)}%`;
			return view(
				input,
				[span(rate, "statusLineSpend")],
				[{ icon: "cache" }, { t: rate, s: "statusLineSpend" }],
				"cache",
			);
		}
		case "cache": {
			const cache = facts.promptCache;
			if (!cache) return null;
			const warm = cache.state === "warm";
			return view(
				input,
				[
					span(
						warm ? glyph(input, "icon.cacheWarm") : glyph(input, "icon.cacheCold"),
						warm ? undefined : "warning",
					),
				],
				[{ icon: warm ? "cacheWarm" : "cacheCold", s: warm ? "dim" : "warning", space: "none" }],
				undefined,
				warm ? undefined : "warning",
			);
		}
		case "session_name": {
			const name = facts.sessionName ? sanitizeStatusText(facts.sessionName) : "";
			if (!name) return null;
			const pieces: LookPiece[] = [];
			if (facts.pinned) pieces.push({ icon: "pin", s: "accent", bare: true });
			pieces.push({ t: name, s: lookAccent(input, "accent") });
			return view(input, [span(name)], pieces, facts.pinned ? "pin" : undefined);
		}
		case "usage":
			return usageSeg(input);
		case "collab": {
			const collab = facts.collab;
			if (!collab) return null;
			const label = `collab${collab.role === "host" ? "" : " guest"}:${collab.participantCount}`;
			return view(
				input,
				[span(label, nativeAccent(input, "accent"))],
				[{ t: `⇄ ${label}`, s: lookAccent(input, "accent") }],
				"collab",
			);
		}
		case "stream": {
			const live = facts.stream ? [`LIVE ${facts.stream.viewers}`] : [];
			if (facts.recording) live.push("REC");
			if (live.length === 0) return null;
			return view(
				input,
				[span(live.join(" "), "thinkingHigh")],
				[{ t: live.map(badge => `● ${badge}`).join(" "), s: "thinkingHigh" }],
				"live",
				"error",
			);
		}
		case "vim":
			return vimSeg(input);
		case "tree":
			return treeSeg(input);
		default:
			return null;
	}
}

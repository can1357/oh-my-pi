/**
 * The advisor-configuration overlay's data side: what the host supplies
 * (deps, callbacks, live stats), the one-line summaries every view shares,
 * and the model catalogue the model picker browses.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { Accessor } from "@oh-my-pi/pi-tui";
import type {
	AdvisorConfig,
	AdvisorConfigScope,
	AdvisorSyncBacklog,
	WatchdogConfigDoc,
} from "../../../advisor/advisor-config-types";

/** One live advisor's usage, as the session reports it. */
export interface AdvisorConfigStat {
	name: string;
	sessionId?: string;
	status: string;
	model?: { provider: string };
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	contextWindow: number;
	contextTokens: number;
}

/** Host effects: disk, live runtime, notices. */
export interface AdvisorConfigCallbacks {
	/** Load a scope's `WATCHDOG.yml` into an editable doc (empty when absent). */
	loadDoc(scope: AdvisorConfigScope): Promise<WatchdogConfigDoc>;
	/** Persist the doc to the scope's file and rebuild the live advisors. */
	save(scope: AdvisorConfigScope, doc: WatchdogConfigDoc): Promise<void>;
	/** Tear down the overlay and restore the editor. */
	close(): void;
	/** A transient status line. */
	notify(message: string): void;
	/** A sticky warning (problems in the file a scope switch made active); `notify` when absent. */
	warn?(message: string): void;
	/** Live advisor usage (reactive: the preview follows it). */
	stats?: Accessor<readonly AdvisorConfigStat[]>;
	/** Usage reports normalized by the host (shared credential pools collapsed). */
	getUsageReports?(): Promise<UsageReport[] | null>;
	/** The advisor's active-credential filter; absent includes every limit. */
	getQuotaLimitFilter?(
		provider: string,
		sessionId: string | undefined,
	): ((report: UsageReport, limit: UsageLimit) => boolean) | undefined;
}

/** What the overlay reads from the session. */
export interface AdvisorConfigDeps {
	getAvailableModels(): Model[];
	/** Recently used model selectors (`provider/id`), newest first: the picker's "Recent" group. */
	readonly mruOrder: readonly string[];
	readonly defaultToolNames: ReadonlySet<string>;
	/** Ctrl+G in the instructions editor. */
	externalEditor?(text: string): Promise<string | null>;
	/** When set, the model picker offers only these. */
	readonly scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	readonly availableToolNames: readonly string[];
	/** The global catch-up policy advisors inherit. */
	readonly syncBacklog?: AdvisorSyncBacklog;
	/** The advisor-role model a seeded or unset advisor uses (`provider/id`). */
	readonly defaultModelLabel?: string;
}

/** Characters of an instructions preview line. */
const PREVIEW_WIDTH = 60;

/** The first line of `text`, capped, or `(none)`. */
export function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted means the default read/grep/glob; an explicit empty list means no tools. */
export function commitTools(
	selected: readonly string[],
	all: readonly string[],
	defaults: ReadonlySet<string>,
): string[] | undefined {
	if (selected.length === 0) return [];
	if (selected.length === defaults.size && selected.every(name => defaults.has(name))) return undefined;
	return all.filter(name => selected.includes(name));
}

export function formatAdvisorTools(tools: readonly string[] | undefined): string {
	if (tools === undefined) return "read, grep, glob (default)";
	return tools.length > 0 ? tools.join(", ") : "no tools";
}

/** Mode plus interval, one line. */
export function formatReviewCadence(advisor: AdvisorConfig): string {
	const interval = advisor.reviewInterval ?? 1;
	return `${advisor.reviewMode ?? "turn"} · every ${interval} eligible update${interval === 1 ? "" : "s"}`;
}

/** What one explicit catch-up policy does. */
export function describeSyncBacklogMode(mode: AdvisorSyncBacklog): string {
	switch (mode) {
		case "off":
			return "Never wait for this advisor's backlog.";
		case "strict":
			return "Wait for all of this advisor's scheduled reviews; no wall-clock cap.";
		default:
			return `Wait until fewer than ${mode} scheduled reviews remain (30s cap).`;
	}
}

/** `1234567` → `1.2M`, `200000` → `200k`, `8192` → `8.2k`. */
export function formatCompactCount(value: number): string {
	const scaled = (n: number): string => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
	if (value >= 1_000_000) return `${scaled(value / 1_000_000)}M`;
	if (value >= 1_000) return `${scaled(value / 1_000)}k`;
	return String(value);
}

/** One model of the picker's catalogue. */
export interface ModelEntry {
	/** `provider/id`. */
	readonly selector: string;
	readonly provider: string;
	readonly id: string;
	readonly model: Model;
	/** In the "Recent" group. */
	readonly recent: boolean;
}

/** The catalogue in display order: recently used models (MRU order), then the rest by selector. */
export function modelCatalogue(models: readonly Model[], mruOrder: readonly string[]): ModelEntry[] {
	const entries = new Map<string, ModelEntry>();
	for (const model of models) {
		const selector = `${model.provider}/${model.id}`;
		if (entries.has(selector)) continue;
		entries.set(selector, {
			selector,
			provider: model.provider,
			id: model.id,
			model,
			recent: mruOrder.includes(selector),
		});
	}
	const recent: ModelEntry[] = [];
	for (const selector of mruOrder) {
		const entry = entries.get(selector);
		if (entry) recent.push(entry);
	}
	const rest = [...entries.values()]
		.filter(entry => !entry.recent)
		.sort((a, b) => a.selector.localeCompare(b.selector));
	return [...recent, ...rest];
}

/** `$in/out` per million tokens (cents precision). */
export function modelPrice(model: Model, separator: string): string {
	const { input, output } = model.cost;
	return `$${Math.round(input * 100) / 100}${separator}${Math.round(output * 100) / 100}`;
}

/** The highlighted model's facts line: id, context, output, price, reasoning. */
export function modelDetail(model: Model): string {
	const parts = [
		model.id,
		`${formatCompactCount(model.contextWindow ?? 0)} ctx`,
		`${formatCompactCount(model.maxTokens ?? 0)} out`,
		`${modelPrice(model, "/")} per M`,
	];
	if (model.reasoning) parts.push("reasoning");
	return parts.join(" · ");
}

import { useSyncExternalStore } from "react";

/**
 * Client-side dashboard customization state.
 *
 * Persisted under localStorage key `omp-stats-dashboard` with a versioned,
 * validated schema (v1). Corrupt/stale/partial data degrades gracefully to
 * the default layout — preference failures must never break `/stats`.
 * Only the Overview route is customizable in v1; other routes render their
 * fixed section stack.
 */

export type OverviewWidgetId =
	| "kpi-primary"
	| "kpi-secondary"
	| "agent-tokens"
	| "throughput"
	| "feed"
	| "recent-preview";

export type WidgetSize = "small" | "medium" | "wide";

export type DashboardPreset = "default" | "cost" | "tokens" | "developer" | "custom";

export interface DashboardWidgetPref {
	id: OverviewWidgetId;
	visible: boolean;
	size: WidgetSize;
}

export interface StatsDashboardPrefs {
	version: 1;
	preset: DashboardPreset;
	widgets: DashboardWidgetPref[];
}

const STORAGE_KEY = "omp-stats-dashboard";
const PREFS_VERSION = 1;

const VALID_WIDGET_IDS: readonly OverviewWidgetId[] = [
	"kpi-primary",
	"kpi-secondary",
	"agent-tokens",
	"throughput",
	"feed",
	"recent-preview",
];

const VALID_SIZES: readonly WidgetSize[] = ["small", "medium", "wide"];

const VALID_PRESETS: readonly DashboardPreset[] = ["default", "cost", "tokens", "developer", "custom"];

/** Display metadata for the customization drawer (titles/descriptions per widget). */
export const WIDGET_META: Record<OverviewWidgetId, { title: string; description: string }> = {
	"kpi-primary": {
		title: "Costs & Requests",
		description: "Total cost, requests, cache savings/rate, error rate",
	},
	"kpi-secondary": {
		title: "Token Details",
		description: "Token breakdown, premium requests, speed and latency",
	},
	"agent-tokens": {
		title: "Tokens by Agent",
		description: "Conversation-token share across main/subagents/advisor",
	},
	throughput: {
		title: "System Throughput",
		description: "Request volume and errors over time",
	},
	feed: {
		title: "Operational Feed",
		description: "Live request log with status, model and cost",
	},
	"recent-preview": {
		title: "Recent Requests",
		description: "Latest requests table with detail drawer",
	},
};

function widget(id: OverviewWidgetId, visible: boolean, size: WidgetSize): DashboardWidgetPref {
	return { id, visible, size };
}

/** Canonical default arrangement — also what Reset restores. */
export const DEFAULT_WIDGETS: DashboardWidgetPref[] = [
	widget("kpi-primary", true, "wide"),
	widget("kpi-secondary", true, "wide"),
	widget("agent-tokens", true, "medium"),
	widget("throughput", true, "medium"),
	widget("feed", true, "small"),
	widget("recent-preview", true, "wide"),
];

export const DEFAULT_PREFS: StatsDashboardPrefs = {
	version: PREFS_VERSION,
	preset: "default",
	widgets: DEFAULT_WIDGETS.map(w => ({ ...w })),
};

/**
 * Complete arrangements per preset. Choosing a preset writes this whole array;
 * any subsequent manual edit flips the preset back to `custom`.
 */
export const PRESET_WIDGETS: Record<Exclude<DashboardPreset, "custom">, DashboardWidgetPref[]> = {
	default: DEFAULT_WIDGETS.map(w => ({ ...w })),
	cost: [
		widget("kpi-primary", true, "wide"),
		widget("kpi-secondary", true, "wide"),
		widget("throughput", true, "medium"),
		widget("recent-preview", true, "wide"),
		widget("agent-tokens", false, "medium"),
		widget("feed", false, "small"),
	],
	tokens: [
		widget("kpi-primary", true, "wide"),
		widget("kpi-secondary", true, "wide"),
		widget("agent-tokens", true, "wide"),
		widget("throughput", true, "medium"),
		widget("recent-preview", true, "medium"),
		widget("feed", false, "small"),
	],
	developer: [
		widget("kpi-primary", true, "medium"),
		widget("throughput", true, "medium"),
		widget("feed", true, "wide"),
		widget("recent-preview", true, "wide"),
		widget("kpi-secondary", false, "wide"),
		widget("agent-tokens", false, "medium"),
	],
};

function clonePreset(preset: Exclude<DashboardPreset, "custom">): StatsDashboardPrefs {
	return {
		version: PREFS_VERSION,
		preset,
		widgets: PRESET_WIDGETS[preset].map(w => ({ ...w })),
	};
}

// ---------------------------------------------------------------------------
// Validation / migration of stored prefs
// ---------------------------------------------------------------------------
export function validatePrefs(parsed: unknown): StatsDashboardPrefs | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== PREFS_VERSION) return null;
	if (!VALID_PRESETS.includes(raw.preset as DashboardPreset)) return null;
	if (!Array.isArray(raw.widgets) || raw.widgets.length === 0) return null;

	const seen = new Set<string>();
	const out: DashboardWidgetPref[] = [];
	for (const entry of raw.widgets) {
		if (typeof entry !== "object" || entry === null) return null;
		const e = entry as Record<string, unknown>;
		if (!VALID_WIDGET_IDS.includes(e.id as OverviewWidgetId)) continue; // drop unknown ids
		if (typeof e.visible !== "boolean") return null;
		if (!VALID_SIZES.includes(e.size as WidgetSize)) return null;
		if (seen.has(e.id as string)) return null; // duplicates invalidate the whole blob
		seen.add(e.id as string);
		out.push({ id: e.id as OverviewWidgetId, visible: e.visible, size: e.size as WidgetSize });
	}

	// Splice in widgets the stored blob predates so upgrades surface them.
	for (const def of DEFAULT_WIDGETS) {
		if (!seen.has(def.id)) out.push({ ...def });
	}

	return { version: PREFS_VERSION, preset: raw.preset as DashboardPreset, widgets: out };
}

function readStored(): StatsDashboardPrefs {
	let parsed: unknown;
	try {
		const text = localStorage.getItem(STORAGE_KEY);
		if (text === null) return structuredClone(DEFAULT_PREFS);
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const result = validatePrefs(parsed);
	if (!result) {
		console.warn("[stats] invalid dashboard prefs, resetting to default");
		return structuredClone(DEFAULT_PREFS);
	}
	return result;
}

function persist(prefs: StatsDashboardPrefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Quota/private-mode failures keep the session-local state; never break the page.
	}
}

// ---------------------------------------------------------------------------
// Module-level store (same external-store pattern as useSystemTheme)
// ---------------------------------------------------------------------------

let current: StatsDashboardPrefs = readStored();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
	for (const listener of listeners) listener();
	if (persistTimer !== null) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		persist(current);
	}, 250);
}

function replace(next: StatsDashboardPrefs): void {
	current = next;
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyEdit(edit: (widgets: DashboardWidgetPref[]) => DashboardWidgetPref[]): void {
	// Manual edits flip the preset to custom; the widget list itself is preserved.
	replace({ version: PREFS_VERSION, preset: "custom", widgets: edit(current.widgets.map(w => ({ ...w }))) });
}

export const dashboardPrefsStore = {
	subscribe,

	setPreset(preset: DashboardPreset): void {
		if (preset === "custom") {
			// Selecting Custom keeps the current arrangement as-is.
			if (current.preset !== "custom") replace({ ...current, preset: "custom" });
			return;
		}
		replace(clonePreset(preset));
	},

	setWidgetVisible(id: OverviewWidgetId, visible: boolean): void {
		applyEdit(widgets => widgets.map(w => (w.id === id ? { ...w, visible } : w)));
	},

	setWidgetSize(id: OverviewWidgetId, size: WidgetSize): void {
		applyEdit(widgets => widgets.map(w => (w.id === id ? { ...w, size } : w)));
	},

	moveWidget(id: OverviewWidgetId, direction: "up" | "down"): void {
		applyEdit(widgets => {
			const index = widgets.findIndex(w => w.id === id);
			const target = direction === "up" ? index - 1 : index + 1;
			if (index === -1 || target < 0 || target >= widgets.length) return widgets;
			const next = [...widgets];
			const [entry] = next.splice(index, 1);
			next.splice(target, 0, entry);
			return next;
		});
	},

	reorderByIds(orderedIds: OverviewWidgetId[]): void {
		applyEdit(widgets => {
			const byId = new Map(widgets.map(w => [w.id, w]));
			const reordered: DashboardWidgetPref[] = [];
			for (const id of orderedIds) {
				const found = byId.get(id);
				if (found) {
					reordered.push(found);
					byId.delete(id);
				}
			}
			return [...reordered, ...byId.values()];
		});
	},

	reset(): void {
		replace(structuredClone(DEFAULT_PREFS));
	},

	/** Write any pending debounced state now (used by tests and page hide). */
	flush(): void {
		if (persistTimer !== null) {
			clearTimeout(persistTimer);
			persistTimer = null;
			persist(current);
		}
	},
};

/** Reader hook for the customized dashboard layout. */
export function useDashboardPrefs(): StatsDashboardPrefs {
	return useSyncExternalStore(
		dashboardPrefsStore.subscribe,
		() => current,
		() => DEFAULT_PREFS,
	);
}

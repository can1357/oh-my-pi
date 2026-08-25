export type OverviewSectionKey =
	| "tape"
	| "scope"
	| "models"
	| "providers"
	| "tokens"
	| "agents"
	| "tools"
	| "projects"
	| "errors";

export const SECTION_ORDER: OverviewSectionKey[] = [
	"tape",
	"scope",
	"tokens",
	"agents",
	"models",
	"providers",
	"tools",
	"projects",
	"errors",
];

export const SECTION_LABELS: Record<OverviewSectionKey, string> = {
	tape: "KPI tape",
	scope: "Usage over time",
	models: "Models",
	providers: "Providers",
	tokens: "Token breakdown",
	agents: "Agents",
	tools: "Tools",
	projects: "Projects",
	errors: "Recent errors",
};

export type PresetId = "default" | "tokens" | "models";

export const PRESET_DEFS: Record<PresetId, { label: string; visible: Record<OverviewSectionKey, boolean> }> = {
	default: {
		label: "Default",
		visible: {
			tape: true,
			scope: true,
			models: true,
			providers: true,
			tokens: true,
			agents: true,
			tools: true,
			projects: true,
			errors: true,
		},
	},
	tokens: {
		label: "Tokens",
		visible: {
			tape: true,
			scope: true,
			models: false,
			providers: false,
			tokens: true,
			agents: true,
			tools: true,
			projects: false,
			errors: false,
		},
	},
	models: {
		label: "Models",
		visible: {
			tape: true,
			scope: true,
			models: true,
			providers: true,
			tokens: false,
			agents: true,
			tools: false,
			projects: false,
			errors: true,
		},
	},
};

export const STORAGE_KEY = "omp-stats:overview-prefs";

export interface PrefsState {
	preset: PresetId | "custom";
	visible: Record<OverviewSectionKey, boolean>;
}

export function loadPrefs(storage: Pick<Storage, "getItem"> = globalThis.localStorage): PrefsState {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<PrefsState>;
			if (parsed.visible && typeof parsed.preset === "string") {
				const base = PRESET_DEFS.default.visible;
				const visible = { ...base } as Record<OverviewSectionKey, boolean>;
				for (const k of SECTION_ORDER) {
					if (typeof (parsed.visible as Record<string, unknown>)[k] === "boolean") {
						visible[k] = (parsed.visible as Record<string, boolean>)[k];
					}
				}
				const preset = (["default", "tokens", "models", "custom"] as const).includes(parsed.preset as PresetId)
					? (parsed.preset as PrefsState["preset"])
					: "custom";
				return { preset, visible };
			}
		}
	} catch {
		// ignore
	}
	return { preset: "default", visible: { ...PRESET_DEFS.default.visible } };
}

export function savePrefs(prefs: PrefsState, storage: Pick<Storage, "setItem"> = globalThis.localStorage): void {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// ignore quota
	}
}

export function nextPrefsOnToggle(prev: PrefsState, key: OverviewSectionKey): PrefsState {
	const nextVisible = { ...prev.visible, [key]: !prev.visible[key] };
	let matched: PrefsState["preset"] = "custom";
	for (const pid of Object.keys(PRESET_DEFS) as PresetId[]) {
		const def = PRESET_DEFS[pid].visible;
		if (SECTION_ORDER.every(k => def[k] === nextVisible[k])) matched = pid;
	}
	return { preset: matched, visible: nextVisible };
}

export function prefsForPreset(id: PresetId): PrefsState {
	return { preset: id, visible: { ...PRESET_DEFS[id].visible } };
}

export function activeDaysFromSeries(series: { timestamp: number; requests: number }[] | undefined): number {
	if (!series || series.length === 0) return 0;
	const days = new Set<string>();
	for (const pt of series) if (pt.requests > 0) days.add(new Date(pt.timestamp).toDateString());
	if (days.size === 0) {
		const hasAny = series.some(p => p.requests > 0);
		if (!hasAny) return 0;
		return new Set(series.map(p => new Date(p.timestamp).toDateString())).size;
	}
	return days.size;
}

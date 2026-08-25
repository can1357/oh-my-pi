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

// ---------------------------------------------------------------------------
// Named dashboards — evolution of per-section prefs
// ---------------------------------------------------------------------------

export interface Dashboard {
	id: string;
	name: string;
	visible: Record<OverviewSectionKey, boolean>;
	createdAt: number;
}

export interface DashboardState {
	activeId: string;
	dashboards: Dashboard[];
}

export const DASHBOARD_STORAGE_KEY = "omp-stats:dashboards";

export function defaultDashboards(): Dashboard[] {
	return [
		{ id: "default", name: "Default", visible: { ...PRESET_DEFS.default.visible }, createdAt: 1 },
		{ id: "tokens", name: "Tokens", visible: { ...PRESET_DEFS.tokens.visible }, createdAt: 2 },
		{ id: "models", name: "Models", visible: { ...PRESET_DEFS.models.visible }, createdAt: 3 },
		{
			id: "reliability",
			name: "Reliability",
			visible: {
				tape: true,
				scope: true,
				models: false,
				providers: false,
				tokens: false,
				agents: false,
				tools: false,
				projects: false,
				errors: true,
			},
			createdAt: 4,
		},
	];
}

function isValidVisible(v: unknown): v is Record<OverviewSectionKey, boolean> {
	if (!v || typeof v !== "object") return false;
	return SECTION_ORDER.every(k => typeof (v as Record<string, unknown>)[k] === "boolean");
}

export function loadDashboardState(storage: Pick<Storage, "getItem"> = globalThis.localStorage): DashboardState {
	try {
		const raw = storage.getItem(DASHBOARD_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<DashboardState>;
			if (Array.isArray(parsed.dashboards) && typeof parsed.activeId === "string" && parsed.dashboards.length > 0) {
				const cleaned: Dashboard[] = [];
				for (const d of parsed.dashboards as unknown[]) {
					if (!d || typeof d !== "object") continue;
					const rec = d as Record<string, unknown>;
					if (typeof rec.id !== "string" || typeof rec.name !== "string" || !isValidVisible(rec.visible)) continue;
					cleaned.push({
						id: rec.id,
						name: rec.name,
						visible: rec.visible as Record<OverviewSectionKey, boolean>,
						createdAt: typeof rec.createdAt === "number" ? rec.createdAt : Date.now(),
					});
				}
				if (cleaned.length > 0) {
					const active = cleaned.find(d => d.id === parsed.activeId) ? (parsed.activeId as string) : cleaned[0].id;
					return { activeId: active, dashboards: cleaned };
				}
			}
		}
		const legacyRaw = storage.getItem(STORAGE_KEY);
		if (legacyRaw) {
			try {
				const legacy = JSON.parse(legacyRaw) as Partial<PrefsState>;
				if (legacy.visible && isValidVisible(legacy.visible)) {
					const visible = legacy.visible as Record<OverviewSectionKey, boolean>;
					return {
						activeId: "custom",
						dashboards: [
							{ id: "custom", name: "My Dashboard", visible, createdAt: Date.now() },
							...defaultDashboards().slice(1),
						],
					};
				}
			} catch {}
		}
	} catch {}
	return { activeId: "default", dashboards: defaultDashboards() };
}

export function saveDashboardState(
	state: DashboardState,
	storage: Pick<Storage, "setItem"> = globalThis.localStorage,
): void {
	try {
		storage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(state));
	} catch {}
}

export function createDashboard(
	state: DashboardState,
	name: string,
	visible?: Record<OverviewSectionKey, boolean>,
): DashboardState {
	const id = Math.random().toString(36).slice(2, 9);
	const base = visible ??
		state.dashboards.find(d => d.id === state.activeId)?.visible ?? { ...PRESET_DEFS.default.visible };
	const dash: Dashboard = {
		id,
		name: name.trim() || `Dashboard ${state.dashboards.length + 1}`,
		visible: { ...base },
		createdAt: Date.now(),
	};
	return { activeId: id, dashboards: [...state.dashboards, dash] };
}

export function duplicateDashboard(state: DashboardState, id: string): DashboardState {
	const src = state.dashboards.find(d => d.id === id);
	if (!src) return state;
	const dup: Dashboard = {
		id: Math.random().toString(36).slice(2, 9),
		name: `${src.name} copy`,
		visible: { ...src.visible },
		createdAt: Date.now(),
	};
	return { activeId: dup.id, dashboards: [...state.dashboards, dup] };
}

export function deleteDashboard(state: DashboardState, id: string): DashboardState {
	if (state.dashboards.length <= 1) return state;
	const filtered = state.dashboards.filter(d => d.id !== id);
	const activeId = state.activeId === id ? filtered[0].id : state.activeId;
	return { activeId, dashboards: filtered };
}

export function renameDashboard(state: DashboardState, id: string, name: string): DashboardState {
	return {
		...state,
		dashboards: state.dashboards.map(d => (d.id === id ? { ...d, name: name.trim() || d.name } : d)),
	};
}

export function setActiveDashboard(state: DashboardState, id: string): DashboardState {
	if (!state.dashboards.some(d => d.id === id)) return state;
	return { ...state, activeId: id };
}

export function updateDashboardVisible(state: DashboardState, id: string, key: OverviewSectionKey): DashboardState {
	return {
		...state,
		dashboards: state.dashboards.map(d =>
			d.id === id ? { ...d, visible: { ...d.visible, [key]: !d.visible[key] } } : d,
		),
	};
}

export function resetDashboard(state: DashboardState, id: string, preset: PresetId = "default"): DashboardState {
	return {
		...state,
		dashboards: state.dashboards.map(d => (d.id === id ? { ...d, visible: { ...PRESET_DEFS[preset].visible } } : d)),
	};
}

export function resetAllDashboards(): DashboardState {
	return { activeId: "default", dashboards: defaultDashboards() };
}

import { describe, expect, it } from "bun:test";
import {
	activeDaysFromSeries,
	DASHBOARD_STORAGE_KEY,
	defaultDashboards,
	loadDashboardState,
	loadPrefs,
	nextPrefsOnToggle,
	PRESET_DEFS,
	prefsForPreset,
	SECTION_ORDER,
	STORAGE_KEY,
} from "../src/client/data/overview-prefs";

function fakeStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		_store: store,
	};
}

describe("activeDaysFromSeries", () => {
	it("counts distinct calendar days with requests", () => {
		const day = 24 * 60 * 60 * 1000;
		const now = Date.now();
		// Normalize to midnight boundaries for determinism
		const d0 = new Date(now);
		d0.setHours(0, 0, 0, 0);
		const t0 = d0.getTime();
		const series = [
			{ timestamp: t0 + 1000, requests: 3 },
			{ timestamp: t0 + day + 1000, requests: 2 },
			{ timestamp: t0 + day * 2 + 1000, requests: 0 },
		];
		expect(activeDaysFromSeries(series)).toBe(2);
	});

	it("returns 0 for empty or all-zero series", () => {
		expect(activeDaysFromSeries([])).toBe(0);
		expect(activeDaysFromSeries([{ timestamp: Date.now(), requests: 0 }])).toBe(0);
		expect(activeDaysFromSeries(undefined)).toBe(0);
	});
});

describe("overview prefs persistence", () => {
	it("defaults to Default preset when storage empty", () => {
		const storage = fakeStorage();
		const prefs = loadPrefs(storage as never);
		expect(prefs.preset).toBe("default");
		expect(prefs.visible).toEqual(PRESET_DEFS.default.visible);
	});

	it("restores persisted visibility and preserves preset", () => {
		const custom = { preset: "tokens" as const, visible: PRESET_DEFS.tokens.visible };
		const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(custom) });
		const prefs = loadPrefs(storage as never);
		expect(prefs).toEqual(custom);
	});

	it("toggles a section and flips to custom when diverging from preset", () => {
		const start = prefsForPreset("default");
		const next = nextPrefsOnToggle(start, "tokens");
		expect(next.visible.tokens).toBe(false);
		expect(next.preset).toBe("custom");
	});

	it("returns to a named preset when toggling back to its exact shape", () => {
		// Default -> toggle tokens off -> custom -> toggle tokens on -> back to default
		let prefs = prefsForPreset("default");
		prefs = nextPrefsOnToggle(prefs, "tokens");
		expect(prefs.preset).toBe("custom");
		prefs = nextPrefsOnToggle(prefs, "tokens");
		expect(prefs.preset).toBe("default");
		expect(prefs.visible).toEqual(PRESET_DEFS.default.visible);
	});

	it("prefsForPreset produces an independent copy", () => {
		const a = prefsForPreset("default");
		const b = prefsForPreset("default");
		a.visible.tape = false;
		expect(b.visible.tape).toBe(true);
	});

	it("recovers gracefully from corrupt JSON", () => {
		const storage = fakeStorage({ [STORAGE_KEY]: "{not-json" });
		const prefs = loadPrefs(storage as never);
		expect(prefs.preset).toBe("default");
	});

	it("ignores unknown keys in persisted visible", () => {
		const storage = fakeStorage({
			[STORAGE_KEY]: JSON.stringify({ preset: "default", visible: { tape: false, bogus: true } }),
		});
		const prefs = loadPrefs(storage as never);
		expect(prefs.visible.tape).toBe(false);
		// bogus key should not leak into the returned visible
		expect((prefs.visible as Record<string, unknown>).bogus).toBeUndefined();
		// other keys fall back to default
		for (const k of SECTION_ORDER) if (k !== "tape") expect(prefs.visible[k]).toBe(true);
	});

	it("defaults live feed and recent requests to visible in every section", () => {
		for (const key of ["liveFeed", "recentRequests"]) {
			expect(SECTION_ORDER).toContain(key);
			expect(PRESET_DEFS.default.visible[key as keyof typeof PRESET_DEFS.default.visible]).toBe(true);
		}
		// Focus presets intentionally hide the unconditional request panels.
		expect(PRESET_DEFS.tokens.visible.liveFeed).toBe(false);
		expect(PRESET_DEFS.tokens.visible.recentRequests).toBe(false);
	});

	it("migrates legacy prefs missing the new sections to visible", () => {
		// A record saved before liveFeed/recentRequests existed: only old keys.
		const legacyVisible: Record<string, boolean> = {};
		for (const k of SECTION_ORDER) {
			if (k === "liveFeed" || k === "recentRequests") continue;
			legacyVisible[k] = k !== "tape";
		}
		const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ preset: "custom", visible: legacyVisible }) });
		const prefs = loadPrefs(storage as never);
		expect(prefs.visible.tape).toBe(false);
		expect(prefs.visible.liveFeed).toBe(true);
		expect(prefs.visible.recentRequests).toBe(true);
	});

	it("migrates legacy dashboard records missing the new sections to visible", () => {
		const legacyDash = {
			id: "custom",
			name: "My Dashboard",
			visible: {
				tape: false,
				scope: true,
				models: true,
				providers: true,
				tokens: true,
				agents: true,
				tools: true,
				projects: true,
				errors: true,
			},
			createdAt: 42,
		};
		const storage = fakeStorage({
			[DASHBOARD_STORAGE_KEY]: JSON.stringify({ activeId: "custom", dashboards: [legacyDash] }),
		});
		const state = loadDashboardState(storage as never);
		expect(state.dashboards[0].visible.tape).toBe(false);
		expect(state.dashboards[0].visible.liveFeed).toBe(true);
		expect(state.dashboards[0].visible.recentRequests).toBe(true);
	});

	it("default dashboards carry the new sections", () => {
		for (const dash of defaultDashboards()) {
			expect(dash.visible.liveFeed).toBeTypeOf("boolean");
			expect(dash.visible.recentRequests).toBeTypeOf("boolean");
		}
	});
});

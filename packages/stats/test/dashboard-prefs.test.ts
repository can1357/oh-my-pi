import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

// bun:test has no DOM; install a minimal localStorage before the module under
// test reads it at import time.
const backing = new Map<string, string>();
const storageStub = {
	getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
	setItem: (key: string, value: string) => void backing.set(key, String(value)),
	removeItem: (key: string) => void backing.delete(key),
	clear: () => void backing.clear(),
};
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: storageStub,
});

import type { StatsDashboardPrefs } from "../src/client/data/dashboard-prefs";
import { DEFAULT_PREFS, dashboardPrefsStore, validatePrefs, WIDGET_META } from "../src/client/data/dashboard-prefs";

const STORAGE_KEY = "omp-stats-dashboard";

afterEach(() => {
	dashboardPrefsStore.flush();
	vi.restoreAllMocks();
});

beforeEach(() => {
	localStorage.clear();
	dashboardPrefsStore.reset();
});

function stored(): StatsDashboardPrefs | null {
	dashboardPrefsStore.flush();
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw === null ? null : (JSON.parse(raw) as StatsDashboardPrefs);
}

describe("dashboard prefs store", () => {
	it("persists a visibility toggle and flips the preset to custom", () => {
		dashboardPrefsStore.setWidgetVisible("feed", false);

		const saved = stored();
		expect(saved?.preset).toBe("custom");
		expect(saved?.widgets.find(w => w.id === "feed")?.visible).toBe(false);
		// Other widgets keep their default visibility.
		expect(saved?.widgets.find(w => w.id === "throughput")?.visible).toBe(true);
		// Order is unchanged.
		expect(saved?.widgets.map(w => w.id)).toEqual(DEFAULT_PREFS.widgets.map(w => w.id));
	});

	it("reorders via moveWidget and persists explicit array order", () => {
		dashboardPrefsStore.moveWidget("kpi-secondary", "up");

		const saved = stored();
		expect(saved?.widgets[0].id).toBe("kpi-secondary");
		expect(saved?.widgets[1].id).toBe("kpi-primary");
		expect(stored()?.preset).toBe("custom");
	});

	it("moveWidget at a list boundary keeps order but still records a manual edit", () => {
		dashboardPrefsStore.moveWidget("kpi-primary", "up");
		expect(stored()?.widgets.map(w => w.id)).toEqual(DEFAULT_PREFS.widgets.map(w => w.id));
		expect(stored()?.preset).toBe("custom");
	});

	it("changes widget size without touching visibility or order", () => {
		dashboardPrefsStore.setWidgetSize("agent-tokens", "wide");

		const entry = stored()?.widgets.find(w => w.id === "agent-tokens");
		expect(entry?.size).toBe("wide");
		expect(entry?.visible).toBe(true);
	});

	it("reorderByIds applies a drag-drop permutation and appends unknown ids at the end", () => {
		const defaults = DEFAULT_PREFS.widgets.map(w => w.id);
		dashboardPrefsStore.reorderByIds([defaults[2], defaults[0]]);

		const saved = stored();
		expect(saved?.widgets.slice(0, 2).map(w => w.id)).toEqual([defaults[2], defaults[0]]);
		expect(saved?.widgets.length).toBe(defaults.length);
	});

	it("applies a preset by writing its full widget arrangement", () => {
		dashboardPrefsStore.setPreset("developer");

		const saved = stored();
		expect(saved?.preset).toBe("developer");
		expect(saved?.widgets.find(w => w.id === "feed")?.visible).toBe(true);
		expect(saved?.widgets.find(w => w.id === "feed")?.size).toBe("wide");
		expect(saved?.widgets.find(w => w.id === "kpi-secondary")?.visible).toBe(false);
		expect(saved?.widgets.find(w => w.id === "agent-tokens")?.visible).toBe(false);
	});

	it("selecting Custom keeps the current arrangement untouched", () => {
		dashboardPrefsStore.setPreset("cost");
		const costOrder = stored()?.widgets.map(w => w.id);

		dashboardPrefsStore.setPreset("custom");

		expect(stored()?.preset).toBe("custom");
		expect(stored()?.widgets.map(w => w.id)).toEqual(costOrder);
		expect(stored()?.preset).not.toBe("cost");
	});

	it("reset restores the exact default layout after arbitrary edits", () => {
		dashboardPrefsStore.setPreset("developer");
		dashboardPrefsStore.setWidgetSize("feed", "small");

		dashboardPrefsStore.reset();

		expect(stored()).toEqual({ version: 1, preset: "default", widgets: DEFAULT_PREFS.widgets });
	});
});

describe("stored prefs validation", () => {
	it("accepts a valid blob and preserves its widget order", () => {
		const blob = {
			version: 1,
			preset: "custom",
			widgets: [
				{ id: "throughput", visible: false, size: "wide" },
				{ id: "feed", visible: true, size: "small" },
			],
		};

		const result = validatePrefs(blob);

		expect(result?.preset).toBe("custom");
		// User order is preserved; remaining default widgets are appended so
		// an older layout still surfaces newly-added widgets.
		expect(result?.widgets.slice(0, 2).map(w => w.id)).toEqual(["throughput", "feed"]);
		expect(result?.widgets.length).toBe(DEFAULT_PREFS.widgets.length);
	});

	it("rejects non-objects, wrong versions, and unknown presets", () => {
		expect(validatePrefs("nope")).toBeNull();
		expect(validatePrefs(null)).toBeNull();
		expect(validatePrefs([1, 2])).toBeNull();
		expect(
			validatePrefs({ version: 99, preset: "default", widgets: [{ id: "feed", visible: true, size: "small" }] }),
		).toBeNull();
		expect(
			validatePrefs({ version: 1, preset: "galaxy-brain", widgets: [{ id: "feed", visible: true, size: "small" }] }),
		).toBeNull();
		expect(validatePrefs({ version: 1, preset: "default", widgets: [] })).toBeNull();
	});

	it("drops unknown widget ids but rejects duplicates and malformed entries", () => {
		const droppedUnknown = validatePrefs({
			version: 1,
			preset: "default",
			widgets: [
				{ id: "holo-deck", visible: true, size: "small" },
				{ id: "feed", visible: true, size: "small" },
			],
		});
		expect(droppedUnknown?.widgets[0].id).toBe("feed");
		expect(droppedUnknown?.widgets.length).toBe(DEFAULT_PREFS.widgets.length);

		const duplicate = validatePrefs({
			version: 1,
			preset: "default",
			widgets: [
				{ id: "feed", visible: true, size: "small" },
				{ id: "feed", visible: false, size: "small" },
			],
		});
		expect(duplicate).toBeNull();

		const badVisible = validatePrefs({
			version: 1,
			preset: "default",
			widgets: [{ id: "feed", visible: "yes", size: "small" }],
		});
		expect(badVisible).toBeNull();

		const badSize = validatePrefs({
			version: 1,
			preset: "default",
			widgets: [{ id: "feed", visible: true, size: "gigantic" }],
		});
		expect(badSize).toBeNull();
	});

	it("splices widgets missing from an older layout so upgrades surface them", () => {
		const result = validatePrefs({
			version: 1,
			preset: "default",
			widgets: [{ id: "throughput", visible: true, size: "medium" }],
		});

		expect(result?.widgets[0].id).toBe("throughput"); // user order preserved
		expect(result?.widgets.length).toBe(DEFAULT_PREFS.widgets.length); // rest appended
	});

	it("exposes display metadata for every widget id", () => {
		for (const def of DEFAULT_PREFS.widgets) {
			expect(WIDGET_META[def.id].title.length).toBeGreaterThan(0);
			expect(WIDGET_META[def.id].description.length).toBeGreaterThan(0);
		}
	});
});

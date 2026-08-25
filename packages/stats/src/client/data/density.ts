export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "omp-stats:density";

export function loadDensity(storage: Pick<Storage, "getItem"> = globalThis.localStorage): Density {
	try {
		const raw = storage.getItem(DENSITY_STORAGE_KEY);
		if (raw === "compact" || raw === "comfortable") return raw;
	} catch {}
	return "comfortable";
}

export function saveDensity(value: Density, storage: Pick<Storage, "setItem"> = globalThis.localStorage): void {
	try {
		storage.setItem(DENSITY_STORAGE_KEY, value);
	} catch {}
}

export function applyDensity(value: Density): void {
	if (typeof document !== "undefined") {
		document.documentElement.dataset.density = value;
	}
}

import { useSyncExternalStore } from "react";

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

// Module-level store shared by the palette toggle, the TopBar toggle and
// AppLayout so DOM + storage writes always agree with the rendered label
// (the palette used to mutate DOM+storage directly, leaving AppLayout stale).
let density: Density = loadDensity();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

applyDensity(density);

export function setDensity(value: Density): void {
	density = value;
	saveDensity(value);
	applyDensity(value);
	emit();
}

/** Flip between comfortable and compact through the shared store. */
export function toggleDensity(): void {
	setDensity(density === "compact" ? "comfortable" : "compact");
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Reader for the active density; re-renders on palette/TopBar toggles. */
export function useDensity(): Density {
	return useSyncExternalStore(
		subscribe,
		() => density,
		() => "comfortable" as Density,
	);
}

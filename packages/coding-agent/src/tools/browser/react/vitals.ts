import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Page } from "puppeteer-core";

/** Options controlling Web Vitals collection. */
export interface VitalsOptions {
	reload?: boolean;
}

/** Best-effort framework hydration timing captured alongside Web Vitals. */
export interface HydrationTiming {
	framework: string;
	hydratedAt?: number;
}

/** Web Vitals and navigation timing captured from the current document. */
export interface VitalsResult {
	url: string;
	lcp: number;
	cls: number;
	fcp: number;
	ttfb: number;
	inp: number;
	domContentLoaded: number;
	load: number;
	hydration?: HydrationTiming;
	longTasks: number;
}

const VITALS_INIT_SOURCE = `(() => {
	const root = globalThis;
	if (root.__ompBrowserVitals) return root.__ompBrowserVitals;
	const round = value => Math.round(value * 100) / 100;
	const state = {
		fromDocumentStart: document.readyState === "loading" && performance.now() < 50,
		lcp: 0,
		cls: 0,
		fcp: 0,
		inp: 0,
		longTasks: 0,
		hydration: undefined,
	};
	root.__ompBrowserVitals = state;
	const observe = (type, callback, options) => {
		try {
			const observer = new PerformanceObserver(list => callback(list.getEntries()));
			observer.observe(options || { type, buffered: true });
		} catch {}
	};
	observe("largest-contentful-paint", entries => {
		const entry = entries[entries.length - 1];
		if (entry) state.lcp = round(entry.renderTime || entry.loadTime || entry.startTime || 0);
	});
	observe("layout-shift", entries => {
		for (const entry of entries) {
			if (!entry.hadRecentInput) state.cls = round(state.cls + (entry.value || 0));
		}
	});
	observe("paint", entries => {
		for (const entry of entries) {
			if (entry.name === "first-contentful-paint") state.fcp = round(entry.startTime || 0);
		}
	});
	const recordInput = entries => {
		for (const entry of entries) state.inp = Math.max(state.inp, round(entry.duration || 0));
	};
	observe("first-input", recordInput);
	observe("event", recordInput, { type: "event", buffered: true, durationThreshold: 16 });
	observe("navigation", () => {});
	observe("longtask", entries => {
		for (const entry of entries) state.longTasks = round(state.longTasks + (entry.duration || 0));
	});
	return state;
})()`;

const VITALS_READ_SOURCE = `(() => {
	const state = globalThis.__ompBrowserVitals;
	if (!state) return { installed: false, fromDocumentStart: false };
	const round = value => Math.round((Number(value) || 0) * 100) / 100;
	const nav = performance.getEntriesByType("navigation")[0];
	const paint = performance.getEntriesByName("first-contentful-paint")[0];
	if (paint && !state.fcp) state.fcp = round(paint.startTime);
	if (!state.hydration) {
		if (document.querySelector("[data-reactroot], #__next")) state.hydration = { framework: "React" };
		else if (globalThis.__VUE__ || document.querySelector("[data-v-app]")) state.hydration = { framework: "Vue" };
		else if (globalThis.__SVELTE_HMR || document.querySelector("[data-svelte-h], [data-sveltekit-preload-data]")) {
			state.hydration = { framework: "Svelte" };
		}
	}
	return {
		installed: true,
		fromDocumentStart: state.fromDocumentStart === true,
		value: {
			url: location.href,
			lcp: round(state.lcp),
			cls: round(state.cls),
			fcp: round(state.fcp),
			ttfb: round(nav ? nav.responseStart - nav.requestStart : 0),
			inp: round(state.inp),
			domContentLoaded: round(nav ? nav.domContentLoadedEventEnd : 0),
			load: round(nav ? nav.loadEventEnd : 0),
			hydration: state.hydration,
			longTasks: round(state.longTasks),
		},
	};
})()`;

interface VitalsReadEnvelope {
	installed: boolean;
	fromDocumentStart: boolean;
	value?: VitalsResult;
}

/** Install the buffered Web Vitals observers for this page and future documents. */
export async function installVitalsObservers(page: Page, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.evaluateOnNewDocument(VITALS_INIT_SOURCE));
	await untilAborted(signal, () => page.mainFrame().mainRealm().evaluate(VITALS_INIT_SOURCE)).catch(() => undefined);
}

/** Read Web Vitals, reloading once by default when observers missed document start. */
export async function collectVitals(
	page: Page,
	options: VitalsOptions = {},
	signal?: AbortSignal,
): Promise<VitalsResult> {
	let envelope = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(VITALS_READ_SOURCE),
	)) as VitalsReadEnvelope;
	if (!envelope.installed) {
		await untilAborted(signal, () => page.mainFrame().mainRealm().evaluate(VITALS_INIT_SOURCE));
		envelope = (await untilAborted(signal, () =>
			page.mainFrame().mainRealm().evaluate(VITALS_READ_SOURCE),
		)) as VitalsReadEnvelope;
	}
	if (options.reload === true || (options.reload === undefined && !envelope.fromDocumentStart)) {
		await untilAborted(signal, () => page.reload({ waitUntil: "load" }));
	}
	const result = (await untilAborted(signal, () =>
		page.mainFrame().mainRealm().evaluate(VITALS_READ_SOURCE),
	)) as VitalsReadEnvelope;
	if (!result.value) throw new ToolError("Web Vitals observers are unavailable in this document");
	return result.value;
}

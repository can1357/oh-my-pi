import type { Frame, Page } from "puppeteer-core";

/** Explicit cursor visualization choices. */
export const CURSOR_MODE_VALUES = ["off", "instant", "animated"] as const;
export type CursorMode = (typeof CURSOR_MODE_VALUES)[number];
export type CursorPolicy = "auto" | CursorMode;

/** Stable, user-tested visual tokens shared by the preload and its tests. */
export const CURSOR_TOKENS = {
	diameter: "24px",
	border: "3px",
	halo: "4px",
	travelColor: "#00e5ff",
	pulseColor: "#ff2bd6",
	travelDuration: "600ms",
	travelEasing: "ease-in-out",
	pulseDuration: "100ms",
} as const;

export const CURSOR_PRELOAD_VERSION = "omp-native-cursor-v1";
const MAIN_WORLD_DIRECTIVE = "//!world=main\n";

function mainWorldExpression(expression: string): string {
	return `${MAIN_WORLD_DIRECTIVE}${expression}`;
}

/** The page-facing state is deliberately untrusted, decorative, and inert. */
const CURSOR_PRELOAD = `${MAIN_WORLD_DIRECTIVE}(() => {
	const key = "__ompNativeCursor";
	const version = ${JSON.stringify(CURSOR_PRELOAD_VERSION)};
	const previous = globalThis[key];
	previous?.cleanup?.();
	const root = document.createElement("div");
	root.setAttribute("aria-hidden", "true");
	root.setAttribute("data-omp-native-cursor", version);
	root.style.cssText = [
		"position:fixed",
		"left:0",
		"top:0",
		"z-index:2147483647",
		"pointer-events:none",
		"user-select:none",
		"contain:layout style paint",
		"width:var(--omp-cursor-diameter)",
		"height:var(--omp-cursor-diameter)",
		"box-sizing:border-box",
		"background:transparent",
		"transform:translate(50vw,50vh) translate(-50%, -50%)",
		"opacity:0",
	].join(";");
	root.style.setProperty("--omp-cursor-diameter", ${JSON.stringify(CURSOR_TOKENS.diameter)});
	root.style.setProperty("--omp-cursor-border", ${JSON.stringify(CURSOR_TOKENS.border)});
	root.style.setProperty("--omp-cursor-halo", ${JSON.stringify(CURSOR_TOKENS.halo)});
	root.style.setProperty("--omp-cursor-travel-color", ${JSON.stringify(CURSOR_TOKENS.travelColor)});
	root.style.setProperty("--omp-cursor-pulse-color", ${JSON.stringify(CURSOR_TOKENS.pulseColor)});
	root.style.setProperty("--omp-cursor-travel-duration", ${JSON.stringify(CURSOR_TOKENS.travelDuration)});
	root.style.setProperty("--omp-cursor-travel-easing", ${JSON.stringify(CURSOR_TOKENS.travelEasing)});
	root.style.setProperty("--omp-cursor-pulse-duration", ${JSON.stringify(CURSOR_TOKENS.pulseDuration)});
	const shadow = root.attachShadow({ mode: "closed" });
	const visual = document.createElement("span");
	visual.style.cssText = [
		"display:block",
		"width:100%",
		"height:100%",
		"box-sizing:border-box",
		"border:var(--omp-cursor-border) solid white",
		"border-radius:50%",
		"background:transparent",
	].join(";");
	shadow.appendChild(visual);
	const state = {
		version,
		root,
		visual,
		lastX: globalThis.innerWidth / 2,
		lastY: globalThis.innerHeight / 2,
		hide() {
			root.getAnimations().concat(visual.getAnimations()).forEach(animation => animation.cancel());
			root.style.opacity = "0";
			root.style.transform = "translate(50vw,50vh) translate(-50%, -50%)";
			state.lastX = globalThis.innerWidth / 2;
			state.lastY = globalThis.innerHeight / 2;
		},
		cleanup() {
			window.removeEventListener("pagehide", onPageHide);
			root.remove();
			if (globalThis[key] === state) {
				try { delete globalThis[key]; } catch { /* page teardown */ }
			}
		},
	};
	const onPageHide = () => state.hide();
	Object.defineProperty(globalThis, key, { value: state, configurable: true });
	window.addEventListener("pagehide", onPageHide);
})();`;

const CURSOR_BOOTSTRAP = `(mode) => {
	const key = "__ompNativeCursor";
	const version = ${JSON.stringify(CURSOR_PRELOAD_VERSION)};
	const state = globalThis[key];
	if (!state || state.version !== version || mode === "off") return false;
	if (!state.root.isConnected) document.documentElement.appendChild(state.root);
	return true;
}`;

const CURSOR_SHOW = `async (x, y, mode) => {
	const key = "__ompNativeCursor";
	const version = ${JSON.stringify(CURSOR_PRELOAD_VERSION)};
	const state = globalThis[key];
	if (!state || state.version !== version || mode === "off") return false;
	const root = state.root;
	if (!root.isConnected) document.documentElement.appendChild(root);
	const hidden = document.visibilityState === "hidden";
	const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
	const instant = mode === "instant" || hidden || reduced || typeof root.animate !== "function" || typeof state.visual.animate !== "function";
	const previousX = state.lastX;
	const previousY = state.lastY;
	state.lastX = x;
	state.lastY = y;
	root.style.opacity = "1";
	const target = "translate(" + x + "px, " + y + "px) translate(-50%, -50%)";
	root.getAnimations().concat(state.visual.getAnimations()).forEach(animation => animation.cancel());
	const animations = [];
	if (instant || previousX === undefined || previousY === undefined) {
		root.style.transform = target;
	} else {
		animations.push(root.animate([
			{ transform: "translate(" + previousX + "px, " + previousY + "px) translate(-50%, -50%)" },
			{ transform: target },
		], {
			duration: ${JSON.stringify(Number.parseInt(CURSOR_TOKENS.travelDuration, 10))},
			easing: ${JSON.stringify(CURSOR_TOKENS.travelEasing)},
			fill: "forwards",
		}));
	}
	animations.push(state.visual.animate([
		{ boxShadow: "0 0 0 0 " + ${JSON.stringify(CURSOR_TOKENS.pulseColor)} },
		{ boxShadow: "0 0 0 " + ${JSON.stringify(CURSOR_TOKENS.halo)} + " " + ${JSON.stringify(CURSOR_TOKENS.pulseColor)} },
		{ boxShadow: "0 0 0 0 " + ${JSON.stringify(CURSOR_TOKENS.travelColor)} },
	], {
		duration: ${JSON.stringify(Number.parseInt(CURSOR_TOKENS.pulseDuration, 10))},
		fill: "forwards",
	}));
	await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
	return true;
}`;
const CURSOR_CLEANUP = `() => {
	const key = "__ompNativeCursor";
	const state = globalThis[key];
	if (!state) return false;
	state.cleanup();
	return true;
}`;

const CURSOR_HIDE = `() => {
	const key = "__ompNativeCursor";
	const state = globalThis[key];
	if (!state) return false;
	state.hide();
	return true;
}`;

export function cursorCleanupSourceForTest(): string {
	return CURSOR_CLEANUP;
}

type CursorPage = Pick<Page, "evaluateOnNewDocument" | "removeScriptToEvaluateOnNewDocument" | "evaluate" | "frames">;

export async function cleanupCursorPage(
	page: Pick<Page, "evaluate" | "removeScriptToEvaluateOnNewDocument" | "frames">,
	registrationIdentifier?: string,
): Promise<void> {
	if (registrationIdentifier) {
		try {
			await page.removeScriptToEvaluateOnNewDocument(registrationIdentifier);
		} catch {
			// A closed target has already discarded the registration.
		}
	}
	let frames: Frame[];
	try {
		frames = page.frames();
	} catch {
		try {
			await page.evaluate(mainWorldExpression(`(${CURSOR_CLEANUP})()`));
		} catch {
			// The main frame can disappear with the page during teardown.
		}
		return;
	}
	await Promise.all(
		frames.map(async frame => {
			try {
				await frame.evaluate(mainWorldExpression(`(${CURSOR_CLEANUP})()`));
			} catch {
				// Frames can detach independently during teardown.
			}
		}),
	);
}

/** One preload registration per Puppeteer Page; page navigation re-runs the preload. */
export class CursorPreloadManager {
	#pages = new WeakMap<CursorPage, { identifier: string; bootstrapped: boolean }>();

	async register(page: CursorPage, mode: CursorMode): Promise<string | undefined> {
		if (mode === "off") return undefined;
		const existing = this.#pages.get(page);
		if (existing) return existing.identifier;
		try {
			const registered = await page.evaluateOnNewDocument(CURSOR_PRELOAD);
			const state = { identifier: registered.identifier, bootstrapped: false };
			this.#pages.set(page, state);
			return state.identifier;
		} catch {
			return undefined;
		}
	}

	async bootstrap(page: CursorPage, mode: CursorMode): Promise<boolean> {
		if (mode === "off") return false;
		const state = this.#pages.get(page);
		if (!state) return false;
		if (state.bootstrapped) return true;
		try {
			await page.evaluate(CURSOR_PRELOAD);
			const ready = Boolean(
				await page.evaluate(mainWorldExpression(`(${CURSOR_BOOTSTRAP})(${JSON.stringify(mode)})`)),
			);
			state.bootstrapped = ready;
			return ready;
		} catch {
			return false;
		}
	}

	async install(page: CursorPage, mode: CursorMode): Promise<boolean> {
		if (!(await this.register(page, mode))) return false;
		return await this.bootstrap(page, mode);
	}

	async show(page: CursorPage, x: number, y: number, mode: CursorMode): Promise<boolean> {
		if (mode === "off" || !this.#pages.has(page)) return false;
		try {
			return Boolean(
				await page.evaluate(
					mainWorldExpression(
						`(${CURSOR_SHOW})(${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(mode)})`,
					),
				),
			);
		} catch {
			return false;
		}
	}

	async hide(page: CursorPage): Promise<void> {
		if (!this.#pages.has(page)) return;
		try {
			await page.evaluate(mainWorldExpression(`(${CURSOR_HIDE})()`));
		} catch {
			// Navigation/close already destroyed the realm; action semantics are unaffected.
		}
	}

	async cleanup(page: CursorPage): Promise<void> {
		const state = this.#pages.get(page);
		if (!state) return;
		await cleanupCursorPage(page, state.identifier);
		this.#pages.delete(page);
	}
}

/** Resolve auto policy without coupling the page manager to browser-kind details. */
export function resolveCursorMode(policy: CursorPolicy | undefined, relayHeaded: boolean): CursorMode {
	if (policy === "off" || policy === "instant" || policy === "animated") return policy;
	return relayHeaded ? "animated" : "off";
}

export function cursorShowSourceForTest(): string {
	return CURSOR_SHOW;
}

export function cursorHideSourceForTest(): string {
	return CURSOR_HIDE;
}

export function cursorPreloadSourceForTest(): string {
	return CURSOR_PRELOAD;
}

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { SetupHost, SetupScene, SetupSceneController, SetupUiHost } from "../src/setup/scenes/types";
import { SETUP_SPLASH_MS } from "../src/setup/scenes/splash";
import { runStartupSplash } from "../src/setup/startup-splash";
import { SetupWizardComponent } from "../src/setup/wizard-overlay";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

let clock = 0;

/** Move the fake timer queue and the `performance.now()` clock together. */
function advance(ms: number): void {
	clock += ms;
	vi.advanceTimersByTime(ms);
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	clock = 0;
	spyOn(performance, "now").mockImplementation(() => clock);
	vi.useFakeTimers();
	setNativeRendering(true);
});

afterEach(() => {
	setNativeRendering(false);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) out.push(child, ...nodes(child.c));
	}
	return out;
}

function fakeUi(): { host: SetupUiHost; renders: () => number; shown: () => Component | undefined } {
	let renders = 0;
	let shown: Component | undefined;
	const host: SetupUiHost = {
		ui: {
			terminal: { rows: 40 },
			showOverlay: component => {
				shown = component;
				return { hide() {}, setHidden() {}, isHidden: () => false } as never;
			},
			setFocus() {},
			requestRender: () => {
				renders++;
			},
			invalidate() {},
		},
	};
	return { host, renders: () => renders, shown: () => shown };
}

describe("setup surfaces under native rendering", () => {
	it("startup splash finishes on its deadline without repaint ticks", async () => {
		const ui = fakeUi();
		let finished = false;
		const run = runStartupSplash(ui.host, { durationMs: 120, tickMs: 5, now: () => clock }).then(() => {
			finished = true;
		});
		advance(100);
		await Promise.resolve();
		expect(finished).toBe(false);
		advance(20);
		await run;
		// Only the initial render request; the ANSI 5ms repaint loop would have issued ~24.
		expect(ui.renders()).toBe(1);
	});

	it("startup splash skip action ends it early", async () => {
		const ui = fakeUi();
		const run = runStartupSplash(ui.host, { durationMs: 10_000, now: () => clock });
		const splash = ui.shown();
		const root = splash?.describe?.(cx);
		expect(nodes(root ? [root] : []).some(n => n.p?.actions?.click === "skip")).toBe(true);
		splash?.handleNativeEvent?.({ type: "action", key: "0", act: "skip", mods: [] });
		await run;
	});

	it("wizard advances splash → scene on the deadline and describes the mounted scene", async () => {
		const ui = fakeUi();
		let mounted: SetupSceneController | undefined;
		const scene: SetupScene = {
			id: "probe",
			title: "Probe scene",
			minVersion: 1,
			mount: () => {
				mounted = { title: "Probe scene", render: () => [] };
				return mounted;
			},
		};
		const wizard = new SetupWizardComponent(ui.host as SetupHost, [scene]);
		const done = wizard.run();
		try {
			advance(SETUP_SPLASH_MS - 1);
			expect(mounted).toBeUndefined();
			advance(1);
			expect(mounted).toBeDefined();
			expect(nodes([wizard.describe()]).some(n => n.c?.some(child => child === mounted))).toBe(true);
			// run() + the scene mount; no 33ms repaint loop across the splash.
			expect(ui.renders()).toBe(2);

			wizard.handleInput("\x03");
			expect(nodes([wizard.describe()]).some(n => n.p?.actions?.click === "continue")).toBe(true);
			wizard.handleNativeEvent({ type: "action", key: "0", act: "continue", mods: [] });
			await done;
		} finally {
			wizard.dispose();
		}
	});
});

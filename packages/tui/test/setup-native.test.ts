import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type {
	SetupHost,
	SetupScene,
	SetupSceneController,
	SetupSceneHost,
	SetupUiHost,
} from "../src/setup/scenes/types";
import { SETUP_OUTRO_MS } from "../src/setup/scenes/outro";
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

/** A setup host for the wizard: the fake UI plus the one app call the outro makes. */
function fakeSetupHost(ui: SetupUiHost, current?: string): SetupHost {
	return {
		...ui,
		getModels: () => ({ available: [], all: [], current: current ? { name: current } : undefined }),
	} as unknown as SetupHost;
}

/** A scene that records its mounts and finishes on demand. */
function probeScene(id: string, ansiOnly = false): SetupScene & { hosts: SetupSceneHost[] } {
	const hosts: SetupSceneHost[] = [];
	return {
		id,
		title: `${id} title`,
		step: id,
		minVersion: 1,
		ansiOnly,
		hosts,
		mount: host => {
			hosts.push(host);
			return { title: `${id} title`, render: () => [] };
		},
	};
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
			step: "Probe",
			minVersion: 1,
			mount: () => {
				mounted = { title: "Probe scene", render: () => [] };
				return mounted;
			},
		};
		const wizard = new SetupWizardComponent(fakeSetupHost(ui.host), [scene]);
		const done = wizard.run();
		try {
			advance(SETUP_SPLASH_MS - 1);
			expect(mounted).toBeUndefined();
			advance(1);
			expect(mounted).toBeDefined();
			expect(nodes([wizard.describe(cx)]).some(n => n.c?.some(child => child === mounted))).toBe(true);
			// run() + the scene mount; no 33ms repaint loop across the splash.
			expect(ui.renders()).toBe(2);

			wizard.handleInput("\x03");
			expect(nodes([wizard.describe(cx)]).some(n => n.p?.actions?.click === "continue")).toBe(true);
			wizard.handleNativeEvent({ type: "action", key: "0", act: "continue", mods: [] });
			await done;
		} finally {
			wizard.dispose();
		}
	});

	it("skips ansiOnly scenes and counts only the applicable ones in the stepper", () => {
		const ui = fakeUi();
		const [first, ansi, last] = [probeScene("first"), probeScene("ansi", true), probeScene("last")];
		const wizard = new SetupWizardComponent(fakeSetupHost(ui.host), [first, ansi, last]);
		void wizard.run();
		try {
			wizard.handleNativeEvent({ type: "action", key: "", act: "skip", mods: [] });
			const steps = nodes([wizard.describe(cx)]).filter(n => n.p?.role === "omp.setup.step");
			expect(steps.map(n => n.p?.tone)).toEqual(["accent", "muted"]);

			first.hosts[0]?.finish("done");
			expect(ansi.hosts).toHaveLength(0);
			expect(last.hosts).toHaveLength(1);
			const after = nodes([wizard.describe(cx)]).filter(n => n.p?.role === "omp.setup.step");
			expect(after.map(n => n.p?.tone)).toEqual(["success", "accent"]);
		} finally {
			wizard.dispose();
		}
	});

	it("asks ansiOnly scenes when rendering ANSI", () => {
		setNativeRendering(false);
		const ui = fakeUi();
		const [first, ansi] = [probeScene("first"), probeScene("ansi", true)];
		const wizard = new SetupWizardComponent(fakeSetupHost(ui.host), [first, ansi]);
		void wizard.run();
		try {
			wizard.handleInput("\r");
			advance(1000);
			expect(wizard.render(80).some(line => line.includes("Setup step 1 of 2"))).toBe(true);
			first.hosts[0]?.finish("done");
			expect(ansi.hosts).toHaveLength(1);
		} finally {
			wizard.dispose();
		}
	});

	it("completes without a splash when no scene applies to the native surface", async () => {
		const ui = fakeUi();
		const scene = probeScene("ansi", true);
		const wizard = new SetupWizardComponent(fakeSetupHost(ui.host), [scene]);
		await wizard.run();
		expect(scene.hosts).toHaveLength(0);
		expect(ui.renders()).toBe(0);
	});

	it("Exit setup reaches the outro, which reports the default model", async () => {
		const ui = fakeUi();
		const scene = probeScene("first");
		const wizard = new SetupWizardComponent(fakeSetupHost(ui.host, "Opus 4.5"), [scene]);
		const done = wizard.run();
		try {
			wizard.handleNativeEvent({ type: "action", key: "", act: "skip", mods: [] });
			expect(nodes([wizard.describe(cx)]).some(n => n.p?.actions?.click === "exit")).toBe(true);
			wizard.handleNativeEvent({ type: "action", key: "", act: "exit", mods: [] });
			const outro = nodes([wizard.describe(cx)]);
			expect(outro.some(n => n.p?.role === "omp.setup.outro.model")).toBe(true);
			expect(JSON.stringify(outro.find(n => n.p?.role === "omp.setup.outro.model")?.p)).toContain("Opus 4.5");
			advance(SETUP_OUTRO_MS);
			await done;
		} finally {
			wizard.dispose();
		}
	});
});

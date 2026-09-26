import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { webModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import { runOnboardingSetup } from "@oh-my-pi/pi-coding-agent/commands/setup";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ALL_SCENES,
	createSetupHost,
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	runSetupWizard,
	type SetupScene,
	type SetupSceneHost,
	selectSetupScenes,
} from "@oh-my-pi/pi-coding-agent/modes/setup";
import { providersSetupScene } from "@oh-my-pi/pi-tui/setup/scenes/providers";
import { themeSetupScene } from "@oh-my-pi/pi-tui/setup/scenes/theme";
import { WebSearchTab } from "@oh-my-pi/pi-tui/setup/scenes/web-search";
import { SetupWizardComponent } from "@oh-my-pi/pi-tui/setup/wizard-overlay";
import { setTerminalGlyphProtocol } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SEARCH_PROVIDER_OPTIONS } from "@oh-my-pi/pi-tui/tools/web-search";

import { cfgSetupVersion, cfgSymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/settings";

type SetupApplicationSceneHost = Omit<SetupSceneHost, "ctx"> & { ctx: InteractiveModeContext };

function bindSceneHost(host: SetupApplicationSceneHost): SetupSceneHost {
	return { ...host, ctx: createSetupHost(host.ctx) };
}

function fakeContextWithConfiguredModel(): InteractiveModeContext {
	return {
		session: {
			modelRegistry: {
				getAvailable: () => [{ provider: "configured", id: "model" }],
			},
		},
	} as unknown as InteractiveModeContext;
}

function testScene(id: string, minVersion: number, shouldRun?: () => boolean): SetupScene {
	return {
		id,
		title: id,
		minVersion,
		shouldRun,
		mount: () => ({
			title: id,
			render: () => [],
			invalidate: () => {},
		}),
	};
}

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

describe("setup wizard scene selection", () => {
	it("runs all v1 scenes for a new user", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
	});

	it("keeps CURRENT_SETUP_VERSION in sync with the highest scene minVersion", () => {
		// main.ts's cold-launch gate sources CURRENT_SETUP_VERSION from the tiny
		// `setup-version` module to decide whether to load the wizard at all. If a
		// new scene raises the bar but the constant is not bumped, stale installs
		// would never see the scene. Guard the invariant the gate relies on.
		const highestMinVersion = Math.max(...ALL_SCENES.map(scene => scene.minVersion));
		expect(CURRENT_SETUP_VERSION).toBe(highestMinVersion);
	});

	it("runs only scenes newer than the stored setup version", async () => {
		const scenes = [testScene("v1-a", 1), testScene("v1-b", 1), testScene("v2", 2)];
		const selected = await selectSetupScenes(1, scenes, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(selected.map(scene => scene.id)).toEqual(["v2"]);
	});

	it("runs no scenes at the current setup version", async () => {
		const scenes = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, fakeContextWithConfiguredModel(), {
			isTTY: true,
		});
		expect(scenes).toEqual([]);
	});

	it("honors hard environment gates", async () => {
		const ctx = fakeContextWithConfiguredModel();
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, resuming: true })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, skipEnv: "1" })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, setupWizardEnabled: false })).toEqual([]);
	});

	it("keeps the providers scene eligible even when a model is already configured", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.some(scene => scene.id === "providers")).toBe(true);
	});

	it("force mode ignores version and user skip gates but still requires a TTY", async () => {
		const ctx = fakeContextWithConfiguredModel();
		const selected = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, ctx, {
			isTTY: true,
			setupWizardEnabled: false,
			skipEnv: "1",
			resuming: true,
			force: true,
		});
		expect(selected.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false, force: true })).toEqual([]);
	});

	it("drops the glyph scene once the terminal renders omp's bundled icons in-band", async () => {
		setTerminalGlyphProtocol(true);
		try {
			const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
			expect(scenes.map(scene => scene.id)).toEqual(
				ALL_SCENES.map(scene => scene.id).filter(id => id !== "glyph-mode"),
			);
		} finally {
			setTerminalGlyphProtocol(false);
		}
	});

	it("applies scene shouldRun only as a hard environment gate", async () => {
		const selected = await selectSetupScenes(
			0,
			[testScene("blocked", 1, () => false), testScene("allowed", 1, () => true)],
			fakeContextWithConfiguredModel(),
			{ isTTY: true },
		);
		expect(selected.map(scene => scene.id)).toEqual(["allowed"]);
	});
});

describe("setup wizard model selection", () => {
	const CUSTOM_MODEL: Model = buildModel({
		id: "minimax-m3",
		name: "MiniMax M3",
		api: "openai-completions",
		provider: "spark",
		baseUrl: "http://127.0.0.1:8000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 32_000,
	});

	async function pickModelDuringSetup(settings: Settings): Promise<string> {
		await initTheme(false, "unicode", false, "titanium", "dark");
		let available: Model[] = [];
		const finished = Promise.withResolvers<string>();
		const setModel = mock(
			async (
				selected: Model,
				role: string,
				options?: { selector?: string; persist?: boolean },
			): Promise<{ switched: boolean }> => {
				if (options?.persist) {
					settings.setModelRole(role, options.selector ?? `${selected.provider}/${selected.id}`);
				}
				return { switched: true };
			},
		);
		const host = bindSceneHost({
			ctx: {
				settings,
				session: {
					model: undefined,
					modelRegistry: {
						getAvailable: () => available,
						getAll: () => available,
						refresh: async (strategy: string) => {
							if (strategy === "online-if-uncached") available = [CUSTOM_MODEL];
						},
					},
					setModel,
				},
				ui: { terminal: { rows: 30 } },
			},
			requestRender: () => {},
			finish: (next: string) => finished.resolve(next),
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);
		const scene = ALL_SCENES.find(candidate => candidate.id === "model");
		expect(scene).toBeDefined();

		const controller = scene!.mount(host);
		expect(controller.render?.(120).join("\n")).not.toContain("minimax-m3");
		await controller.onMount?.();
		expect(controller.render?.(120).join("\n")).toContain("minimax-m3");
		controller.handleInput?.("\r");
		return finished.promise;
	}

	it("discovers and saves an uncached custom model as the global default", async () => {
		const settings = Settings.isolated();

		const result = await pickModelDuringSetup(settings);

		expect(result).toBe("done");
		expect(settings.getGlobalModelRole("default")).toBe("spark/minimax-m3");
		expect(settings.getProjectModelRole("default")).toBeUndefined();
	});

	it("saves to the project layer under project role storage", async () => {
		const settings = Settings.isolated({ modelRoleStorage: "project" });

		const result = await pickModelDuringSetup(settings);

		expect(result).toBe("done");
		expect(settings.getProjectModelRole("default")).toBe("spark/minimax-m3");
		expect(settings.getGlobalModelRole("default")).toBeUndefined();
	});
});

describe("setup wizard persistence", () => {
	it("marks the current setup version complete", async () => {
		const settings = Settings.isolated();
		await markSetupWizardComplete(settings);
		expect(cfgSetupVersion.get(settings)).toBe(CURRENT_SETUP_VERSION);
	});

	it("can run a targeted scene without setup-version or welcome-intro side effects", async () => {
		const settings = Settings.isolated({ setupVersion: 0 });
		const hideOverlay = mock(() => {});
		const setFocus = mock((_component: unknown) => {});
		const requestRender = mock(() => {});
		const playWelcomeIntro = mock(() => {});
		let component: SetupWizardComponent | undefined;
		const scene: SetupScene = {
			id: "providers",
			title: "providers",
			minVersion: 1,
			mount: host => ({
				title: "providers",
				onMount: () => host.finish("done"),
				render: () => [],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings,
			playWelcomeIntro,
			ui: {
				terminal: { rows: 24 },
				showOverlay: (nextComponent: SetupWizardComponent) => {
					component = nextComponent;
					return { hide: hideOverlay };
				},
				setFocus,
				requestRender,
			},
		} as unknown as InteractiveModeContext;

		const pending = runSetupWizard(ctx, [scene], { markComplete: false, playWelcomeIntro: false });
		component?.handleInput?.("\n");
		component?.handleInput?.("\n");
		await pending;

		expect(cfgSetupVersion.get(settings)).toBe(0);
		expect(playWelcomeIntro).not.toHaveBeenCalled();
		expect(hideOverlay).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalled();
	});
});
describe("setup wizard mouse routing", () => {
	it("synthesizes arrow keys from wheel notches for scenes without routeMouse", () => {
		const received: string[] = [];
		const scene: SetupScene = {
			id: "scrollable",
			title: "scrollable",
			minVersion: 1,
			mount: () => ({
				title: "scrollable",
				handleInput: (data: string) => received.push(data),
				render: () => [],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(createSetupHost(ctx), [scene]);
		try {
			void component.run();
			// Left click during the splash advances into the scene, like Enter.
			component.handleInput("\x1b[<0;5;5M");
			component.handleInput("\x1b[<64;10;5M"); // wheel up
			component.handleInput("\x1b[<65;10;5M"); // wheel down
			component.handleInput("\x1b[<35;10;5M"); // pointer motion — swallowed
			component.handleInput("\x1b[<0;10;5M"); // click in scene — swallowed
			expect(received).toEqual(["\x1b[A", "\x1b[B"]);
		} finally {
			component.dispose();
		}
	});

	it("routes hit-tested mouse events at scene-local coordinates to scenes with routeMouse", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const routed: { kind: string; line: number; col: number }[] = [];
		const keys: string[] = [];
		const scene: SetupScene = {
			id: "mouse",
			title: "mouse",
			minVersion: 1,
			mount: () => ({
				title: "mouse",
				handleInput: (data: string) => keys.push(data),
				routeMouse: (event, line, col) => {
					const kind =
						event.wheel !== null
							? `wheel:${event.wheel}`
							: event.motion
								? "motion"
								: event.leftClick
									? "click"
									: "other";
					routed.push({ kind, line, col });
				},
				render: () => ["MARKER-ROW"],
				invalidate: () => {},
			}),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows: 24 },
				setFocus: () => {},
				requestRender: () => {},
			},
		} as unknown as InteractiveModeContext;
		const component = new SetupWizardComponent(createSetupHost(ctx), [scene]);
		try {
			void component.run();
			component.handleInput("\r"); // splash → scene
			await Bun.sleep(500); // let the splash→scene dissolve (420ms) finish so the frame is the scene
			const frame = component.render(80);
			const row = frame.findIndex(line => line.includes("MARKER-ROW"));
			expect(row).toBeGreaterThan(0);
			const indent = /^ */.exec(frame[row])?.[0].length ?? 0;
			expect(indent).toBeGreaterThan(0);
			// SGR reports are 1-based; two columns into the marker text.
			component.handleInput(`\x1b[<35;${indent + 3};${row + 1}M`);
			component.handleInput(`\x1b[<0;${indent + 3};${row + 1}M`);
			component.handleInput("\x1b[<64;1;1M"); // wheel forwards regardless of pointer position
			expect(routed.slice(0, 2)).toEqual([
				{ kind: "motion", line: 0, col: 2 },
				{ kind: "click", line: 0, col: 2 },
			]);
			expect(routed[2]?.kind).toBe("wheel:-1");
			// routeMouse scenes get no synthesized arrows and no raw SGR bytes.
			expect(keys).toEqual([]);
		} finally {
			component.dispose();
		}
	});
});
describe("setup wizard short terminals", () => {
	function shortTerminalCtx(rows: number): InteractiveModeContext {
		return {
			settings: Settings.isolated(),
			ui: {
				terminal: { rows },
				setFocus: () => {},
				requestRender: () => {},
				invalidate: () => {},
			},
			session: {
				modelRegistry: {
					authStorage: {
						credentials: { has: () => false },
						keys: { source: () => undefined },
					},
				},
			},
			openInBrowser: () => {},
		} as unknown as InteractiveModeContext;
	}

	/**
	 * Advance the wizard's dissolve clock past SCENE_TRANSITION_MS so render()
	 * shows the fully revealed scene without waiting real time. Activate after
	 * the splash→scene input (the transition timestamps itself on entry).
	 */
	function skipDissolve(): { mockRestore(): void } {
		const realNow = performance.now.bind(performance);
		return vi.spyOn(performance, "now").mockImplementation(() => realNow() + 1_000);
	}

	it("keeps the selected provider row visible while navigating on a 24-row terminal", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const component = new SetupWizardComponent(createSetupHost(shortTerminalCtx(24)), [providersSetupScene]);
		void component.run();
		component.handleInput("\r"); // splash → scene
		const nowSpy = skipDissolve();
		try {
			// Walk down past a full wrap and back up; the selection must stay
			// inside the 24-row frame on every step (the list window used to
			// assume ten visible rows and the wizard clipped the cursor off).
			for (const key of [...Array(45).fill("\x1b[B"), "\x1b[A", "\x1b[A"]) {
				component.handleInput(key);
				const frame = component.render(80).map(line => Bun.stripANSI(line));
				expect(frame.length).toBe(24);
				expect(frame.some(line => line.includes(`${theme.nav.cursor} `))).toBe(true);
			}
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});

	it("keeps the curated theme list and its selection visible on a 24-row terminal", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const component = new SetupWizardComponent(createSetupHost(shortTerminalCtx(24)), [themeSetupScene]);
		void component.run();
		component.handleInput("\r"); // splash → scene
		const nowSpy = skipDissolve();
		try {
			const frame = component.render(80).map(line => Bun.stripANSI(line));
			expect(frame.length).toBe(24);
			expect(frame.some(line => line.trimStart().startsWith(theme.nav.cursor))).toBe(true);
			for (const label of ["Match terminal", "Titanium", "Light", "Colorblind colors", "ANSI-safe", "Browse all"]) {
				expect(frame.some(line => line.includes(label))).toBe(true);
			}
		} finally {
			nowSpy.mockRestore();
			component.dispose();
		}
	});
});

describe("setup wizard theme previews", () => {
	it("restores the selected glyph preset after previewing ANSI-safe mode", async () => {
		await initTheme(false, "nerd", false, "titanium", "light");
		const settings = Settings.isolated({ symbolPreset: "nerd", colorBlindMode: false });
		const setupScene = ALL_SCENES.find(scene => scene.id === "theme");
		expect(setupScene).toBeDefined();

		const host = bindSceneHost({
			ctx: {
				settings,
				ui: {
					invalidate: () => {},
					requestRender: () => {},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		const controller = setupScene!.mount(host);
		controller.handleInput?.("5");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("ascii");

		controller.handleInput?.("2");
		await Bun.sleep(20);
		expect(cfgSymbolPreset.get(settings)).toBe("nerd");
		expect(theme.getSymbolPreset()).toBe("nerd");
	});
});

describe("setup wizard glyph scene", () => {
	it("lists Nerd Font first and commits the chosen preset", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const settings = Settings.isolated();
		const scene = ALL_SCENES.find(s => s.id === "glyph-mode");
		expect(scene).toBeDefined();

		let finished = false;
		const host = bindSceneHost({
			ctx: {
				settings,
				ui: { invalidate: () => {}, requestRender: () => {} },
			},
			requestRender: () => {},
			finish: () => {
				finished = true;
			},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		const controller = scene!.mount(host);
		// Row "1" is now Nerd Font (it must lead the list).
		controller.handleInput?.("1");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("nerd");

		controller.handleInput?.("\n");
		await Bun.sleep(20);
		expect(cfgSymbolPreset.get(settings)).toBe("nerd");
		expect(finished).toBe(true);
	});
});

describe("setup wizard web search tab", () => {
	const webModels = (webModelManagerOptions().staticModels ?? []).map(model => buildModel(model));
	const googleGemini = buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		webSearch: "gemini",
	});

	it("persists the highlighted provider as the web model role", async () => {
		const settings = Settings.isolated();
		const host = bindSceneHost({
			ctx: {
				settings,
				session: {
					modelRegistry: {
						authStorage: { keys: { source: () => undefined } },
						getAll: () => webModels,
						getAvailable: () => webModels,
					},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		const tab = new WebSearchTab(host);
		tab.handleInput("\x1b[B"); // move off "auto" to the next provider
		tab.handleInput("\n"); // confirm the highlighted provider
		await Bun.sleep(20);

		const expected = SEARCH_PROVIDER_OPTIONS[1]!.value;
		expect(expected).not.toBe("auto");
		expect(settings.getModelRole("web")).toBe(`web/${expected}`);
	});

	it("can select the last provider in the setup TUI list", async () => {
		const settings = Settings.isolated();
		const host = bindSceneHost({
			ctx: {
				settings,
				session: {
					modelRegistry: {
						authStorage: { keys: { source: () => undefined } },
						getAll: () => webModels,
						getAvailable: () => webModels,
					},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		const tab = new WebSearchTab(host);
		for (let i = 1; i < SEARCH_PROVIDER_OPTIONS.length; i++) {
			tab.handleInput("\x1b[B");
		}
		tab.handleInput("\n");
		await Bun.sleep(20);

		const lastOption = SEARCH_PROVIDER_OPTIONS[SEARCH_PROVIDER_OPTIONS.length - 1]!;
		const lastValue = lastOption.value;
		if (lastValue === "auto") throw new Error("last option must be a concrete provider");
		expect(settings.getModelRole("web")).toBe(`web/${lastValue}`);
	});

	it("reports Gemini ready when only Antigravity OAuth is signed in", async () => {
		// #13023: the readiness probe must resolve against the credential-filtered
		// pool (getAvailable) rather than the full catalog — google/gemini-2.5-flash
		// leads the web priority order but has no credential in this scenario, so a
		// getAll-based probe would pick it and report "Not configured yet".
		const antigravityGemini = buildModel({
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			webSearch: "gemini",
		});
		const settings = Settings.isolated();
		const host = bindSceneHost({
			ctx: {
				settings,
				session: {
					modelRegistry: {
						authStorage: {
							credentials: { hasOAuth: (provider: string) => provider === "google-antigravity" },
							keys: { source: () => undefined },
						},
						getAll: () => [googleGemini, antigravityGemini],
						getAvailable: () => [antigravityGemini],
					},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		expect(await host.ctx.isSearchProviderAvailable("gemini")).toBe(true);
	});

	it("still saves and highlights a grounded provider that has no credentials yet", async () => {
		// The tab confirms "Web search set to …" and tells the user to add a key
		// afterwards, so the preference must persist even though the credentialed
		// pool has no Gemini model.
		const settings = Settings.isolated();
		const host = bindSceneHost({
			ctx: {
				settings,
				session: {
					modelRegistry: {
						authStorage: { credentials: { hasOAuth: () => false }, keys: { source: () => undefined } },
						getAll: () => [googleGemini],
						getAvailable: () => [],
					},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupApplicationSceneHost);

		host.ctx.saveSearchProvider("gemini");
		expect(settings.getModelRole("web")).toBe("google/gemini-2.5-flash");
		expect(host.ctx.webSearchOrder).toEqual(["gemini"]);
		expect(await host.ctx.isSearchProviderAvailable("gemini")).toBe(false);
	});
});

describe("omp setup onboarding trigger", () => {
	it("starts the normal interactive command with forced setup wizard", async () => {
		let forceSetupWizard: boolean | undefined;
		await runOnboardingSetup({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			runRoot: async (_parsed, _rawArgs, deps) => {
				forceSetupWizard = deps?.forceSetupWizard;
			},
		});
		expect(forceSetupWizard).toBe(true);
	});

	it("rejects onboarding setup without an interactive TTY", async () => {
		let stderr = "";
		let exitCode: number | undefined;
		await expect(
			runOnboardingSetup({
				stdinIsTTY: false,
				stdoutIsTTY: true,
				writeStderr: text => {
					stderr += text;
				},
				exit: code => {
					exitCode = code;
					throw new Error("exit");
				},
			}),
		).rejects.toThrow("exit");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("interactive TTY");
	});
});

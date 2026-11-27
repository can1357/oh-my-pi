import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { runOnboardingSetup } from "@oh-my-pi/pi-coding-agent/commands/setup";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSetupVersion, cfgSymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	createSetupHost,
	markSetupWizardComplete,
	runSetupWizard,
	type SetupScene,
	selectSetupScenes,
} from "@oh-my-pi/pi-coding-agent/modes/setup";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import * as terminalSession from "@oh-my-pi/pi-tui/driver/session";
import type { SceneContext, SceneResult, SceneView, SetupHost } from "../src/ui/setup/types";
import { SetupWizard, type SetupWizardModel } from "../src/ui/setup/wizard";
import { type LayerTerminal, mountLayer } from "./helpers/layer-terminal";

function fakeContextWithConfiguredModel(): InteractiveModeContext {
	return {
		session: {
			modelRegistry: {
				getAvailable: () => [{ provider: "configured", id: "model" }],
			},
		},
	} as unknown as InteractiveModeContext;
}

function testScene(id: string, minVersion: number, mount?: SetupScene["mount"]): SetupScene {
	return {
		id,
		title: id,
		subtitle: "",
		step: id,
		minVersion,
		mount: mount ?? (() => ({ body: jsx("text", { spans: [{ t: id }] }) })),
	};
}

/** A scene context over `host` whose `finish` resolves `finished`. */
function sceneContext(host: SetupHost): {
	context: SceneContext;
	finished: Promise<SceneResult>;
} {
	const { promise, resolve } = Promise.withResolvers<SceneResult>();
	return {
		context: {
			host,
			finish: resolve,
			maxLines: signal<number | undefined>(undefined),
		},
		finished: promise,
	};
}

/** `view`'s body on a scripted terminal, focused where the wizard focuses it. */
function mountScene(view: SceneView): LayerTerminal {
	const term = mountLayer(() => view.body);
	const root = term.term.surface.layer()[0];
	if (root) term.term.focus(view.focusTarget?.(root) ?? root);
	return term;
}

describe("setup wizard scene selection", () => {
	// Tests run from a source checkout, which never updates itself; pin a self-updating install.
	beforeEach(() => {
		vi.spyOn(updateCli, "canSelfUpdate").mockResolvedValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

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
		expect(
			await selectSetupScenes(0, ALL_SCENES, ctx, {
				isTTY: true,
				resuming: true,
			}),
		).toEqual([]);
		expect(
			await selectSetupScenes(0, ALL_SCENES, ctx, {
				isTTY: true,
				skipEnv: "1",
			}),
		).toEqual([]);
		expect(
			await selectSetupScenes(0, ALL_SCENES, ctx, {
				isTTY: true,
				setupWizardEnabled: false,
			}),
		).toEqual([]);
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
		expect(
			await selectSetupScenes(0, ALL_SCENES, ctx, {
				isTTY: false,
				force: true,
			}),
		).toEqual([]);
	});

	it("skips the auto-update question where omp cannot update itself (Tern, Nix, a source checkout)", async () => {
		vi.spyOn(updateCli, "canSelfUpdate").mockResolvedValue(false);
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.map(scene => scene.id)).toEqual(
			ALL_SCENES.map(scene => scene.id).filter(id => id !== "auto-update"),
		);
	});

	it("drops the glyph scene once the terminal renders omp's bundled icons in-band", async () => {
		const identity = terminalSession.terminalIdentity();
		vi.spyOn(terminalSession, "terminalIdentity").mockReturnValue({
			...identity,
			glyphs: true,
		});
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.map(scene => scene.id)).toEqual(
			ALL_SCENES.map(scene => scene.id).filter(id => id !== "glyph-mode"),
		);
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
		let available: Model[] = [];
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
		const refreshed = Promise.withResolvers<void>();
		const host = createSetupHost({
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAvailable: () => available,
					getAll: () => available,
					refresh: async (strategy: string) => {
						if (strategy === "online-if-uncached") available = [CUSTOM_MODEL];
						refreshed.resolve();
					},
				},
				setModel,
				effectiveServiceTier: () => undefined,
			},
		} as unknown as InteractiveModeContext);
		const scene = ALL_SCENES.find(candidate => candidate.id === "model");
		expect(scene).toBeDefined();

		const { context, finished } = sceneContext(host);
		const view = scene!.mount(context);
		const term = mountScene(view);
		try {
			expect(term.text()).not.toContain("minimax-m3");
			view.onMount?.();
			await refreshed.promise;
			await Promise.resolve();
			expect(term.text()).toContain("minimax-m3");
			term.handleInput("\r");
			return await finished;
		} finally {
			term.dispose();
			view.dispose?.();
		}
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

	function nativeShellCtx(settings: Settings, playWelcomeIntro: () => void): InteractiveModeContext {
		// Tern draws its own look, so the terminal-look `theme` scene is not shown there.
		return {
			settings,
			playWelcomeIntro,
			shell: { native: () => true },
		} as unknown as InteractiveModeContext;
	}

	it("can run a targeted scene without setup-version or welcome-intro side effects", async () => {
		const settings = Settings.isolated({ setupVersion: 0 });
		const playWelcomeIntro = mock(() => {});
		const theme = ALL_SCENES.find(scene => scene.id === "theme")!;

		await runSetupWizard(nativeShellCtx(settings, playWelcomeIntro), [theme], {
			markComplete: false,
			playWelcomeIntro: false,
		});

		expect(cfgSetupVersion.get(settings)).toBe(0);
		expect(playWelcomeIntro).not.toHaveBeenCalled();
	});

	it("persists completion and plays the welcome intro by default", async () => {
		const settings = Settings.isolated();
		const playWelcomeIntro = mock(() => {});
		const theme = ALL_SCENES.find(scene => scene.id === "theme")!;

		await runSetupWizard(nativeShellCtx(settings, playWelcomeIntro), [theme]);

		expect(cfgSetupVersion.get(settings)).toBe(CURRENT_SETUP_VERSION);
		expect(playWelcomeIntro).toHaveBeenCalledTimes(1);
	});
});

describe("setup wizard mouse wheel", () => {
	function mountWizard(scene: SetupScene): {
		model: SetupWizardModel;
		term: LayerTerminal;
	} {
		let model: SetupWizardModel | undefined;
		const host = createSetupHost({
			settings: Settings.isolated(),
		} as unknown as InteractiveModeContext);
		const term = mountLayer(
			() =>
				SetupWizard({
					host,
					scenes: [scene],
					version: "0.0.0",
					now: () => 0,
					rows: () => 24,
					onDone: () => {},
					ref: m => {
						model = m;
					},
				}),
			{ columns: 80, rows: 24 },
		);
		if (!model) throw new Error("Setup wizard did not hand out its model");
		model.skipSplash();
		term.render();
		return { model, term };
	}

	it("sends arrow keys to scenes without their own wheel handling", () => {
		const received: string[] = [];
		const { model, term } = mountWizard(
			testScene("scrollable", 1, () => ({
				body: jsx("col", {
					onKey: (key: { id: string }) => {
						received.push(key.id);
						return true;
					},
					children: jsx("text", { spans: [{ t: "scrollable" }] }),
				}),
			})),
		);
		try {
			model.wheel(-1);
			model.wheel(1);
			expect(received).toEqual(["up", "down"]);
		} finally {
			term.dispose();
		}
	});

	it("hands the wheel to scenes that scroll themselves, without synthesized keys", () => {
		const wheel: number[] = [];
		const keys: string[] = [];
		const { model, term } = mountWizard(
			testScene("mouse", 1, () => ({
				body: jsx("col", {
					onKey: (key: { id: string }) => {
						keys.push(key.id);
						return true;
					},
					children: jsx("text", { spans: [{ t: "MARKER-ROW" }] }),
				}),
				wheel: delta => void wheel.push(delta),
			})),
		);
		try {
			model.wheel(-1);
			model.wheel(1);
			expect(wheel).toEqual([-1, 1]);
			expect(keys).toEqual([]);
		} finally {
			term.dispose();
		}
	});
});

describe("setup wizard glyph scene", () => {
	it("lists Nerd Font first and commits the chosen preset", async () => {
		const settings = Settings.isolated();
		const scene = ALL_SCENES.find(s => s.id === "glyph-mode");
		expect(scene).toBeDefined();

		const host = createSetupHost({
			settings,
		} as unknown as InteractiveModeContext);
		// The preview restyles the whole UI; record it instead of switching the shared theme.
		const preview = vi.fn();
		const { context, finished } = sceneContext(
			Object.assign(Object.create(host) as SetupHost, {
				previewSymbolPreset: preview,
			}),
		);
		const view = scene!.mount(context);
		const term = mountScene(view);
		try {
			// Row "1" is Nerd Font (it must lead the list) and previews across the UI.
			term.handleInput("1");
			expect(preview).toHaveBeenLastCalledWith("nerd");

			term.handleInput("\r");
			expect(await finished).toBe("done");
			expect(cfgSymbolPreset.get(settings)).toBe("nerd");
		} finally {
			term.dispose();
			view.dispose?.();
		}
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

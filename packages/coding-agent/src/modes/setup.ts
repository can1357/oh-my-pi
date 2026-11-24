/**
 * Onboarding on the interactive shell: picks the setup scenes this launch
 * should show, runs the setup wizard (or the provider sign-in alone) and the
 * standalone startup splash as fullscreen apps, and binds the scenes to the
 * application's settings, theme service and model registry.
 */
import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { type JSXNode, jsx, type PageProps, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { terminalIdentity } from "@oh-my-pi/pi-tui/driver/session";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import { canSelfUpdate } from "../cli/update-cli";
import { cfgDisabledProviders, cfgModelRoleStorage } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { CURRENT_SETUP_VERSION } from "../config/setup-version";
import { presentFullscreen } from "../ui/apps/fullscreen";
import { StartupSplash } from "../ui/setup/splash";
import type { GlyphPreset, SetupHost, SetupScene, ThemeLook } from "../ui/setup/types";
import { ALL_SCENES, SetupWizard } from "../ui/setup/wizard";
import {
	endThemePreview,
	getAvailableThemesWithPaths,
	getCurrentThemeName,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
} from "../ui/theme/service";
import { createModelBrowserSource } from "./model-browser-source";
import {
	cfgColorBlindMode,
	cfgComposerShape,
	cfgSetupVersion,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
	cfgUpdateAuto,
} from "./settings";
import type { InteractiveModeContext } from "./types";
import {
	type RunSetupWizardOptions,
	type SetupSceneSelectionOptions,
	setupWizardAllowed,
} from "./view-model/setup/wizard";

export type { SetupScene } from "../ui/setup/types";
export { ALL_SCENES, CURRENT_SETUP_VERSION, setupWizardAllowed };

/** The setup page (wizard and startup splash) as Tern draws it: a screen of its own role, all `main`. */
const SETUP_PAGE: PageProps = { role: "omp.app.setup" };

/** Animation clock of the setup screens (ms). */
const SETUP_FRAME_MS = 33;

/**
 * Scenes that ask about the terminal renderer's own look (glyphs, composer frame, theme): Tern
 * draws the UI itself, so they are skipped there.
 */
const TERMINAL_ONLY_SCENES: Record<string, true> = {
	"glyph-mode": true,
	"composer-shape": true,
	theme: true,
};

/** Scenes whose question only applies on some installs. */
const SCENE_APPLIES: Record<string, () => boolean | Promise<boolean>> = {
	// A terminal serving Glyph Protocol draws omp's icons without a Nerd Font.
	"glyph-mode": () => !terminalIdentity().glyphs,
	// Self-update is not offered in a source checkout or a package-manager install.
	"auto-update": () => canSelfUpdate(),
};

/** Bind application preferences and runtime effects to the setup presentation. */
export function createSetupHost(ctx: InteractiveModeContext): SetupHost {
	const modelSource = createModelBrowserSource(ctx.settings, model => ctx.session.effectiveServiceTier(model));
	const configuredLook = (): ThemeLook => ({
		theme: getCurrentThemeName() ?? "dark",
		symbols: cfgSymbolPreset.get(ctx.settings) as GlyphPreset,
		colorBlind: cfgColorBlindMode.get(ctx.settings),
	});
	const startLook = configuredLook();
	return {
		get composerShape() {
			return cfgComposerShape.get(ctx.settings);
		},
		get symbolPreset() {
			return cfgSymbolPreset.get(ctx.settings) as GlyphPreset;
		},
		get colorBlindMode() {
			return cfgColorBlindMode.get(ctx.settings);
		},
		themeName: startLook.theme,
		get disabledProviders() {
			return cfgDisabledProviders.get(ctx.settings);
		},
		get autoUpdate() {
			return cfgUpdateAuto.get(ctx.settings);
		},
		get authStorage() {
			return ctx.session.modelRegistry.authStorage;
		},
		agentDir: getAgentDir(),
		previewSymbolPreset: preset => void setSymbolPreset(preset ?? (cfgSymbolPreset.get(ctx.settings) as GlyphPreset)),
		saveSymbolPreset: preset => {
			cfgSymbolPreset.set(ctx.settings, preset);
		},
		saveComposerShape: async shape => {
			cfgComposerShape.set(ctx.settings, shape);
			await ctx.settings.flush();
		},
		saveAutoUpdate: async enabled => {
			cfgUpdateAuto.set(ctx.settings, enabled);
			await ctx.settings.flush();
		},
		previewTheme: async look => {
			if (look === null) {
				await endThemePreview();
				await setSymbolPreset(startLook.symbols);
				await setColorBlindMode(startLook.colorBlind);
				return;
			}
			await previewTheme(look.theme);
			await setSymbolPreset(look.symbols);
			await setColorBlindMode(look.colorBlind);
		},
		applyTheme: async look => {
			await setTheme(look.theme);
			await setSymbolPreset(look.symbols);
			await setColorBlindMode(look.colorBlind);
		},
		saveTheme: (slot, name) => {
			(slot === "dark" ? cfgThemeDark : cfgThemeLight).set(ctx.settings, name);
		},
		saveColorBlindMode: enabled => {
			cfgColorBlindMode.set(ctx.settings, enabled);
		},
		listThemes: async () => (await getAvailableThemesWithPaths()).map(theme => theme.name),
		modelSource,
		getModels: () => ({
			available: ctx.session.modelRegistry.getAvailable("all"),
			all: ctx.session.modelRegistry.getAll("all"),
			current: ctx.session.model,
		}),
		refreshModels: () => ctx.session.modelRegistry.refresh("online-if-uncached"),
		selectModel: async (model, selector) => {
			const projectScope = cfgModelRoleStorage.get(ctx.settings) === "project";
			await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope) ctx.settings.setProjectModelRole("default", selector);
			await ctx.settings.flush();
		},
		refreshProvider: async provider => {
			// An OAuth alias (`openai-codex-device`) stores its credential under the base provider.
			await ctx.session.modelRegistry.refreshProvider(getOAuthCredentialProvider(provider), "online");
			await ctx.session.refreshScopedModels();
		},
		openInBrowser: url => ctx.openInBrowser(url),
	};
}

/** Persist completion only after the setup overlay finishes. */
export async function markSetupWizardComplete(settings: Settings, version = CURRENT_SETUP_VERSION): Promise<void> {
	cfgSetupVersion.set(settings, version);
	await settings.flush();
}

/** The scenes newer than `storedVersion` (all with `force`) whose question applies on this install. */
export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	_ctx?: InteractiveModeContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	if (!setupWizardAllowed(options)) return [];
	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion <= storedVersion) continue;
		if (await (SCENE_APPLIES[scene.id]?.() ?? true)) selected.push(scene);
	}
	return selected;
}

/** A ticking clock for setup animations; `stop` ends it. */
function setupClock(): { now: () => number; stop(): void } {
	const now = signal(Date.now());
	const timer = setInterval(() => now.set(Date.now()), SETUP_FRAME_MS);
	return { now, stop: () => clearInterval(timer) };
}

/**
 * Own the screen with the setup wizard until its scenes and outro finish. When none of `scenes`
 * applies to the renderer in use (Tern skips the terminal-look ones) nothing is shown, but
 * completion is still persisted.
 */
export async function runSetupWizard(
	ctx: InteractiveModeContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	if (scenes.length === 0) return;
	const shown = ctx.shell.native() ? scenes.filter(scene => !TERMINAL_ONLY_SCENES[scene.id]) : scenes;
	if (shown.length > 0) {
		const host = createSetupHost(ctx);
		const clock = setupClock();
		await presentFullscreen<void>(ctx.shell, screen => {
			const { promise, resolve } = Promise.withResolvers<void>();
			return {
				view: (): JSXNode =>
					jsx(SetupWizard, {
						host,
						scenes: shown,
						version: VERSION,
						now: clock.now,
						rows: screen.rows,
						focus: (node: UiNode) => ctx.shell.focus(node),
						onDone: () => resolve(),
					}),
				done: promise,
				page: SETUP_PAGE,
				mouse: "click",
				dispose: () => clock.stop(),
			};
		});
	}
	if (options.markComplete !== false) await markSetupWizardComplete(ctx.settings);
	if (options.playWelcomeIntro !== false) ctx.playWelcomeIntro();
}

/** Open provider sign-in alone, without completing onboarding or replaying the welcome intro. */
export async function runProviderSetupWizard(ctx: InteractiveModeContext): Promise<void> {
	const providers = ALL_SCENES.find(scene => scene.id === "providers");
	if (!providers) {
		ctx.showError("Provider setup is unavailable.");
		return;
	}
	await runSetupWizard(ctx, [providers], { markComplete: false, playWelcomeIntro: false });
}

/** The startup splash (`startup.splash`), until a key, a click or its time-out. */
export async function runStartupSplash(ctx: InteractiveModeContext): Promise<void> {
	const clock = setupClock();
	await presentFullscreen<void>(ctx.shell, () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		return {
			view: (): JSXNode => jsx(StartupSplash, { version: VERSION, now: clock.now, onDone: () => resolve() }),
			done: promise,
			page: SETUP_PAGE,
			mouse: "click",
			dispose: () => clock.stop(),
		};
	});
}

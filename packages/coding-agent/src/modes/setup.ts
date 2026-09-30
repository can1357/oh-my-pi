import { runProviderSetupWizard as runProviderWizard } from "@oh-my-pi/pi-tui/setup/lazy";
import type { SetupHost, SetupScene } from "@oh-my-pi/pi-tui/setup/scenes/types";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	runSetupWizard as runWizard,
	type RunSetupWizardOptions,
	selectSetupScenes as selectScenes,
	type SetupSceneSelectionOptions,
} from "@oh-my-pi/pi-tui/setup/wizard";
import type { Settings } from "../config/settings";
import { captureBrowserSession } from "../utils/browser-session";
import { copyToClipboard } from "../utils/clipboard";
import { createModelBrowserSource } from "./model-browser-source";
import type { InteractiveModeContext } from "./types";

import {
	cfgColorBlindMode,
	cfgComposerShape,
	cfgSetupVersion,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
} from "./settings";
import { cfgDisabledProviders, cfgModelRoleStorage } from "../config/model-settings";

export { ALL_SCENES, CURRENT_SETUP_VERSION };
export type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
export { runStartupSplash } from "@oh-my-pi/pi-tui/setup/startup-splash";

/** Bind application preferences and runtime effects to the setup presentation. */
export function createSetupHost(ctx: InteractiveModeContext): SetupHost {
	const modelSource = createModelBrowserSource(ctx.settings);
	return {
		ui: ctx.ui,
		get statusLine() {
			return ctx.statusLine;
		},
		get composerShape() {
			return cfgComposerShape.get(ctx.settings);
		},
		get symbolPreset() {
			return cfgSymbolPreset.get(ctx.settings);
		},
		get colorBlindMode() {
			return cfgColorBlindMode.get(ctx.settings);
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(ctx.settings);
		},
		get authStorage() {
			return ctx.session.modelRegistry.authStorage;
		},
		modelSource,
		getModels: () => ({
			available: ctx.session.modelRegistry.getAvailable(),
			all: ctx.session.modelRegistry.getAll(),
			current: ctx.session.model,
		}),
		refreshModels: () => ctx.session.modelRegistry.refresh("online-if-uncached"),
		selectModel: async (model, selector) => {
			const projectScope = cfgModelRoleStorage.get(ctx.settings) === "project";
			await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope) ctx.settings.setProjectModelRole("default", selector);
			await ctx.settings.flush();
		},
		refreshProvider: provider => ctx.session.modelRegistry.refreshProvider(provider, "online"),
		saveComposerShape: async shape => {
			cfgComposerShape.set(ctx.settings, shape);
			await ctx.settings.flush();
		},
		saveSymbolPreset: preset => {
			cfgSymbolPreset.set(ctx.settings, preset);
		},
		saveColorBlindMode: enabled => {
			cfgColorBlindMode.set(ctx.settings, enabled);
		},
		saveTheme: (mode, name) => {
			(mode === "dark" ? cfgThemeDark : cfgThemeLight).set(ctx.settings, name);
		},
		captureBrowserSession,
		copyToClipboard,
		openInBrowser: url => ctx.openInBrowser(url),
		markComplete: version => markSetupWizardComplete(ctx.settings, version),
		playWelcomeIntro: () => ctx.playWelcomeIntro(),
		showError: message => ctx.showError(message),
	};
}

/** Persist completion only after the setup overlay finishes. */
export async function markSetupWizardComplete(settings: Settings, version = CURRENT_SETUP_VERSION): Promise<void> {
	cfgSetupVersion.set(settings, version);
	await settings.flush();
}

/** Select eligible setup scenes using the application's live capabilities. */
export function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: InteractiveModeContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	return selectScenes(storedVersion, scenes, ctx ? createSetupHost(ctx) : undefined, options);
}

/** Run setup with application-owned persistence and provider effects. */
export function runSetupWizard(
	ctx: InteractiveModeContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	return runWizard(createSetupHost(ctx), scenes, options);
}

/** Open provider setup without advancing onboarding or replaying the welcome intro. */
export function runProviderSetupWizard(ctx: InteractiveModeContext): Promise<void> {
	return runProviderWizard(createSetupHost(ctx));
}

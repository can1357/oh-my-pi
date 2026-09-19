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
import { getSearchProvider, setSearchProviderOrder } from "../web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "../web/search/types";
import { createModelBrowserSource } from "./model-browser-source";
import type { InteractiveModeContext } from "./types";

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
			return ctx.settings.get("composer.shape") ?? "band";
		},
		get symbolPreset() {
			return ctx.settings.get("symbolPreset");
		},
		get colorBlindMode() {
			return ctx.settings.get("colorBlindMode");
		},
		get webSearchOrder() {
			return ctx.settings.get("providers.webSearchOrder");
		},
		get disabledProviders() {
			return ctx.settings.get("disabledProviders");
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
			const projectScope = ctx.settings.get("modelRoleStorage") === "project";
			await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope) ctx.settings.setProjectModelRole("default", selector);
			await ctx.settings.flush();
		},
		refreshProvider: provider => ctx.session.modelRegistry.refreshProvider(provider, "online"),
		saveComposerShape: async shape => {
			ctx.settings.set("composer.shape", shape);
			await ctx.settings.flush();
		},
		saveSymbolPreset: preset => {
			ctx.settings.set("symbolPreset", preset);
		},
		saveColorBlindMode: enabled => {
			ctx.settings.set("colorBlindMode", enabled);
		},
		saveTheme: (mode, name) => {
			ctx.settings.set(`theme.${mode}`, name);
		},
		isSearchProviderAvailable: async id => {
			const provider = await getSearchProvider(id);
			return provider.isExplicitlyAvailable(ctx.session.modelRegistry.authStorage);
		},
		saveSearchProvider: id => {
			const order = id === "auto" ? [] : [id, ...SEARCH_PROVIDER_ORDER.filter(candidate => candidate !== id)];
			ctx.settings.set("providers.webSearchOrder", order);
			setSearchProviderOrder(order);
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
	settings.set("setupVersion", version);
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

import type { WebSearchGrounding } from "@oh-my-pi/pi-catalog/types";
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
import { formatModelString, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { addCustomProvider } from "../config/custom-provider";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { captureBrowserSession } from "../utils/browser-session";
import { copyToClipboard } from "../utils/clipboard";
import { getGroundedSearchProvider, getSearchProvider } from "../web/search/provider";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../web/search/types";
import { createModelBrowserSource } from "./model-browser-source";
import type { InteractiveModeContext } from "./types";

export { ALL_SCENES, CURRENT_SETUP_VERSION };
export type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
export { runStartupSplash } from "@oh-my-pi/pi-tui/setup/startup-splash";

const WEB_SEARCH_GROUNDINGS: Readonly<Record<WebSearchGrounding, true>> = {
	gemini: true,
	anthropic: true,
	codex: true,
	xai: true,
	openrouter: true,
};

function isWebSearchGrounding(id: SearchProviderId): id is WebSearchGrounding {
	return id in WEB_SEARCH_GROUNDINGS;
}

function webRoleModels(ctx: InteractiveModeContext) {
	return ctx.session.modelRegistry.getAll("all").filter(getRoleInfo("web", ctx.settings).accepts);
}

function resolveWebSearchSelection(ctx: InteractiveModeContext, id: SearchProviderId) {
	const models = webRoleModels(ctx);
	if (!isWebSearchGrounding(id)) {
		const selector = `web/${id}`;
		const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
		return model ? { selector, model } : undefined;
	}

	for (const selector of rolePriorityDefaults("web")) {
		const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
		if (model?.webSearch === id) return { selector, model };
	}
	const model = models.find(candidate => candidate.webSearch === id);
	return model ? { selector: formatModelString(model), model } : undefined;
}

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
			const configured = ctx.settings.getModelRole("web")?.trim();
			if (!configured) return [];
			const model = resolveModelRoleValue(configured, webRoleModels(ctx), { settings: ctx.settings }).model;
			if (model?.provider === "web") {
				const option = SEARCH_PROVIDER_OPTIONS.find(candidate => candidate.value === model.id);
				if (option && option.value !== "auto" && option.value !== "none") return [option.value];
			}
			return model?.webSearch ? [model.webSearch] : [];
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
		addCustomProvider: provider =>
			addCustomProvider(provider, {
				authStorage: ctx.session.modelRegistry.authStorage,
				refreshProvider: id => ctx.session.modelRegistry.refreshProvider(id, "online"),
				discoverySucceeded: id => ctx.session.modelRegistry.getProviderDiscoveryState(id)?.status === "ok",
				hasChatModels: id => ctx.session.modelRegistry.getAll("chat").some(model => model.provider === id),
			}),
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
			const selection = resolveWebSearchSelection(ctx, id);
			if (!selection) return false;
			const provider = selection.model.webSearch
				? await getGroundedSearchProvider(selection.model.webSearch)
				: await getSearchProvider(selection.model.id);
			return provider.isExplicitlyAvailable(ctx.session.modelRegistry.authStorage, selection.model);
		},
		saveSearchProvider: id => {
			if (id === "auto") {
				ctx.settings.setModelRole("web", undefined);
				return;
			}
			const selection = resolveWebSearchSelection(ctx, id);
			if (selection) ctx.settings.setModelRole("web", selection.selector);
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

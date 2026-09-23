import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import type { SgrMouseEvent } from "../../mouse";
import type { ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import type { ModelBrowserSource } from "../../overlays/model-browser";
import type { SymbolPreset } from "../../theme/theme";
import type { SearchProviderId } from "../../tools/web-search";
import type { Component, TUI } from "../../tui";

/** Terminal capabilities used by setup overlays and the startup splash. */
export interface SetupUiHost {
	readonly ui: Pick<TUI, "showOverlay" | "setFocus" | "requestRender" | "invalidate"> & {
		readonly terminal: { readonly rows: number };
	};
}

/** Application-owned preferences and effects consumed by setup scenes. */
export interface SetupHost extends SetupUiHost {
	readonly statusLine: ComposerPreviewStatusSource | undefined;
	readonly composerShape: ComposerShape;
	readonly symbolPreset: SymbolPreset;
	readonly colorBlindMode: boolean;
	readonly webSearchOrder: readonly string[];
	readonly disabledProviders: readonly string[];
	readonly authStorage: AuthStorage;
	readonly modelSource: ModelBrowserSource;
	getModels(): { available: Model[]; all: Model[]; current: Model | undefined };
	refreshModels(): Promise<void>;
	selectModel(model: Model, selector: string): Promise<void>;
	refreshProvider(provider: string): Promise<void>;
	addCustomProvider?(provider: { id: string; baseUrl: string; apiKey: string }): Promise<void>;
	saveComposerShape(shape: ComposerShape): Promise<void>;
	saveSymbolPreset(preset: SymbolPreset): void;
	saveColorBlindMode(enabled: boolean): void;
	saveTheme(mode: "dark" | "light", name: string): void;
	isSearchProviderAvailable(id: SearchProviderId): Promise<boolean>;
	saveSearchProvider(id: SearchProviderId | "auto"): void;
	captureBrowserSession(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	copyToClipboard(text: string): Promise<void>;
	openInBrowser(url: string): void;
	markComplete(version: number): Promise<void>;
	playWelcomeIntro(): void;
	showError(message: string): void;
}

/** Outcome reported when an onboarding scene finishes. */
export type SetupSceneResult = "done" | "skipped";

/** Per-scene focus, rendering, completion, and application callbacks. */
export interface SetupSceneHost {
	ctx: SetupHost;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

/** Interactive content hosted inside the setup wizard frame. */
export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;
	/**
	 * Render the scene body. `maxLines` is the number of body rows the wizard
	 * will actually display (header and footer already subtracted); scenes
	 * shrink list windows and drop decorative chrome so the selected row stays
	 * inside the budget. Overflow beyond `maxLines` is clipped by the wizard.
	 */
	render(width: number, maxLines?: number): readonly string[];
	/**
	 * Route an SGR mouse report (tracking is on while the wizard holds the
	 * alternate screen). `line`/`col` are 0-based within this controller's
	 * last rendered output. When absent, the wizard falls back to synthesizing
	 * arrow keys from wheel notches.
	 */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

/**
 * A single panel inside a tabbed setup scene. The host scene owns the tab bar
 * and forwards rendering/input to the active tab.
 */
export interface SetupTab {
	readonly id: string;
	readonly label: string;
	/**
	 * While `true` the tab owns all keyboard input (e.g. an in-progress OAuth
	 * login). The parent scene MUST NOT switch tabs or finish while modal.
	 */
	readonly modal: boolean;
	/** See {@link SetupSceneController.render}: `maxLines` is the tab-local row budget. */
	render(width: number, maxLines?: number): readonly string[];
	handleInput(data: string): void;
	/** Claim an input before the parent tab bar handles it. */
	handlesInput?(data: string): boolean;
	invalidate(): void;
	/** Called when the tab becomes active (including initial mount). */
	onActivate?(): void;
	/** Mouse routing at tab-local coordinates; see {@link SetupSceneController.routeMouse}. */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

/** Versioned onboarding scene definition. */
export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: SetupHost): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}

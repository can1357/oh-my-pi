/**
 * Contracts between the setup wizard, its scenes and the app: what a scene
 * may ask of the host (saving settings, signing in, model discovery) and
 * how it reports that it is finished.
 */
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { Accessor, JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import type { ModelBrowserSource } from "../../modes/view-model/overlays/model-browser";

/** How a scene ended: its choice was saved, or the user moved on without one. */
export type SceneResult = "done" | "skipped";

/** Symbol sets a terminal can render. */
export type GlyphPreset = "nerd" | "unicode" | "ascii";

/** A whole UI look: a theme (`auto` follows the terminal's appearance), its glyphs and color adjustment. */
export interface ThemeLook {
	readonly theme: string;
	readonly symbols: GlyphPreset;
	readonly colorBlind: boolean;
}

/** The models the host knows: the setup model scene lists the chat models of `available`; role chips resolve over `all`. */
export interface HostModels {
	readonly available: readonly Model[];
	readonly all: readonly Model[];
	readonly current?: Model;
}

/** What scenes read from and ask of the app. Saves are fire-and-forget unless they return a promise. */
export interface SetupHost {
	/** Configured values the scenes start from. */
	readonly composerShape: string;
	readonly symbolPreset: GlyphPreset;
	readonly colorBlindMode: boolean;
	/** Name of the theme in use when setup started. */
	readonly themeName: string;
	readonly autoUpdate: boolean;
	readonly disabledProviders: readonly string[];
	readonly authStorage: AuthStorage;
	/** Agent directory (custom themes live under it). */
	readonly agentDir?: string;

	/** Apply a glyph preset for the whole UI without saving it (null: back to the configured one). */
	previewSymbolPreset?(preset: GlyphPreset | null): void;
	saveSymbolPreset(preset: GlyphPreset): void;
	saveComposerShape(shape: string): Promise<void> | void;
	saveAutoUpdate(enabled: boolean): Promise<void> | void;
	/** Show a look across the whole UI without saving it (null: back to the one setup started with). */
	previewTheme?(look: ThemeLook | null): Promise<void> | void;
	/** Make a look the session's (after its settings were saved). */
	applyTheme?(look: ThemeLook): Promise<void> | void;
	/** Save the theme used in dark or light terminals. */
	saveTheme(slot: "dark" | "light", name: string): void;
	saveColorBlindMode(enabled: boolean): void;
	/** Every theme the user may pick (built-in and custom). */
	listThemes?(): Promise<readonly string[]>;

	/** Preferences the model list ranks and labels rows by (roles, recency, provider order). */
	readonly modelSource: ModelBrowserSource;
	getModels(): HostModels;
	refreshModels(): Promise<void>;
	selectModel(model: Model, selector: string): Promise<void>;
	refreshProvider?(provider: string): Promise<void> | void;
	openInBrowser?(url: string): void;
}

/** What a mounted scene gets from the wizard. */
export interface SceneContext {
	readonly host: SetupHost;
	/** End the scene; the wizard moves on. */
	finish(result: SceneResult): void;
	/** Body rows the wizard can give the scene (undefined: unbounded). */
	readonly maxLines: Accessor<number | undefined>;
}

/** A mounted scene: its body, plus hooks the wizard calls. */
export interface SceneView {
	readonly body: JSXNode;
	/** The node inside the mounted body that takes keyboard focus (default: the body). */
	focusTarget?(body: UiNode): UiNode | undefined;
	/** The mouse wheel over the scene (rows; negative is up). Without it the wheel sends arrow keys. */
	wheel?(delta: number): void;
	/** The scene became visible (start discovery, …). */
	onMount?(): void;
	dispose?(): void;
}

/** One onboarding step. */
export interface SetupScene {
	/** Native id of the scene body (`body:<id>`). */
	readonly id: string;
	readonly title: string;
	readonly subtitle: string;
	/** Short name in the step strip. */
	readonly step: string;
	/** Setup version that introduced the scene (re-run when it is newer than the user's). */
	readonly minVersion: number;
	mount(context: SceneContext): SceneView;
}

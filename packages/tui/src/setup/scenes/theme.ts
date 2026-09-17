import { padding, truncateToWidth, visibleWidth } from "../../utils";
import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Container } from "../../tui";
import {
	enableAutoTheme,
	getAvailableThemes,
	getCurrentThemeName,
	getSelectListTheme,
	isLightTheme,
	previewTheme,
	type SymbolPreset,
	setColorBlindMode,
	setSymbolPreset,
	theme,
} from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

type ThemeMode = "curated" | "all";

const CURATED_ITEMS: readonly SelectItem[] = [
	{ value: "auto", label: "Match terminal", description: "Titanium in dark terminals, Light in light terminals" },
	{ value: "theme:titanium", label: "Titanium", description: "Default dark theme" },
	{ value: "theme:light", label: "Light", description: "Default light theme" },
	{ value: "colorblind", label: "Colorblind colors", description: "Adjust red/green contrast" },
	{ value: "ansi", label: "ANSI-safe", description: "ASCII glyphs with the dark terminal theme" },
	{ value: "browse", label: "Browse all…", description: "Show every built-in and custom theme" },
];

function fitLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function fillStyledLine(content: string, width: number): string {
	return content + padding(Math.max(0, width - visibleWidth(content)));
}

function renderMockStatusLine(width: number): string {
	const sep = theme.fg("statusLineSep", ` ${theme.sep.pipe} `);
	const left = [
		theme.fg("statusLineModel", `${theme.icon.model} sonnet`),
		theme.fg("statusLinePath", "~/project"),
		theme.fg("statusLineGitDirty", `${theme.icon.git} main +2`),
	].join(sep);
	const right = [
		theme.fg("statusLineContext", `${theme.icon.context} 42%`),
		theme.fg("statusLineCost", `${theme.icon.cost} 0.18`),
	].join(sep);
	const innerWidth = Math.max(1, width - 2);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = padding(Math.max(1, innerWidth - leftWidth - rightWidth - 2));
	return theme.bg("statusLineBg", fitLine(` ${left}${gap}${right} `, width));
}

function renderMockEditor(width: number): string[] {
	const box = theme.boxRound;
	const innerWidth = Math.max(1, width - 2);
	const horizontal = box.horizontal.repeat(innerWidth);
	const top = theme.fg("borderAccent", `${box.topLeft}${horizontal}${box.topRight}`);
	const bottom = theme.fg("borderMuted", `${box.bottomLeft}${horizontal}${box.bottomRight}`);
	const prompt = `${theme.fg("accent", ">")} ${theme.fg("text", "Ask anything, edit files, run tools")}${theme.inverse(" ")}`;
	const hint = theme.fg("dim", "enter send · shift+enter newline · / commands");
	return [
		top,
		`${theme.fg("borderAccent", box.vertical)}${fitLine(prompt, innerWidth)}${theme.fg("borderAccent", box.vertical)}`,
		`${theme.fg("borderMuted", box.vertical)}${fillStyledLine(hint, innerWidth)}${theme.fg("borderMuted", box.vertical)}`,
		bottom,
	];
}

function renderThemePreview(width: number): string[] {
	const previewWidth = Math.max(24, Math.min(width, 88));
	return [
		theme.bold("Preview"),
		`${theme.fg("success", `${theme.status.success} success`)}  ${theme.fg("warning", `${theme.status.warning} warning`)}  ${theme.fg("error", `${theme.status.error} error`)}  ${theme.fg("accent", "accent")}`,
		"",
		theme.fg("muted", "Status line"),
		renderMockStatusLine(previewWidth),
		theme.fg("muted", "Editor"),
		...renderMockEditor(previewWidth),
	];
}

class ThemeSceneController implements SetupSceneController {
	title = "Pick a theme";
	subtitle = "Move through the list to preview; Enter saves the highlighted choice.";
	#mode: ThemeMode = "curated";
	#selectList: SelectList;
	#loadingAllThemes = false;
	#message: string | undefined;
	#previewRequest = 0;
	#disposed = false;
	#step: WizardStep | undefined;
	readonly #originalTheme = getCurrentThemeName();
	readonly #originalSymbolPreset: SymbolPreset;
	readonly #originalColorBlindMode: boolean;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#originalSymbolPreset = host.ctx.symbolPreset;
		this.#originalColorBlindMode = host.ctx.colorBlindMode;
		this.#selectList = this.#createSelectList(CURATED_ITEMS, this.#currentCuratedIndex());
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#step?.invalidate();
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		const quickIndex = data >= "1" && data <= "9" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#previewByIndex(quickIndex);
			return;
		}
		this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#loadingAllThemes) {
			this.#selectList.routeMouse(event, Number.NEGATIVE_INFINITY, col);
			return;
		}
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const intro = new Container();
		intro.addChild(
			new Text(theme.fg("muted", "Theme changes preview live. Nothing is saved until you press Enter."), 0, 0),
		);
		intro.addChild(
			new Text(
				this.#mode === "all"
					? theme.fg("dim", "Browsing all themes · Esc returns to curated choices")
					: theme.fg("dim", "Esc skips this step"),
				0,
				0,
			),
		);
		// The mock status-line/editor block is decorative — the wizard itself
		// re-renders in the highlighted theme — so it yields to the list when
		// it would squeeze the window below the six curated rows (+1 for the
		// list's own search-status row).
		const preview = new Container();
		for (const line of renderThemePreview(width)) {
			preview.addChild(new Text(line, 0, 0));
		}
		const loading = this.#loadingAllThemes ? new Text(theme.fg("dim", "Loading themes…"), 0, 0) : undefined;
		const status = this.#message ? new Text(this.#message, 0, 0) : undefined;
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: loading ? "async" : "choice",
				intro,
				preview: { component: preview, optional: true },
				content: loading ?? this.#selectList,
				status,
				minContentLines: CURATED_ITEMS.length + 1,
				fitContent: budget => {
					if (this.#loadingAllThemes) return;
					const visible = budget === undefined ? 10 : budget - 1;
					this.#selectList.setMaxVisible(Math.max(1, Math.min(10, visible)));
				},
			});
		} else {
			this.#step.setKind(loading ? "async" : "choice");
			this.#step.setIntro(intro);
			this.#step.setPreview({ component: preview, optional: true });
			this.#step.setContent(loading ?? this.#selectList);
			this.#step.setStatus(status);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	#createSelectList(items: readonly SelectItem[], selectedIndex: number): SelectList {
		const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), getSelectListTheme());
		list.setSelectedIndex(selectedIndex);
		list.onSelectionChange = item => {
			void this.#preview(item.value);
		};
		list.onSelect = item => {
			void this.#select(item.value);
		};
		list.onCancel = () => {
			if (this.#mode === "all") {
				this.#mode = "curated";
				this.#selectList = this.#createSelectList(CURATED_ITEMS, this.#currentCuratedIndex());
				this.#host.requestRender();
				return;
			}
			this.#restorePreview();
			this.#host.finish("skipped");
		};
		return list;
	}

	#currentCuratedIndex(): number {
		const current = getCurrentThemeName();
		if (current === "titanium") return 1;
		if (current === "light") return 2;
		return 0;
	}

	#previewByIndex(index: number): void {
		const items = this.#mode === "curated" ? CURATED_ITEMS : undefined;
		const value = items?.[index]?.value;
		if (value) void this.#preview(value);
	}

	async #select(value: string): Promise<void> {
		if (value === "browse") {
			await this.#showAllThemes();
			return;
		}
		await this.#commit(value);
		this.#host.finish("done");
	}

	async #showAllThemes(): Promise<void> {
		if (this.#loadingAllThemes) return;
		this.#loadingAllThemes = true;
		this.#message = undefined;
		this.#host.requestRender();
		try {
			const themes = await getAvailableThemes();
			if (this.#disposed) return;
			const items = themes.map(name => ({
				value: `theme:${name}`,
				label: name,
				description: name === this.#originalTheme ? "current" : undefined,
			}));
			const selectedIndex = Math.max(0, themes.indexOf(this.#originalTheme ?? ""));
			this.#mode = "all";
			this.#selectList = this.#createSelectList(items, selectedIndex);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#message = theme.fg("error", `Failed to load themes: ${message}`);
		} finally {
			this.#loadingAllThemes = false;
			this.#host.requestRender();
		}
	}

	async #commit(value: string): Promise<void> {
		if (value === "auto") {
			this.#host.ctx.saveTheme("dark", "titanium");
			this.#host.ctx.saveTheme("light", "light");
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
			enableAutoTheme();
			return;
		}
		if (value === "colorblind") {
			this.#host.ctx.saveColorBlindMode(true);
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, true);
			return;
		}
		if (value === "ansi") {
			this.#host.ctx.saveSymbolPreset("ascii");
			this.#host.ctx.saveTheme("dark", "dark-terminal");
			await this.#applyPreviewPresentation("ascii", this.#originalColorBlindMode);
			enableAutoTheme();
			return;
		}
		const themeName = this.#themeNameFromValue(value);
		if (!themeName) return;
		await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
		if (isLightTheme(themeName)) {
			this.#host.ctx.saveTheme("light", themeName);
		} else {
			this.#host.ctx.saveTheme("dark", themeName);
		}
		await previewTheme(themeName, { ephemeral: false });
	}

	async #preview(value: string): Promise<void> {
		const request = ++this.#previewRequest;
		this.#message = undefined;
		if (value === "browse") {
			this.#host.requestRender();
			return;
		}

		let result: { success: boolean; error?: string } = { success: true };
		if (value === "auto") {
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
			enableAutoTheme({ ephemeral: true });
		} else if (value === "colorblind") {
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, true);
		} else if (value === "ansi") {
			await this.#applyPreviewPresentation("ascii", this.#originalColorBlindMode);
			result = await previewTheme("dark-terminal");
		} else {
			const themeName = this.#themeNameFromValue(value);
			if (themeName) {
				await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
				result = await previewTheme(themeName);
			}
		}
		if (request !== this.#previewRequest || this.#disposed) return;
		if (!result.success) {
			this.#message = theme.fg("error", result.error ?? "Theme preview failed");
		}
		this.#host.ctx.ui.invalidate();
		this.#host.requestRender();
	}

	async #applyPreviewPresentation(symbolPreset: SymbolPreset, colorBlindMode: boolean): Promise<void> {
		await setSymbolPreset(symbolPreset);
		await setColorBlindMode(colorBlindMode);
	}

	#restorePreview(): void {
		void (async () => {
			await this.#applyPreviewPresentation(this.#originalSymbolPreset, this.#originalColorBlindMode);
			if (this.#originalTheme) {
				await previewTheme(this.#originalTheme);
			}
			this.#host.ctx.ui.invalidate();
			this.#host.requestRender();
		})();
	}

	#themeNameFromValue(value: string): string | undefined {
		return value.startsWith("theme:") ? value.slice("theme:".length) : undefined;
	}
}

/** Preview and persist the terminal color theme. */
export const themeSetupScene: SetupScene = {
	id: "theme",
	title: "Pick a theme",
	minVersion: 1,
	mount: host => new ThemeSceneController(host),
};

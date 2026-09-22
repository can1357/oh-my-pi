import { type SgrMouseEvent } from "../../mouse";
import { TERMINAL } from "../../terminal-capabilities";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { getSelectListTheme, type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const GLYPH_PRESETS = ["nerd", "unicode", "ascii"] as const satisfies readonly SymbolPreset[];

const GLYPH_LABELS: Readonly<Record<SymbolPreset, string>> = {
	nerd: "Nerd Font",
	unicode: "Unicode",
	ascii: "ASCII",
};

const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	nerd: "      󰉋  ",
	unicode: "✔  ✖  📁  ⬢  ╭─╮  ├─  •  ⠋  →",
	ascii: "[ok]  [x]  >  +  [D]  +-+  |--  *  ->",
};

/** One picker row per preset; the description column shows live sample glyphs instead of prose. */
const GLYPH_ITEMS: readonly SelectItem[] = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: preset === "nerd" ? `${GLYPH_SAMPLES.nerd}  ╭─╮  ├─  ◆  ✔  ✖` : GLYPH_SAMPLES[preset],
}));

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the row that renders cleanly in your terminal.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	#step: WizardStep | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#selectList = new SelectList(GLYPH_ITEMS, GLYPH_ITEMS.length, getSelectListTheme());
		const current = theme.getSymbolPreset();
		const currentIndex = GLYPH_PRESETS.indexOf(current);
		this.#selectList.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value as SymbolPreset);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value as SymbolPreset);
		};
		this.#selectList.onCancel = () => host.finish("skipped");
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data >= "1" && data <= "3" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			const preset = GLYPH_PRESETS[quickIndex];
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(preset);
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#committing) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro: new Text(theme.fg("muted", "If a row shows boxes, tofu, or misaligned icons, pick another."), 0, 0),
				content: this.#selectList,
				minContentLines: GLYPH_ITEMS.length,
				fitContent: () => {
					this.#selectList.setMaxVisible(GLYPH_ITEMS.length);
				},
			});
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	async #commit(preset: SymbolPreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		this.#host.ctx.saveSymbolPreset(preset);
		await setSymbolPreset(preset);
		this.#host.ctx.ui.invalidate();
		this.#host.finish("done");
	}

	#preview(preset: SymbolPreset): void {
		const request = ++this.#previewRequest;
		void setSymbolPreset(preset).then(() => {
			if (request !== this.#previewRequest || this.#committing) return;
			this.#host.ctx.ui.invalidate();
			this.#host.requestRender();
		});
	}
}

/**
 * Preview and persist the terminal glyph preset. Skipped once the Glyph
 * Protocol handshake confirmed the terminal renders omp's bundled icons: every
 * row renders cleanly there, and the default `unicode` preset already upgrades
 * to nerd at runtime while staying safe on terminals without the protocol.
 */
export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	minVersion: 1,
	shouldRun: () => !TERMINAL.glyphProtocol,
	mount: host => new GlyphSceneController(host),
};

import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
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
	/** Render line where the select list begins. */
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
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
		this.#selectList.invalidate();
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
		this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#committing) return;
		routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number): readonly string[] {
		const lines = [theme.fg("muted", "If a row shows boxes, tofu, or misaligned icons, pick another."), ""];
		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #commit(preset: SymbolPreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		this.host.ctx.settings.set("symbolPreset", preset);
		await setSymbolPreset(preset);
		this.host.ctx.ui.invalidate();
		this.host.finish("done");
	}

	#preview(preset: SymbolPreset): void {
		const request = ++this.#previewRequest;
		void setSymbolPreset(preset).then(() => {
			if (request !== this.#previewRequest || this.#committing) return;
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
	}
}

export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	minVersion: 1,
	mount: host => new GlyphSceneController(host),
};

/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Glyph mode: pick the symbol preset whose sample row renders cleanly. The
 * highlighted preset previews across the whole UI; Enter saves it.
 */
import "../../styles/setup";
import type { GlyphPreset, SetupScene } from "../types";
import { type Choice, ChoiceList, ChoiceModel } from "./choice";

const NERD_SAMPLE = "\uf00c \ue0b0 \uec19 \u{f024b} \ue725";

const GLYPH_CHOICES: readonly Choice<GlyphPreset>[] = [
	{ value: "nerd", label: "1 Nerd Font", detail: `${NERD_SAMPLE} ╭─╮ ├─ ◆ ✓ ✗` },
	{ value: "unicode", label: "2 Unicode", detail: "✔️ ✖️ 📁 ⬢ ╭─╮ ├─ • ⠋ →" },
	{ value: "ascii", label: "3 ASCII", detail: "[+] [-] > + [D] +-+ |- * ->" },
];

export const glyphScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	subtitle: "Pick the row that renders cleanly in your terminal.",
	step: "Symbols",
	minVersion: 1,
	mount(context) {
		const host = context.host;
		const model = new ChoiceModel<GlyphPreset>({
			context,
			choices: GLYPH_CHOICES,
			initial: host.symbolPreset,
			preview: preset => host.previewSymbolPreset?.(preset),
			commit: preset => host.saveSymbolPreset(preset),
		});
		return {
			body: (
				<col
					role="omp.setup.glyph"
					gap="sm"
					term={() => ({ maxLines: context.maxLines() })}
					onKey={key => model.key(key)}
				>
					<text spans={[{ s: "muted", t: "If a row shows boxes, tofu, or misaligned icons, pick another." }]} />
					<ChoiceList model={model} />
				</col>
			),
			wheel: delta => model.move(delta, false),
		};
	},
};
